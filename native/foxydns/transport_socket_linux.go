//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"runtime"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const helperSocketGID uint32 = 65533

// Only the upstream socket is created with file credential GID 65533. The
// original thread group is restored before any bind/connect/route work. Go's
// explicit tcp4/6 or udp4/6 literal path is serial; Control verifies this rather
// than trusting it. The isolated goroutine never returns a changed thread to
// the runtime, even when a credential-restoration syscall fails.
func dialHelperSocket(ctx context.Context, dialer net.Dialer, network, address string) (net.Conn, error) {
	if network != "udp4" && network != "udp6" && network != "tcp4" && network != "tcp6" {
		return nil, errors.New("helper socket requires an explicit address family")
	}
	if _, err := netip.ParseAddrPort(address); err != nil {
		return nil, errors.New("helper socket requires a literal destination")
	}
	dialer.SetMultipathTCP(false)
	type result struct {
		connection net.Conn
		err        error
	}
	results := make(chan result)
	go func() {
		value := func() (out result) {
			runtime.LockOSThread()
			thread := unix.Gettid()
			original, err := unix.SetfsgidRetGid(-1)
			if err != nil {
				runtime.UnlockOSThread()
				return result{err: err}
			}
			restored := false
			restore := func() error {
				restored = false
				if unix.Gettid() != thread {
					return errors.New("socket creation changed OS thread")
				}
				if _, err := unix.SetfsgidRetGid(original); err != nil {
					return err
				}
				actual, err := unix.SetfsgidRetGid(-1)
				if err != nil || actual != original {
					return errors.New("could not restore socket thread fsgid")
				}
				restored = true
				return nil
			}
			defer func() {
				if err := restore(); err != nil {
					if out.connection != nil {
						_ = out.connection.Close()
						out.connection = nil
					}
					out.err = fmt.Errorf("socket credential restoration: %w", err)
				}
				if restored {
					runtime.UnlockOSThread()
				}
				// If restoration failed, exiting this locked goroutine retires
				// the OS thread. Do not release altered credentials to the pool.
			}()
			if _, err = unix.SetfsgidRetGid(int(helperSocketGID)); err != nil {
				return result{err: err}
			}
			actual, err := unix.SetfsgidRetGid(-1)
			if err != nil || actual != int(helperSocketGID) {
				return result{err: errors.New("temporary socket group capability unavailable")}
			}
			control := dialer.ControlContext
			dialer.ControlContext = func(ctx context.Context, network, address string, raw syscall.RawConn) error {
				before, err := unix.SetfsgidRetGid(-1)
				if err != nil {
					return err
				}
				// This must be the first action before route/control operations.
				if err := restore(); err != nil {
					return err
				}
				if before != int(helperSocketGID) {
					return errors.New("socket retry lost isolated file credentials")
				}
				var credentialErr error
				if err := raw.Control(func(fd uintptr) {
					var stat unix.Stat_t
					if err := unix.Fstat(int(fd), &stat); err != nil {
						credentialErr = err
						return
					}
					if stat.Uid != 0 || stat.Gid != helperSocketGID {
						credentialErr = errors.New("upstream socket file credentials were not isolated")
					}
				}); err != nil {
					return err
				}
				if credentialErr != nil {
					return credentialErr
				}
				if control != nil {
					return control(ctx, network, address, raw)
				}
				return nil
			}
			connection, err := dialer.DialContext(ctx, network, address)
			return result{connection, err}
		}()
		select {
		case results <- value:
		case <-ctx.Done():
			if value.connection != nil {
				_ = value.connection.Close()
			}
		}
	}()
	select {
	case value := <-results:
		return value.connection, value.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// socketProbeFamily is replaceable in tests; production always uses
// probeHelperSocketFamily.
var socketProbeFamily = probeHelperSocketFamily

// probeHelperSocketContext requires only the IPv4 protocols: IPv6-less
// kernels still support full IPv4 interception. IPv6 is probed best-effort
// and reported separately.
func probeHelperSocketContext() (bool, error) {
	if err := socketProbeFamily("udp4", "tcp4"); err != nil {
		return false, err
	}
	return socketProbeFamily("udp6", "tcp6") == nil, nil
}

// Real loopback sockets prove INET_DIAG's UID is sk_uid after fchown, while the
// socket's creation credentials use the private group needed by NFQUEUE/owner.
func probeHelperSocketFamily(networks ...string) error {
	var controlMu sync.Mutex
	verified := 0
	for _, network := range networks {
		var listener net.Listener
		host := "127.0.0.1"
		if network[len(network)-1] == '6' {
			host = "::1"
		}
		address := net.JoinHostPort(host, "9")
		if network[:3] == "tcp" {
			var err error
			listener, err = net.Listen(network, net.JoinHostPort(host, "0"))
			if err != nil {
				return err
			}
			address = listener.Addr().String()
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		dialer := net.Dialer{ControlContext: func(_ context.Context, _, _ string, raw syscall.RawConn) error {
			var socketErr error
			if err := raw.Control(func(fd uintptr) {
				group, err := unix.SetfsgidRetGid(-1)
				if err != nil || group == int(helperSocketGID) {
					socketErr = errors.New("file group was not restored before Control")
					return
				}
				socketErr = setSocketContext(int(fd), 65534, 0x1234, "lo")
				if socketErr == nil {
					controlMu.Lock()
					verified++
					controlMu.Unlock()
				}
			}); err != nil {
				return err
			}
			return socketErr
		}}
		connection, err := dialHelperSocket(ctx, dialer, network, address)
		cancel()
		if err != nil {
			if listener != nil {
				_ = listener.Close()
			}
			return fmt.Errorf("isolated socket capability: %w", err)
		}
		local, err := addressPort(connection.LocalAddr())
		remote, remoteErr := addressPort(connection.RemoteAddr())
		protocol, _ := networkProtocol(network)
		identity, identityErr := connectedSocket(flowTuple{local, remote, protocol})
		_ = connection.Close()
		if listener != nil {
			_ = listener.Close()
		}
		if err != nil || remoteErr != nil || identityErr != nil || identity.UID != 65534 {
			return fmt.Errorf("INET_DIAG cannot verify isolated socket UID: %v", identityErr)
		}
	}
	if verified != len(networks) {
		return fmt.Errorf("UDP/TCP socket isolation probe incomplete for %v", networks)
	}
	return nil
}

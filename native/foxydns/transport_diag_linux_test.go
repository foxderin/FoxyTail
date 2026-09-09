//go:build linux

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"runtime"
	"syscall"
	"testing"
	"time"

	"github.com/mdlayher/netlink"
	"golang.org/x/sys/unix"
)

func TestSocketDiagUsesConnectedFullTupleAndKernelFilter(t *testing.T) {
	for _, source := range []string{"192.0.2.2:42000", "[2001:db8::2]:42000"} {
		src := netip.MustParseAddrPort(source)
		dst := netip.MustParseAddrPort("192.0.2.53:53")
		if src.Addr().Is6() {
			dst = netip.MustParseAddrPort("[2001:db8::53]:53")
		}
		tuple := flowTuple{src, dst, 17}
		message, err := socketDiagRequest(tuple)
		if err != nil {
			t.Fatal(err)
		}
		message.Header.Sequence = 1
		wire, err := message.MarshalBinary()
		if err != nil || len(wire) != 16+len(message.Data) || len(wire)%4 != 0 {
			t.Fatalf("raw socket-diag request is not a valid wire message: %d / %v", len(wire), err)
		}
		var decoded netlink.Message
		if err = decoded.UnmarshalBinary(wire); err != nil || decoded.Header.Length != uint32(len(wire)) || decoded.Header.Sequence != 1 {
			t.Fatalf("raw socket-diag wire header did not round-trip: %+v / %v", decoded.Header, err)
		}
		if message.Header.Flags&netlink.Dump != netlink.Dump || binary.NativeEndian.Uint32(message.Data[4:8]) != 1<<1 {
			t.Fatal("socket lookup must inspect all matching connected UDP sockets")
		}
		if binary.BigEndian.Uint16(message.Data[8:10]) != 42000 || binary.BigEndian.Uint16(message.Data[10:12]) != 53 {
			t.Fatal("socket lookup lost ports")
		}
		attrs, err := netlink.UnmarshalAttributes(message.Data[56:])
		if err != nil || len(attrs) != 1 || attrs[0].Type != 1 {
			t.Fatal("full tuple kernel bytecode filter required")
		}
		program := attrs[0].Data
		width := src.Addr().BitLen() / 8
		size := 12 + width
		if len(program) != 2*size || program[0] != 7 || program[size] != 8 || binary.NativeEndian.Uint32(program[8:12]) != 42000 || binary.NativeEndian.Uint32(program[size+8:size+12]) != 53 {
			t.Fatal("source/destination host filters not encoded correctly")
		}
	}
}

func TestSocketDiagRejectsWrongOrUnconnectedTuple(t *testing.T) {
	tuple := flowTuple{netip.MustParseAddrPort("192.0.2.2:42000"), netip.MustParseAddrPort("192.0.2.53:53"), 17}
	data := make([]byte, 72)
	data[0], data[1] = unix.AF_INET, 1
	binary.BigEndian.PutUint16(data[4:6], 42000)
	binary.BigEndian.PutUint16(data[6:8], 53)
	copy(data[8:12], tuple.source.Addr().AsSlice())
	copy(data[24:28], tuple.destination.Addr().AsSlice())
	binary.NativeEndian.PutUint64(data[44:52], 123)
	binary.NativeEndian.PutUint32(data[64:68], 10123)
	binary.NativeEndian.PutUint32(data[68:72], 456)
	identity, err := decodeSocketIdentity(data, tuple)
	if err != nil || identity.UID != 10123 {
		t.Fatalf("diagnosed sk_uid lost: %+v/%v", identity, err)
	}
	data[1] = 7
	if _, err = decodeSocketIdentity(data, tuple); !errors.Is(err, ErrSocketNotFound) {
		t.Fatal("unconnected UDP must not be used")
	}
	data[1] = 31
	if _, err = decodeSocketIdentity(data, flowTuple{tuple.source, tuple.destination, 6}); !errors.Is(err, ErrSocketNotFound) {
		t.Fatal("unknown TCP state must not identify a socket")
	}
	data[1] = 1
	data[27]++
	if _, err = decodeSocketIdentity(data, tuple); err == nil {
		t.Fatal("source port alone must never identify a socket")
	}
}

func TestPrivilegedDNSIsolatedSocketUID(t *testing.T) {
	requireDNSNamespace(t)
	kernelCommand(t, "ip", "link", "set", "lo", "up")
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	before, err := unix.SetfsgidRetGid(-1)
	if err != nil {
		t.Fatal(err)
	}
	if err := probeHelperSocketContext(); err != nil {
		t.Fatal(err)
	}
	after, err := unix.SetfsgidRetGid(-1)
	if err != nil || before != after {
		t.Fatal("helper socket creation changed caller thread credentials")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if conn, err := dialHelperSocket(ctx, net.Dialer{}, "udp4", "127.0.0.1:9"); err == nil {
		conn.Close()
		t.Fatal("canceled helper socket creation succeeded")
	}
	after, err = unix.SetfsgidRetGid(-1)
	if err != nil || before != after {
		t.Fatal("cancellation changed caller credentials")
	}
}

func TestPrivilegedDNSSocketTupleAmbiguity(t *testing.T) {
	requireDNSNamespace(t)
	kernelCommand(t, "ip", "link", "set", "lo", "up")
	create := func(port int) net.Conn {
		t.Helper()
		dialer := net.Dialer{Timeout: time.Second, LocalAddr: &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: port}, Control: func(_, _ string, raw syscall.RawConn) error {
			var opErr error
			if err := raw.Control(func(fd uintptr) {
				if opErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEADDR, 1); opErr != nil {
					return
				}
				if opErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1); opErr != nil {
					return
				}
				opErr = unix.Fchown(int(fd), 10123, -1)
			}); err != nil {
				return err
			}
			return opErr
		}}
		connection, err := dialer.Dial("udp4", "127.0.0.1:9")
		if err != nil {
			t.Fatal(err)
		}
		return connection
	}
	first := create(0)
	defer first.Close()
	source, _ := addressPort(first.LocalAddr())
	destination, _ := addressPort(first.RemoteAddr())
	tuple := flowTuple{source, destination, 17}
	second := create(int(source.Port()))
	defer second.Close()
	if _, err := connectedSocket(tuple); !errors.Is(err, ErrSocketAmbiguous) {
		t.Fatalf("SO_REUSE ambiguity was not rejected: %v", err)
	}
	second.Close()
	identity, err := connectedSocket(tuple)
	if err != nil || identity.UID != 10123 {
		t.Fatalf("unique netd-like socket identity lost: %+v/%v", identity, err)
	}
	unconnected, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer unconnected.Close()
	local, _ := addressPort(unconnected.LocalAddr())
	if _, err := connectedSocket(flowTuple{local, destination, 17}); !errors.Is(err, ErrSocketNotFound) {
		t.Fatalf("unconnected UDP was guessed from source: %v", err)
	}
}

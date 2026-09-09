//go:build linux

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"time"

	"github.com/mdlayher/netlink"
	"golang.org/x/sys/unix"
)

var (
	ErrSocketNotFound  = errors.New("original connected socket was not found")
	ErrSocketAmbiguous = errors.New("original socket tuple is ambiguous")
)

type socketIdentity struct {
	UID    uint32
	Cookie uint64
	Inode  uint32
}

// A single INET_DIAG GET may return one arbitrary SO_REUSEPORT socket. Use a
// kernel-filtered dump, require exactly one full tuple, and bound receive time,
// bytes and matching sockets. No process scan or source-port-only inference.
func connectedSocket(tuple flowTuple) (socketIdentity, error) {
	request, err := socketDiagRequest(tuple)
	if err != nil {
		return socketIdentity{}, err
	}
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_RAW|unix.SOCK_CLOEXEC, unix.NETLINK_SOCK_DIAG)
	if err != nil {
		return socketIdentity{}, err
	}
	defer unix.Close(fd)
	timeout := unix.Timeval{Usec: 100000}
	if err = unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &timeout); err != nil {
		return socketIdentity{}, err
	}
	if err = unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_SNDTIMEO, &timeout); err != nil {
		return socketIdentity{}, err
	}
	if err = unix.Bind(fd, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return socketIdentity{}, err
	}
	request.Header.Sequence = 1
	wire, err := request.MarshalBinary()
	if err != nil {
		return socketIdentity{}, err
	}
	if err = unix.Sendto(fd, wire, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return socketIdentity{}, err
	}
	buffer := make([]byte, 65536)
	var found socketIdentity
	count, received := 0, 0
	deadline := time.Now().Add(150 * time.Millisecond)
	for received < 256<<10 && time.Now().Before(deadline) {
		n, _, flags, sender, err := unix.Recvmsg(fd, buffer, nil, 0)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return socketIdentity{}, fmt.Errorf("socket diag receive: %w", err)
		}
		peer, ok := sender.(*unix.SockaddrNetlink)
		if !ok || peer.Pid != 0 || flags&unix.MSG_TRUNC != 0 {
			return socketIdentity{}, errors.New("untrusted or truncated socket diag reply")
		}
		received += n
		for offset := 0; offset < n; {
			if n-offset < 16 {
				return socketIdentity{}, errors.New("truncated socket diag header")
			}
			length := int(binary.NativeEndian.Uint32(buffer[offset : offset+4]))
			if length < 16 || length > n-offset {
				return socketIdentity{}, errors.New("invalid socket diag message length")
			}
			var message netlink.Message
			if err = message.UnmarshalBinary(buffer[offset : offset+length]); err != nil {
				return socketIdentity{}, err
			}
			if message.Header.Sequence != 1 || message.Header.Flags&netlink.DumpInterrupted != 0 {
				return socketIdentity{}, errors.New("socket diag dump interrupted")
			}
			switch message.Header.Type {
			case netlink.Done:
				if len(message.Data) >= 4 && int32(binary.NativeEndian.Uint32(message.Data[:4])) != 0 {
					return socketIdentity{}, errors.New("socket diag dump failed")
				}
				if count != 1 {
					return socketIdentity{}, ErrSocketNotFound
				}
				return found, nil
			case netlink.Error:
				if len(message.Data) < 4 {
					return socketIdentity{}, errors.New("invalid socket diag error")
				}
				code := int32(binary.NativeEndian.Uint32(message.Data[:4]))
				if code != 0 {
					return socketIdentity{}, unix.Errno(-code)
				}
			case unix.SOCK_DIAG_BY_FAMILY:
				identity, err := decodeSocketIdentity(message.Data, tuple)
				if err != nil {
					return socketIdentity{}, err
				}
				count++
				if count > 1 {
					return socketIdentity{}, ErrSocketAmbiguous
				}
				found = identity
			default:
				return socketIdentity{}, errors.New("unexpected socket diag response")
			}
			offset += (length + 3) &^ 3
		}
	}
	return socketIdentity{}, errors.New("socket diag receive budget exceeded")
}

func socketDiagRequest(tuple flowTuple) (netlink.Message, error) {
	family, width := byte(unix.AF_INET), 4
	if tuple.source.Addr().Is6() {
		family, width = unix.AF_INET6, 16
	}
	if !tuple.source.IsValid() || !tuple.destination.IsValid() || tuple.source.Addr().BitLen() != tuple.destination.Addr().BitLen() || (tuple.protocol != 6 && tuple.protocol != 17) {
		return netlink.Message{}, ErrFlowContext
	}
	data := make([]byte, 56)
	data[0], data[1] = family, tuple.protocol
	// Connected UDP is TCP_ESTABLISHED in inet_diag. TCP excludes listening,
	// timewait and closed/minisockets, which do not prove an originating fd.
	states := allowedSocketStates(tuple.protocol)
	binary.NativeEndian.PutUint32(data[4:8], states)
	binary.BigEndian.PutUint16(data[8:10], tuple.source.Port())
	binary.BigEndian.PutUint16(data[10:12], tuple.destination.Port())
	copy(data[12:12+width], tuple.source.Addr().AsSlice())
	copy(data[28:28+width], tuple.destination.Addr().AsSlice())
	binary.NativeEndian.PutUint32(data[48:52], ^uint32(0))
	binary.NativeEndian.PutUint32(data[52:56], ^uint32(0))
	// inet_diag bytecode host conditions compare complete address + port.
	// true advances to next op/end; false jumps four bytes beyond end (reject).
	opSize := 12 + width
	program := make([]byte, opSize*2)
	for n, endpoint := range []netip.AddrPort{tuple.source, tuple.destination} {
		offset := n * opSize
		program[offset], program[offset+1] = byte(7+n), byte(opSize) // S_COND/D_COND
		binary.NativeEndian.PutUint16(program[offset+2:offset+4], uint16(len(program)-offset+4))
		program[offset+4], program[offset+5] = family, byte(width*8)
		binary.NativeEndian.PutUint32(program[offset+8:offset+12], uint32(endpoint.Port()))
		copy(program[offset+12:offset+opSize], endpoint.Addr().AsSlice())
	}
	attributes, err := netlink.MarshalAttributes([]netlink.Attribute{{Type: 1, Data: program}}) // INET_DIAG_REQ_BYTECODE
	if err != nil {
		return netlink.Message{}, err
	}
	return netlink.Message{Header: netlink.Header{Type: unix.SOCK_DIAG_BY_FAMILY, Flags: netlink.Request | netlink.Dump}, Data: append(data, attributes...)}, nil
}

func decodeSocketIdentity(data []byte, tuple flowTuple) (socketIdentity, error) {
	if len(data) < 72 {
		return socketIdentity{}, errors.New("truncated socket identity")
	}
	family, width := byte(unix.AF_INET), 4
	if tuple.source.Addr().Is6() {
		family, width = unix.AF_INET6, 16
	}
	source, okSource := netip.AddrFromSlice(data[8 : 8+width])
	destination, okDestination := netip.AddrFromSlice(data[24 : 24+width])
	if data[0] != family || !okSource || !okDestination || source.Unmap() != tuple.source.Addr().Unmap() || destination.Unmap() != tuple.destination.Addr().Unmap() ||
		binary.BigEndian.Uint16(data[4:6]) != tuple.source.Port() || binary.BigEndian.Uint16(data[6:8]) != tuple.destination.Port() {
		return socketIdentity{}, errors.New("socket diag did not preserve exact tuple filter")
	}
	if data[1] >= 32 || allowedSocketStates(tuple.protocol)&(uint32(1)<<data[1]) == 0 {
		return socketIdentity{}, ErrSocketNotFound
	}
	identity := socketIdentity{UID: binary.NativeEndian.Uint32(data[64:68]), Cookie: binary.NativeEndian.Uint64(data[44:52]), Inode: binary.NativeEndian.Uint32(data[68:72])}
	if identity.Inode == 0 || identity.Cookie == 0 || identity.Cookie == ^uint64(0) {
		return socketIdentity{}, ErrSocketNotFound
	}
	return identity, nil
}

func socketDiagCapabilityFailure(err error) bool {
	return err != nil && !errors.Is(err, ErrSocketNotFound) && !errors.Is(err, ErrSocketAmbiguous) && !errors.Is(err, unix.ENOENT)
}

func allowedSocketStates(protocol uint8) uint32 {
	if protocol == 17 {
		return 1 << 1
	}
	if protocol == 6 {
		return 1<<1 | 1<<2 | 1<<3 | 1<<4 | 1<<5 | 1<<8 | 1<<9 | 1<<11
	}
	return 0
}

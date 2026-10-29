package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"time"
)

const captureMark uint32 = 0x20000000

var (
	ErrUnsupported = errors.New("transparent DNS requires Linux NFQUEUE and conntrack")
	ErrFlowContext = errors.New("original DNS network context unavailable")
)

// FlowContext is issued only after a kernel conntrack reply tuple has been
// matched to the original NFQUEUE observation. Addresses alone are insufficient:
// Android VPN routing also depends on the original socket UID and packet mark.
type FlowContext struct {
	OriginalSource      netip.AddrPort
	OriginalDestination netip.AddrPort
	UID                 uint32
	Mark                uint32
	OutIfIndex          int
	InterfaceName       string
	CapturedAt          time.Time
	protocol            uint8
	tos                 uint8
	checkSource         func(netip.AddrPort) error
	generation          uint64
	socketCookie        uint64
	socketInode         uint32
	validate            func() error
}

func (f FlowContext) Valid() bool { return f.check() == nil }

func (f FlowContext) check() error {
	if f.validate == nil || f.Mark&captureMark != 0 || f.OutIfIndex <= 0 ||
		f.InterfaceName == "" || !f.OriginalSource.IsValid() || !f.OriginalDestination.IsValid() ||
		f.OriginalDestination.Port() != 53 || (f.protocol != 6 && f.protocol != 17) {
		return ErrFlowContext
	}
	return f.validate()
}

type flowTuple struct {
	source      netip.AddrPort
	destination netip.AddrPort
	protocol    uint8
}

func networkProtocol(network string) (uint8, error) {
	switch network {
	case "udp", "udp4", "udp6":
		return 17, nil
	case "tcp", "tcp4", "tcp6":
		return 6, nil
	default:
		return 0, fmt.Errorf("unsupported DNS network %q", network)
	}
}

func addressPort(addr net.Addr) (netip.AddrPort, error) {
	var out netip.AddrPort
	switch a := addr.(type) {
	case *net.UDPAddr:
		out = a.AddrPort()
	case *net.TCPAddr:
		out = a.AddrPort()
	default:
		return out, fmt.Errorf("%w: unsupported local address", ErrFlowContext)
	}
	if !out.IsValid() || out.Addr().IsUnspecified() || out.Port() == 0 {
		return netip.AddrPort{}, fmt.Errorf("%w: actual destination address required", ErrFlowContext)
	}
	return netip.AddrPortFrom(out.Addr().Unmap().WithZone(""), out.Port()), nil
}

// packetTuple deliberately declines fragments, IPv6 extension headers and
// incomplete captures. Such packets retain their original path via NF_ACCEPT.
func packetTuple(packet []byte) (flowTuple, bool) {
	var t flowTuple
	var source, destination netip.Addr
	var offset, end int
	if len(packet) < 1 {
		return t, false
	}
	switch packet[0] >> 4 {
	case 4:
		if len(packet) < 20 || packet[0]&15 < 5 {
			return t, false
		}
		offset = int(packet[0]&15) * 4
		end = int(binary.BigEndian.Uint16(packet[2:4]))
		if end < offset || end > len(packet) || binary.BigEndian.Uint16(packet[6:8])&0x3fff != 0 {
			return t, false
		}
		source = netip.AddrFrom4([4]byte(packet[12:16]))
		destination = netip.AddrFrom4([4]byte(packet[16:20]))
		t.protocol = packet[9]
	case 6:
		if len(packet) < 40 || packet[1]&0x0f != 0 || packet[2] != 0 || packet[3] != 0 {
			return t, false
		}
		offset = 40
		end = 40 + int(binary.BigEndian.Uint16(packet[4:6]))
		if end > len(packet) || end == 40 {
			return t, false
		}
		source = netip.AddrFrom16([16]byte(packet[8:24]))
		destination = netip.AddrFrom16([16]byte(packet[24:40]))
		t.protocol = packet[6]
	default:
		return t, false
	}
	if !source.IsValid() || source.IsUnspecified() || source.IsMulticast() ||
		destination.IsUnspecified() || destination.IsMulticast() || destination.IsLoopback() {
		return t, false
	}
	switch t.protocol {
	case 17:
		if end-offset < 8 || int(binary.BigEndian.Uint16(packet[offset+4:offset+6])) != end-offset {
			return t, false
		}
	case 6:
		if end-offset < 20 || int(packet[offset+12]>>4)*4 < 20 || int(packet[offset+12]>>4)*4 > end-offset {
			return t, false
		}
	default:
		return t, false
	}
	sourcePort := binary.BigEndian.Uint16(packet[offset : offset+2])
	destinationPort := binary.BigEndian.Uint16(packet[offset+2 : offset+4])
	if sourcePort == 0 || destinationPort != 53 {
		return t, false
	}
	t.source = netip.AddrPortFrom(source, sourcePort)
	t.destination = netip.AddrPortFrom(destination, destinationPort)
	return t, true
}

// udpQueryPayload returns the flow tuple and the DNS payload of a UDP/53
// packet after the same sanity checks as packetTuple.
func udpQueryPayload(packet []byte) (flowTuple, []byte, bool) {
	tuple, ok := packetTuple(packet)
	if !ok || tuple.protocol != 17 {
		return flowTuple{}, nil, false
	}
	var offset, end int
	if packet[0]>>4 == 4 {
		offset, end = int(packet[0]&15)*4, int(binary.BigEndian.Uint16(packet[2:4]))
	} else {
		offset, end = 40, 40+int(binary.BigEndian.Uint16(packet[4:6]))
	}
	return tuple, packet[offset+8 : end], true
}

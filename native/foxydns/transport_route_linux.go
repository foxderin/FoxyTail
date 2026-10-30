//go:build linux

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"time"

	"github.com/mdlayher/netlink"
	"golang.org/x/sys/unix"
)

// Each lookup has its own strictly validated, short-lived socket. A timed-out
// reply cannot be mistaken for the next query, and no route cache can outlive a
// VPN/policy change. These requests query the FIB; they send no network packet.
func effectiveRoute(tuple flowTuple, uid, mark uint32, tos uint8) (int, error) {
	request, err := routeRequest(tuple, uid, mark, tos, false)
	if err != nil {
		return 0, err
	}
	messages, err := executeRoute(request)
	if err != nil {
		return 0, err
	}
	return routeInterface(messages, tuple, uid, mark)
}

func executeRoute(request netlink.Message) ([]netlink.Message, error) {
	conn, err := netlink.Dial(unix.NETLINK_ROUTE, &netlink.Config{Strict: true})
	if err != nil {
		return nil, fmt.Errorf("strict route-query capability: %w", err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(100 * time.Millisecond)); err != nil {
		return nil, err
	}
	return conn.Execute(request)
}

func routeRequest(tuple flowTuple, uid, mark uint32, tos uint8, malformedUID bool) (netlink.Message, error) {
	family, bits := byte(unix.AF_INET), byte(32)
	if tuple.source.Addr().Is6() {
		family, bits = unix.AF_INET6, 128
	}
	if !tuple.source.IsValid() || !tuple.destination.IsValid() || tuple.source.Addr().BitLen() != tuple.destination.Addr().BitLen() {
		return netlink.Message{}, ErrFlowContext
	}
	native32 := func(value uint32) []byte { p := make([]byte, 4); binary.NativeEndian.PutUint32(p, value); return p }
	port := func(value uint16) []byte { p := make([]byte, 2); binary.BigEndian.PutUint16(p, value); return p }
	uidData := native32(uid)
	if malformedUID {
		uidData = []byte{1}
	}
	attributes, err := netlink.MarshalAttributes([]netlink.Attribute{
		{Type: unix.RTA_SRC, Data: tuple.source.Addr().AsSlice()},
		{Type: unix.RTA_DST, Data: tuple.destination.Addr().AsSlice()},
		{Type: unix.RTA_UID, Data: uidData}, {Type: unix.RTA_MARK, Data: native32(mark)},
		{Type: unix.RTA_IP_PROTO, Data: []byte{tuple.protocol}},
		{Type: unix.RTA_SPORT, Data: port(tuple.source.Port())}, {Type: unix.RTA_DPORT, Data: port(tuple.destination.Port())},
	})
	if err != nil {
		return netlink.Message{}, err
	}
	data := make([]byte, 12, 12+len(attributes))
	data[0], data[1], data[2], data[3] = family, bits, bits, tos
	return netlink.Message{Header: netlink.Header{Type: unix.RTM_GETROUTE, Flags: netlink.Request}, Data: append(data, attributes...)}, nil
}

func routeInterface(messages []netlink.Message, tuple flowTuple, uid, mark uint32) (int, error) {
	if len(messages) != 1 || messages[0].Header.Type != unix.RTM_NEWROUTE || len(messages[0].Data) < 12 {
		return 0, errors.New("route lookup returned an incomplete result")
	}
	data := messages[0].Data
	family := byte(unix.AF_INET)
	if tuple.source.Addr().Is6() {
		family = unix.AF_INET6
	}
	if data[0] != family || (data[7] != unix.RTN_UNICAST && data[7] != unix.RTN_LOCAL) {
		return 0, errors.New("route lookup did not return an usable route")
	}
	attrs, err := netlink.UnmarshalAttributes(data[12:])
	if err != nil {
		return 0, err
	}
	var out int
	var gotUID, gotDestination bool
	var echoedMark uint32
	for _, attr := range attrs {
		switch attr.Type {
		case unix.RTA_OIF:
			if len(attr.Data) != 4 {
				return 0, errors.New("invalid route interface")
			}
			out = int(binary.NativeEndian.Uint32(attr.Data))
		case unix.RTA_UID:
			if len(attr.Data) != 4 || binary.NativeEndian.Uint32(attr.Data) != uid {
				return 0, errors.New("route UID was not preserved")
			}
			gotUID = true
		case unix.RTA_MARK:
			if len(attr.Data) != 4 {
				return 0, errors.New("invalid route mark")
			}
			echoedMark = binary.NativeEndian.Uint32(attr.Data)
		case unix.RTA_DST:
			addr, valid := netip.AddrFromSlice(attr.Data)
			if !valid || addr.Unmap() != tuple.destination.Addr().Unmap() {
				return 0, errors.New("route destination mismatch")
			}
			gotDestination = true
		}
	}
	if out <= 0 || !gotDestination {
		return 0, errors.New("route destination/interface unavailable")
	}
	// Linux IPv4 echoes UID and nonzero mark. IPv6 rt6_fill_node does not;
	// its UID parsing is separately proven by the mandatory strict probe.
	if family == unix.AF_INET && (!gotUID || echoedMark != mark) {
		return 0, errors.New("route lookup lacks verified UID/mark support")
	}
	return out, nil
}

// routeProbeFamily is replaceable in tests; production always uses
// probeRouteFamily.
var routeProbeFamily = probeRouteFamily

func probeRouteFamily(address string) error {
	loopback, err := net.InterfaceByName("lo")
	if err != nil {
		return err
	}
	addr := netip.MustParseAddr(address)
	for _, protocol := range []uint8{17, 6} {
		tuple := flowTuple{netip.AddrPortFrom(addr, 49152), netip.AddrPortFrom(addr, 53), protocol}
		out, err := effectiveRoute(tuple, 65534, 0x1234, 0)
		if err != nil || out != loopback.Index {
			return fmt.Errorf("route UID/mark capability (%s/%d): %v", address, protocol, err)
		}
		request, err := routeRequest(tuple, 65534, 0, 0, true)
		if err != nil {
			return err
		}
		if _, err = executeRoute(request); !errors.Is(err, unix.EINVAL) && !errors.Is(err, unix.ERANGE) {
			return fmt.Errorf("route query did not reject malformed UID (%s): %v", address, err)
		}
	}
	return nil
}

// The capability verdict requires only IPv4 route queries: a kernel without
// IPv6 still intercepts IPv4 DNS. The IPv6 family is probed best-effort and
// reported separately so callers can skip v6 rules instead of the whole mode.
func probeRouteContext() (bool, error) {
	if err := routeProbeFamily("127.0.0.1"); err != nil {
		return false, err
	}
	return routeProbeFamily("::1") == nil, nil
}

// Unreachable/removed paths are ordinary routing outcomes. A broken query API
// or timeout is a capability failure: do not spend 100 ms on every queued DNS
// packet while the queue grows; the lifecycle guard must withdraw this mode.
func routeCapabilityFailure(err error) bool {
	if err == nil {
		return false
	}
	for _, normal := range []error{unix.ENETUNREACH, unix.EHOSTUNREACH, unix.ENETDOWN, unix.ENOENT, unix.ESRCH, unix.EADDRNOTAVAIL, unix.ENODEV} {
		if errors.Is(err, normal) {
			return false
		}
	}
	return true
}

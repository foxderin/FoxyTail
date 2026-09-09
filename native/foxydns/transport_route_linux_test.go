//go:build linux

package main

import (
	"encoding/binary"
	"net/netip"
	"testing"

	"github.com/mdlayher/netlink"
	"golang.org/x/sys/unix"
)

func TestRouteRequestIncludesOriginalUIDMarkAndTransport(t *testing.T) {
	for _, source := range []string{"192.0.2.2:42000", "[2001:db8::2]:42000"} {
		src := netip.MustParseAddrPort(source)
		dst := netip.MustParseAddrPort("192.0.2.53:53")
		if src.Addr().Is6() {
			dst = netip.MustParseAddrPort("[2001:db8::53]:53")
		}
		tuple := flowTuple{src, dst, 17}
		request, err := routeRequest(tuple, 10025, 0x23456, 0x20, false)
		if err != nil {
			t.Fatal(err)
		}
		attrs, err := netlink.UnmarshalAttributes(request.Data[12:])
		if err != nil {
			t.Fatal(err)
		}
		values := make(map[uint16][]byte)
		for _, attr := range attrs {
			values[attr.Type] = attr.Data
		}
		if binary.NativeEndian.Uint32(values[unix.RTA_UID]) != 10025 || binary.NativeEndian.Uint32(values[unix.RTA_MARK]) != 0x23456 ||
			values[unix.RTA_IP_PROTO][0] != 17 || binary.BigEndian.Uint16(values[unix.RTA_SPORT]) != 42000 ||
			binary.BigEndian.Uint16(values[unix.RTA_DPORT]) != 53 || request.Data[3] != 0x20 {
			t.Fatal("route lookup must not silently use root's context")
		}
		if len(values[unix.RTA_SRC]) != src.Addr().BitLen()/8 || len(values[unix.RTA_DST]) != dst.Addr().BitLen()/8 {
			t.Fatal("route address family was lost")
		}
		if _, forced := values[unix.RTA_OIF]; forced {
			t.Fatal("route check must discover actual output, not force the expected answer")
		}
	}
}

func TestRouteResponseMustProveIPv4UIDMarkAndDestination(t *testing.T) {
	tuple := flowTuple{netip.MustParseAddrPort("192.0.2.2:42000"), netip.MustParseAddrPort("192.0.2.53:53"), 17}
	number := func(n uint32) []byte { p := make([]byte, 4); binary.NativeEndian.PutUint32(p, n); return p }
	attrs := []netlink.Attribute{
		{Type: unix.RTA_UID, Data: number(10025)}, {Type: unix.RTA_MARK, Data: number(0x23456)},
		{Type: unix.RTA_OIF, Data: number(7)}, {Type: unix.RTA_DST, Data: tuple.destination.Addr().AsSlice()},
	}
	response := func(attrs []netlink.Attribute) []netlink.Message {
		data := make([]byte, 12)
		data[0] = unix.AF_INET
		data[7] = unix.RTN_UNICAST
		encoded, err := netlink.MarshalAttributes(attrs)
		if err != nil {
			t.Fatal(err)
		}
		return []netlink.Message{{Header: netlink.Header{Type: unix.RTM_NEWROUTE}, Data: append(data, encoded...)}}
	}
	if out, err := routeInterface(response(attrs), tuple, 10025, 0x23456); err != nil || out != 7 {
		t.Fatalf("valid route rejected: %d / %v", out, err)
	}
	for n, field := range []string{"uid", "mark", "interface", "destination"} {
		t.Run(field, func(t *testing.T) {
			missing := append([]netlink.Attribute(nil), attrs[:n]...)
			missing = append(missing, attrs[n+1:]...)
			if _, err := routeInterface(response(missing), tuple, 10025, 0x23456); err == nil {
				t.Fatal("incomplete route support was accepted")
			}
		})
	}
	attrs[0].Data = number(0)
	if _, err := routeInterface(response(attrs), tuple, 10025, 0x23456); err == nil {
		t.Fatal("kernel ignored requested UID and used root")
	}
}

//go:build linux

package main

import (
	"encoding/binary"
	"net/netip"
	"testing"

	"github.com/mdlayher/netlink"
	"golang.org/x/sys/unix"
)

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

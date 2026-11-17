package main

import (
	"encoding/binary"
	"errors"
	"net/netip"
	"testing"
)

func dnsPacket(ipv6, tcp bool) []byte {
	ipLen, transportLen := 20, 8
	if ipv6 {
		ipLen = 40
	}
	if tcp {
		transportLen = 20
	}
	packet := make([]byte, ipLen+transportLen+12)
	protocol := byte(17)
	if tcp {
		protocol = 6
		packet[ipLen+12] = 5 << 4
	} else {
		binary.BigEndian.PutUint16(packet[ipLen+4:ipLen+6], uint16(transportLen+12))
	}
	if ipv6 {
		packet[0], packet[6] = 0x60, protocol
		binary.BigEndian.PutUint16(packet[4:6], uint16(len(packet)-40))
		copy(packet[8:24], netip.MustParseAddr("2001:db8::2").AsSlice())
		copy(packet[24:40], netip.MustParseAddr("2001:db8::53").AsSlice())
	} else {
		packet[0], packet[9] = 0x45, protocol
		binary.BigEndian.PutUint16(packet[2:4], uint16(len(packet)))
		copy(packet[12:16], []byte{192, 0, 2, 2})
		copy(packet[16:20], []byte{192, 0, 2, 53})
	}
	binary.BigEndian.PutUint16(packet[ipLen:ipLen+2], 43000)
	binary.BigEndian.PutUint16(packet[ipLen+2:ipLen+4], 53)
	return packet
}

func TestUnsupportedPacketsKeepOriginalPath(t *testing.T) {
	for _, test := range []struct {
		name   string
		packet []byte
		mutate func([]byte) []byte
	}{
		{"empty", nil, func(p []byte) []byte { return p }},
		{"truncated-ip", dnsPacket(false, false), func(p []byte) []byte { return p[:19] }},
		{"truncated-payload", dnsPacket(false, false), func(p []byte) []byte { return p[:len(p)-1] }},
		{"ipv4-fragment-offset", dnsPacket(false, false), func(p []byte) []byte { p[7] = 1; return p }},
		{"ipv4-more-fragments", dnsPacket(false, false), func(p []byte) []byte { p[6] = 0x20; return p }},
		{"ipv6-fragment-header", dnsPacket(true, false), func(p []byte) []byte { p[6] = 44; return p }},
		{"ipv6-extension-header", dnsPacket(true, false), func(p []byte) []byte { p[6] = 0; return p }},
		{"udp-length-mismatch", dnsPacket(false, false), func(p []byte) []byte { p[25]++; return p }},
		{"tcp-short-header", dnsPacket(false, true), func(p []byte) []byte { p[32] = 4 << 4; return p }},
		{"non-dns", dnsPacket(false, false), func(p []byte) []byte { p[23] = 54; return p }},
		{"loopback-upstream", dnsPacket(false, false), func(p []byte) []byte { copy(p[16:20], []byte{127, 0, 0, 1}); return p }},
		{"multicast", dnsPacket(false, false), func(p []byte) []byte { p[16] = 224; return p }},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, ok := packetTuple(test.mutate(test.packet)); ok {
				t.Fatal("unsupported packet must not be captured")
			}
		})
	}
}

func TestOriginalContextCannotBeInventedOrOutliveNetwork(t *testing.T) {
	f := FlowContext{
		OriginalSource: netip.MustParseAddrPort("192.0.2.2:43000"), OriginalDestination: netip.MustParseAddrPort("192.0.2.53:53"),
		UID: 10001, OutIfIndex: 2, InterfaceName: "tun0", protocol: 17,
	}
	if f.Valid() {
		t.Fatal("addresses and UID alone must not authorize forwarding")
	}
	f.validate = func() error { return nil }
	if !f.Valid() {
		t.Fatal("mark zero is a legitimate original mark")
	}
	f.Mark = captureMark
	if f.Valid() {
		t.Fatal("capture bit must not escape into original network context")
	}
	f.Mark = 0
	f.validate = func() error { return errors.New("network removed") }
	if f.Valid() {
		t.Fatal("expired network context must fail closed")
	}
}

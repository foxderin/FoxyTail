package main

import (
	"encoding/binary"
	"errors"
	"github.com/miekg/dns"
	"net"
	"net/netip"
	"testing"
	"time"
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

func TestPacketTuplePreservesCompleteFlowKey(t *testing.T) {
	for _, test := range []struct {
		name      string
		ipv6, tcp bool
	}{
		{"udp4", false, false}, {"tcp4", false, true}, {"udp6", true, false}, {"tcp6", true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			tuple, ok := packetTuple(dnsPacket(test.ipv6, test.tcp))
			if !ok || tuple.source.Port() != 43000 || tuple.destination.Port() != 53 || tuple.source.Addr().Is6() != test.ipv6 {
				t.Fatalf("complete flow was lost: %+v, valid=%t", tuple, ok)
			}
			if test.tcp && tuple.protocol != 6 || !test.tcp && tuple.protocol != 17 {
				t.Fatalf("wrong protocol: %d", tuple.protocol)
			}
			other := dnsPacket(test.ipv6, test.tcp)
			if test.ipv6 {
				other[39]++
			} else {
				other[19]++
			}
			otherTuple, valid := packetTuple(other)
			if !valid || tuple == otherTuple || tuple.source != otherTuple.source {
				t.Fatal("same source port to distinct DNS servers must remain distinct")
			}
		})
	}
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

func TestLookupAddressesRequireExactEndpoints(t *testing.T) {
	if _, err := addressPort(&net.UDPAddr{Port: 1053}); err == nil {
		t.Fatal("wildcard listener cannot identify a conntrack reply tuple")
	}
	addr := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 1053}
	out, err := addressPort(addr)
	if err != nil || out.String() != "127.0.0.1:1053" || !out.Addr().Is4() {
		t.Fatalf("IPv4-mapped local address not canonicalized: %v / %v", out, err)
	}
}

func TestUDPListenerExposesExactLocalAddressForConntrack(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "::1"} {
		t.Run(host, func(t *testing.T) {
			packet, err := net.ListenPacket("udp", net.JoinHostPort(host, "0"))
			if err != nil {
				if host == "::1" {
					t.Skipf("IPv6 loopback unavailable: %v", err)
				}
				t.Fatal(err)
			}
			observed := make(chan net.Addr, 1)
			ready := make(chan struct{})
			server := &dns.Server{PacketConn: packet, NotifyStartedFunc: func() { close(ready) }, Handler: dns.HandlerFunc(func(w dns.ResponseWriter, query *dns.Msg) {
				observed <- w.LocalAddr()
				response := new(dns.Msg)
				response.SetReply(query)
				_ = w.WriteMsg(response)
			})}
			done := make(chan error, 1)
			go func() { done <- server.ActivateAndServe() }()
			defer func() { _ = server.Shutdown(); <-done }()
			<-ready
			query := new(dns.Msg)
			query.SetQuestion("probe.invalid.", dns.TypeA)
			client := dns.Client{Net: "udp", Timeout: time.Second}
			if _, _, err = client.Exchange(query, packet.LocalAddr().String()); err != nil {
				t.Fatal(err)
			}
			actual, err := addressPort(<-observed)
			expected, _ := addressPort(packet.LocalAddr())
			if err != nil || actual != expected || actual.Addr().String() != host {
				t.Fatalf("UDP response writer lost actual local endpoint: %v / %v", actual, err)
			}
		})
	}
}

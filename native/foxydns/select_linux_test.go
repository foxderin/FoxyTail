//go:build linux

package main

import (
	"encoding/binary"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"testing"

	"github.com/florianl/go-nfqueue/v2"
	"github.com/miekg/dns"
	"golang.org/x/sys/unix"
)

// dnsQueryPacket wraps a packed DNS query for name in a UDP/53 IP packet.
func dnsQueryPacket(name string, ipv6 bool) []byte {
	q := new(dns.Msg)
	q.SetQuestion(name, dns.TypeA)
	payload, err := q.Pack()
	if err != nil {
		panic(err)
	}
	packet := dnsPacket(ipv6, false)
	ipLen := 20
	if ipv6 {
		ipLen = 40
	}
	out := make([]byte, ipLen+8+len(payload))
	copy(out[:ipLen+8], packet[:ipLen+8])
	copy(out[ipLen+8:], payload)
	binary.BigEndian.PutUint16(out[ipLen+4:ipLen+6], uint16(8+len(payload)))
	if ipv6 {
		binary.BigEndian.PutUint16(out[4:6], uint16(len(out)-40))
	} else {
		binary.BigEndian.PutUint16(out[2:4], uint16(len(out)))
	}
	return out
}

func selectorFixture(t *testing.T) (*Selector, *[]netip.AddrPort, *[][]byte) {
	t.Helper()
	dir := t.TempDir()
	contextFile := filepath.Join(dir, "context.json")
	if err := os.WriteFile(contextFile, []byte(`{"suffix":"tail.test.ts.net","hosts":[{"ip":"100.65.0.1","name":"nas.tail.test.ts.net","short":"nas"},{"ip":"fd7a:115c:a1e0::1","name":"nas.tail.test.ts.net","short":"nas"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	var injectedSrc []netip.AddrPort
	var injected [][]byte
	s := &Selector{
		records: &recordStore{path: contextFile},
		inject: func(src, dst netip.AddrPort, payload []byte) error {
			injectedSrc = append(injectedSrc, src)
			injected = append(injected, payload)
			return nil
		},
	}
	return s, &injectedSrc, &injected
}

func selectionAttr(t *testing.T, packet []byte) nfqueue.Attribute {
	t.Helper()
	return nfqueue.Attribute{
		PacketID: ptr(uint32(1)), Hook: ptr(uint8(unix.NF_INET_LOCAL_OUT)),
		UID: ptr(uint32(10001)), GID: ptr(uint32(10001)), Payload: &packet,
	}
}

func TestSelectorAnswersOnlyTailnetNames(t *testing.T) {
	for _, test := range []struct {
		name    string
		query   string
		verdict int
	}{
		{"full-name", "NaS.tail.test.ts.net.", nfqueue.NfDrop},
		{"short-name", "nas.", nfqueue.NfDrop},
		{"missing-inside-suffix", "gone.tail.test.ts.net.", nfqueue.NfDrop},
		{"outside-suffix", "nas.example.com.", nfqueue.NfAccept},
		{"unknown-short", "other.", nfqueue.NfAccept},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, sources, _ := selectorFixture(t)
			packet := dnsQueryPacket(test.query, false)
			verdict := s.decide(selectionAttr(t, packet))
			if verdict != test.verdict || (len(*sources) > 0) != (test.verdict == nfqueue.NfDrop) {
				t.Fatalf("%s: verdict=%d injected=%d", test.name, verdict, len(*sources))
			}
		})
	}
}

func TestSelectorInjectedAnswerAppearsFromOriginalResolver(t *testing.T) {
	s, sources, payloads := selectorFixture(t)
	packet := dnsQueryPacket("nas.tail.test.ts.net.", false)
	tuple, _, ok := udpQueryPayload(packet)
	if !ok {
		t.Fatal("fixture packet rejected")
	}
	if verdict := s.decide(selectionAttr(t, packet)); verdict != nfqueue.NfDrop || len(*sources) != 1 {
		t.Fatal("Tailnet question was not answered")
	}
	if (*sources)[0] != tuple.destination {
		t.Fatalf("forged answer source %v != original resolver %v", (*sources)[0], tuple.destination)
	}
	response := new(dns.Msg)
	if err := response.Unpack((*payloads)[0]); err != nil || !response.Response || len(response.Answer) == 0 {
		t.Fatalf("invalid injected answer: %v", err)
	}
}

func TestSelectorMissingContextPassesAllTraffic(t *testing.T) {
	dir := t.TempDir()
	s := &Selector{records: &recordStore{path: filepath.Join(dir, "absent.json")}, inject: func(netip.AddrPort, netip.AddrPort, []byte) error {
		return errors.New("must not inject")
	}}
	packet := dnsQueryPacket("nas.tail.test.ts.net.", false)
	if verdict := s.decide(selectionAttr(t, packet)); verdict != nfqueue.NfAccept {
		t.Fatal("query without Tailnet context must reach its real resolver")
	}
}

func TestSelectorInjectionFailurePassesAndDenialFailsClosed(t *testing.T) {
	s, _, _ := selectorFixture(t)
	s.inject = func(netip.AddrPort, netip.AddrPort, []byte) error { return errors.New("transient") }
	packet := dnsQueryPacket("nas.tail.test.ts.net.", false)
	if verdict := s.decide(selectionAttr(t, packet)); verdict != nfqueue.NfAccept || s.Health() != nil {
		t.Fatal("transient injection failure must pass the original packet")
	}
	s.inject = func(netip.AddrPort, netip.AddrPort, []byte) error { return unix.EPERM }
	if verdict := s.decide(selectionAttr(t, packet)); verdict != nfqueue.NfAccept || s.Health() == nil {
		t.Fatal("injection denial must mark the selector unhealthy")
	}
	if verdict := s.decide(selectionAttr(t, packet)); verdict != nfqueue.NfAccept {
		t.Fatal("unhealthy selector must pass all traffic")
	}
}

func TestSelectorRejectsMalformedAndHelperPackets(t *testing.T) {
	s, sources, _ := selectorFixture(t)
	bad := dnsPacket(false, true) // TCP is outside this queue's scope.
	if verdict := s.decide(selectionAttr(t, bad)); verdict != nfqueue.NfAccept {
		t.Fatal("non-UDP packet must pass")
	}
	garbage := dnsQueryPacket("nas.tail.test.ts.net.", false)
	garbage = garbage[:len(garbage)-2] // Truncate inside the DNS payload.
	if verdict := s.decide(selectionAttr(t, garbage)); verdict != nfqueue.NfAccept {
		t.Fatal("malformed DNS payload must pass")
	}
	a := selectionAttr(t, dnsQueryPacket("nas.tail.test.ts.net.", false))
	a.UID = ptr(uint32(0))
	a.GID = ptr(helperSocketGID)
	if verdict := s.decide(a); verdict != nfqueue.NfAccept || len(*sources) != 0 {
		t.Fatal("helper credential exemption must pass")
	}
}

func TestSelectorAnswersOnlyLocalOutPackets(t *testing.T) {
	for _, hook := range []uint8{unix.NF_INET_LOCAL_IN, unix.NF_INET_FORWARD, unix.NF_INET_PRE_ROUTING, unix.NF_INET_POST_ROUTING} {
		s, sources, _ := selectorFixture(t)
		a := selectionAttr(t, dnsQueryPacket("nas.tail.test.ts.net.", false))
		a.Hook = ptr(hook)
		if verdict := s.decide(a); verdict != nfqueue.NfAccept || len(*sources) != 0 {
			t.Fatalf("hook %d must not be answered", hook)
		}
	}
	s, sources, _ := selectorFixture(t)
	a := selectionAttr(t, dnsQueryPacket("nas.tail.test.ts.net.", false))
	a.Hook = nil
	if verdict := s.decide(a); verdict != nfqueue.NfAccept || len(*sources) != 0 {
		t.Fatal("missing hook must not be answered")
	}
}

func TestSelectorIPv6TailnetAnswer(t *testing.T) {
	s, sources, _ := selectorFixture(t)
	packet := dnsQueryPacket("nas.tail.test.ts.net.", true)
	if verdict := s.decide(selectionAttr(t, packet)); verdict != nfqueue.NfDrop || len(*sources) != 1 {
		t.Fatal("IPv6 Tailnet question was not answered")
	}
}

func TestUdpQueryPayloadExtractsDNSMessage(t *testing.T) {
	for _, ipv6 := range []bool{false, true} {
		packet := dnsQueryPacket("nas.tail.test.ts.net.", ipv6)
		tuple, payload, ok := udpQueryPayload(packet)
		if !ok || tuple.destination.Port() != 53 {
			t.Fatalf("udpQueryPayload ipv6=%t: %+v", ipv6, tuple)
		}
		q := new(dns.Msg)
		if err := q.Unpack(payload); err != nil || q.Question[0].Name != "nas.tail.test.ts.net." {
			t.Fatalf("DNS payload ipv6=%t: %v", ipv6, err)
		}
	}
	if _, _, ok := udpQueryPayload(dnsPacket(false, true)); ok {
		t.Fatal("TCP/53 is outside the UDP queue's scope")
	}
}

func TestInjectedPacketLayoutAndChecksums(t *testing.T) {
	payload := []byte("dns-answer")
	v4src := netip.MustParseAddrPort("192.0.2.53:53")
	v4dst := netip.MustParseAddrPort("192.0.2.7:53000")
	packet4 := udp4Packet(v4src, v4dst, payload)
	if packet4[0] != 0x45 || int(binary.BigEndian.Uint16(packet4[2:4])) != len(packet4) ||
		packet4[9] != 17 || len(packet4) != 20+8+len(payload) {
		t.Fatalf("bad IPv4 header: %x", packet4[:20])
	}
	if string(packet4[12:16]) != string(v4src.Addr().AsSlice()) || string(packet4[16:20]) != string(v4dst.Addr().AsSlice()) {
		t.Fatal("IPv4 endpoints not preserved")
	}
	udp4 := packet4[20:]
	if binary.BigEndian.Uint16(udp4[0:2]) != 53 || binary.BigEndian.Uint16(udp4[2:4]) != 53000 ||
		binary.BigEndian.Uint16(udp4[4:6]) != uint16(8+len(payload)) {
		t.Fatal("IPv4 UDP header wrong")
	}
	// Summing the pseudo-header and the datagram including its checksum
	// field must complement to zero.
	pseudo4 := make([]byte, 12)
	copy(pseudo4[0:4], v4src.Addr().AsSlice())
	copy(pseudo4[4:8], v4dst.Addr().AsSlice())
	pseudo4[9] = 17
	binary.BigEndian.PutUint16(pseudo4[10:12], uint16(len(udp4)))
	if sum := checksumSum(pseudo4, udp4); sum != 0 {
		t.Fatalf("IPv4 UDP checksum invalid: %#x", sum)
	}

	v6src := netip.MustParseAddrPort("[fd7a::53]:53")
	v6dst := netip.MustParseAddrPort("[fd7a::7]:53000")
	packet6 := udp6Packet(v6src, v6dst, payload)
	if packet6[0]>>4 != 6 || int(binary.BigEndian.Uint16(packet6[4:6])) != 8+len(payload) ||
		packet6[6] != 17 || packet6[7] != 64 {
		t.Fatalf("bad IPv6 header: %x", packet6[:40])
	}
	udp6 := packet6[40:]
	pseudo6 := make([]byte, 40)
	copy(pseudo6[0:16], v6src.Addr().AsSlice())
	copy(pseudo6[16:32], v6dst.Addr().AsSlice())
	binary.BigEndian.PutUint32(pseudo6[32:36], uint32(len(udp6)))
	pseudo6[39] = 17
	if sum := checksumSum(pseudo6, udp6); sum != 0 {
		t.Fatalf("IPv6 UDP checksum invalid: %#x", sum)
	}
	if sum := checksumSum(pseudo6, udp6[:6], udp6[8:]); sum != binary.BigEndian.Uint16(udp6[6:8]) {
		t.Fatalf("IPv6 checksum field does not match header sum: %#x != %#x", sum, binary.BigEndian.Uint16(udp6[6:8]))
	}
}

func TestInjectPayloadBoundMatchesIPv4TotalLength(t *testing.T) {
	// IPv4 total length is 20-byte header + 8-byte UDP + payload <= 0xffff.
	if err := injectUDP(netip.MustParseAddrPort("192.0.2.53:53"), netip.MustParseAddrPort("192.0.2.7:53000"), make([]byte, 0xffff-27)); err == nil || err.Error() != "invalid injection endpoints" {
		t.Fatalf("payload beyond the IPv4 total-length field was not rejected before send: %v", err)
	}
	if err := injectUDP(netip.MustParseAddrPort("[fd7a::53]:53"), netip.MustParseAddrPort("[fd7a::7]:53000"), make([]byte, 0xffff-27)); err == nil || err.Error() != "invalid injection endpoints" {
		t.Fatalf("payload beyond the UDP length field was not rejected before send: %v", err)
	}
}

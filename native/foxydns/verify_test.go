package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func verifyDNSServer(t *testing.T, handler dns.HandlerFunc) int {
	t.Helper()
	var listener net.Listener
	var packet net.PacketConn
	var err error
	// TCP's ephemeral allocation does not reserve the matching UDP port.
	for range 16 {
		listener, err = net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		packet, err = net.ListenPacket("udp4", listener.Addr().String())
		if err == nil {
			break
		}
		listener.Close()
		if !errors.Is(err, syscall.EADDRINUSE) {
			t.Fatal(err)
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	for _, server := range []*dns.Server{{Listener: listener, Handler: handler}, {PacketConn: packet, Handler: handler}} {
		started := make(chan struct{})
		done := make(chan error, 1)
		server.NotifyStartedFunc = func() { close(started) }
		go func() { done <- server.ActivateAndServe() }()
		<-started
		t.Cleanup(func() {
			if err := server.Shutdown(); err != nil {
				t.Error(err)
			}
			if err := <-done; err != nil {
				t.Error(err)
			}
		})
	}
	return listener.Addr().(*net.TCPAddr).Port
}

func verifyAnswer(query *dns.Msg, address string) *dns.Msg {
	response := new(dns.Msg)
	response.SetReply(query)
	header := dns.RR_Header{Name: query.Question[0].Name, Class: dns.ClassINET, Rrtype: query.Question[0].Qtype}
	if header.Rrtype == dns.TypeAAAA {
		response.Answer = []dns.RR{&dns.AAAA{Hdr: header, AAAA: net.ParseIP(address)}}
	} else {
		response.Answer = []dns.RR{&dns.A{Hdr: header, A: net.ParseIP(address)}}
	}
	return response
}

func TestVerifyDNSConsumesStrictWireResponses(t *testing.T) {
	for _, network := range []string{"udp", "tcp"} {
		for _, test := range []struct {
			name    string
			address string
			change  func(*dns.Msg)
			ok      bool
			seen    string
		}{
			{name: "ipv4", address: "100.64.0.9", ok: true},
			{name: "ipv6", address: "fd7a:115c:a1e0::9", ok: true},
			{name: "case-insensitive", address: "100.64.0.9", ok: true, change: func(m *dns.Msg) {
				m.Question[0].Name = strings.ToUpper(m.Question[0].Name)
				m.Answer[0].Header().Name = strings.ToUpper(m.Answer[0].Header().Name)
			}},
			{name: "duplicate-set", address: "100.64.0.9", ok: true, change: func(m *dns.Msg) { m.Answer = append(m.Answer, m.Answer[0]) }},
			{name: "fake-ip", address: "100.64.0.9", seen: "198.18.0.7", change: func(m *dns.Msg) { m.Answer[0].(*dns.A).A = net.ParseIP("198.18.0.7") }},
			{name: "extra-fake-ip", address: "100.64.0.9", seen: "198.18.0.7", change: func(m *dns.Msg) {
				m.Answer = append(m.Answer, &dns.A{Hdr: *m.Answer[0].Header(), A: net.ParseIP("198.18.0.7")})
			}},
			{name: "wrong-ipv6", address: "fd7a:115c:a1e0::9", seen: "fd7a:115c:a1e0::8", change: func(m *dns.Msg) { m.Answer[0].(*dns.AAAA).AAAA = net.ParseIP("fd7a:115c:a1e0::8") }},
			{name: "empty", address: "100.64.0.9", change: func(m *dns.Msg) { m.Answer = nil }},
			{name: "refused", address: "100.64.0.9", change: func(m *dns.Msg) { m.Rcode = dns.RcodeRefused }},
			{name: "nxdomain", address: "100.64.0.9", change: func(m *dns.Msg) { m.Rcode = dns.RcodeNameError }},
			{name: "truncated", address: "100.64.0.9", change: func(m *dns.Msg) { m.Truncated = true }},
			{name: "query-not-response", address: "100.64.0.9", change: func(m *dns.Msg) { m.Response = false }},
			{name: "wrong-id", address: "100.64.0.9", change: func(m *dns.Msg) { m.Id++ }},
			{name: "wrong-opcode", address: "100.64.0.9", change: func(m *dns.Msg) { m.Opcode = dns.OpcodeStatus }},
			{name: "missing-question", address: "100.64.0.9", change: func(m *dns.Msg) { m.Question = nil }},
			{name: "extra-question", address: "100.64.0.9", change: func(m *dns.Msg) { m.Question = append(m.Question, m.Question[0]) }},
			{name: "wrong-question-name", address: "100.64.0.9", change: func(m *dns.Msg) { m.Question[0].Name = "other.tail.test." }},
			{name: "wrong-question-class", address: "100.64.0.9", change: func(m *dns.Msg) { m.Question[0].Qclass = dns.ClassCHAOS }},
			{name: "wrong-question-type", address: "100.64.0.9", change: func(m *dns.Msg) { m.Question[0].Qtype = dns.TypeAAAA }},
			{name: "wrong-owner", address: "100.64.0.9", change: func(m *dns.Msg) { m.Answer[0].Header().Name = "other.tail.test." }},
			{name: "wrong-record-class", address: "100.64.0.9", change: func(m *dns.Msg) { m.Answer[0].Header().Class = dns.ClassCHAOS }},
			{name: "wrong-record-type", address: "100.64.0.9", change: func(m *dns.Msg) {
				m.Answer = []dns.RR{&dns.AAAA{Hdr: dns.RR_Header{Name: m.Question[0].Name, Class: dns.ClassINET, Rrtype: dns.TypeAAAA}, AAAA: net.ParseIP("::ffff:100.64.0.9")}}
			}},
			{name: "cname-not-exact", address: "100.64.0.9", change: func(m *dns.Msg) {
				m.Answer = append(m.Answer, &dns.CNAME{Hdr: dns.RR_Header{Name: m.Question[0].Name, Class: dns.ClassINET, Rrtype: dns.TypeCNAME}, Target: "other.tail.test."})
			}},
		} {
			t.Run(network+"/"+test.name, func(t *testing.T) {
				port := verifyDNSServer(t, func(w dns.ResponseWriter, q *dns.Msg) {
					m := verifyAnswer(q, test.address)
					if test.change != nil {
						test.change(m)
					}
					_ = w.WriteMsg(m)
				})
				addresses, err := verifyDNS(context.Background(), network, port, "peer.tail.test.", netip.MustParseAddr(test.address))
				if (err == nil) != test.ok {
					t.Fatalf("addresses=%v error=%v, expected success=%v", addresses, err, test.ok)
				}
				if test.ok && !slices.Equal(addresses, []string{test.address}) {
					t.Fatalf("unexpected addresses: %v", addresses)
				}
				if test.seen != "" && !slices.Contains(addresses, test.seen) {
					t.Fatalf("unexpected address missing from report: %v", addresses)
				}
			})
		}
	}
}

func TestVerifyDNSMalformedAndDeadline(t *testing.T) {
	for _, network := range []string{"udp", "tcp"} {
		t.Run(network+"/malformed", func(t *testing.T) {
			port := verifyDNSServer(t, func(w dns.ResponseWriter, _ *dns.Msg) { _, _ = w.Write([]byte{0, 1, 2}) })
			if _, err := verifyDNS(context.Background(), network, port, "peer.tail.test.", netip.MustParseAddr("100.64.0.9")); err == nil {
				t.Fatal("accepted malformed wire response")
			}
		})
		t.Run(network+"/deadline", func(t *testing.T) {
			port := verifyDNSServer(t, func(dns.ResponseWriter, *dns.Msg) {})
			started := time.Now()
			_, err := verifyDNS(context.Background(), network, port, "peer.tail.test.", netip.MustParseAddr("100.64.0.9"))
			if err == nil || time.Since(started) > 3*time.Second {
				t.Fatalf("DNS deadline failed: %v after %v", err, time.Since(started))
			}
		})
	}
}

func TestVerifyRejectsAllInvalidInputsBeforeProbing(t *testing.T) {
	base := []string{"--dns-port", "1053", "--name", "Peer.Tail.Test", "--address", "100.64.0.9", "--target-port", "443"}
	for _, test := range [][]string{
		{"--dns-port", "0"}, {"--dns-port", "65536"}, {"--dns-port", "no"},
		{"--target-port", "0"}, {"--target-port", "-1"}, {"--target-port", "65536"},
		{"--resolver-port", "0"}, {"--resolver-port", "65536"}, {"--resolver-port", "1053"},
		{"--socks-port", "0"}, {"--socks-port", "-1"}, {"--socks-port", "65536"},
		{"--name", ""}, {"--name", "short"}, {"--name", "bad..test"}, {"--name", "bad name.test"},
		{"--name", "-bad.test"}, {"--name", strings.Repeat("a", 64) + ".test"},
		{"--address", "peer.tail.test"}, {"--address", "0.0.0.0"}, {"--address", "::"},
		{"--address", "127.0.0.1"}, {"--address", "::1"}, {"--address", "::ffff:127.0.0.1"},
		{"--address", "224.0.0.1"}, {"--address", "ff02::1"}, {"--address", "169.254.1.1"},
		{"--address", "fe80::1"}, {"--address", "fd7a::1%lo0"}, {"--address", "255.255.255.255"},
		{"--unknown", "1"}, {"extra"},
	} {
		t.Run(strings.Join(test, "="), func(t *testing.T) {
			if err := run(append([]string{"verify"}, append(slices.Clone(base), test...)...)); err == nil {
				t.Fatal("invalid command reached probes")
			}
		})
	}
	for _, field := range []int{0, 2, 4, 6} {
		args := append(slices.Clone(base[:field]), base[field+2:]...)
		if _, err := parseVerifyOptions(args); err == nil {
			t.Fatalf("accepted missing %s", base[field])
		}
	}
	for _, address := range []string{"100.64.0.9", "::ffff:100.64.0.9", "FD7A:115C:A1E0::9"} {
		options, err := parseVerifyOptions(append(slices.Clone(base), "--address", address))
		if err != nil || options.name != "peer.tail.test." || options.address.String() != netip.MustParseAddr(address).Unmap().String() {
			t.Fatalf("canonicalization failed: %+v / %v", options, err)
		}
	}
	options, err := parseVerifyOptions(append(slices.Clone(base), "--target-port", "00443", "--resolver-port", "01054"))
	if err != nil || options.targetPort != 443 || options.resolverPort != 1054 {
		t.Fatalf("UI port digits must stay decimal: %+v / %v", options, err)
	}
}

func verifyTCPServer(t *testing.T, serve func(net.Conn) error) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		defer connection.Close()
		_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
		done <- serve(connection)
	}()
	t.Cleanup(func() {
		defer listener.Close()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(6 * time.Second):
			t.Error("probe server did not observe connection closure")
		}
	})
	return listener.Addr().(*net.TCPAddr).Port
}

func verifyNoPayload(connection net.Conn) error {
	var data [1]byte
	n, err := connection.Read(data[:])
	if n != 0 || err != io.EOF {
		return fmt.Errorf("connection not closed without application data: n=%d error=%v", n, err)
	}
	return nil
}

func verifySOCKSServer(t *testing.T, address netip.Addr, targetPort int, behavior string) int {
	t.Helper()
	return verifyTCPServer(t, func(connection net.Conn) error {
		var greeting [3]byte
		if _, err := io.ReadFull(connection, greeting[:]); err != nil {
			return err
		}
		if greeting != [3]byte{5, 1, 0} {
			return fmt.Errorf("unexpected SOCKS greeting: %v", greeting)
		}
		if behavior == "stall" {
			return verifyNoPayload(connection)
		}
		if behavior == "bad-version" {
			_, _ = connection.Write([]byte{4, 0})
			return verifyNoPayload(connection)
		}
		if behavior == "no-auth" {
			_, _ = connection.Write([]byte{5, 255})
			return verifyNoPayload(connection)
		}
		if _, err := connection.Write([]byte{5, 0}); err != nil {
			return err
		}
		addressType := byte(1)
		if address.Is6() {
			addressType = 4
		}
		expected := append([]byte{5, 1, 0, addressType}, address.AsSlice()...)
		expected = append(expected, byte(targetPort>>8), byte(targetPort))
		request := make([]byte, len(expected))
		if _, err := io.ReadFull(connection, request); err != nil {
			return err
		}
		if !bytes.Equal(request, expected) {
			return fmt.Errorf("SOCKS target is not exact numeric IP/port: %v", request)
		}
		if behavior == "short-reply" {
			_, err := connection.Write([]byte{5, 0, 0, 1})
			return err
		}
		reply := []byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 1}
		switch behavior {
		case "refused":
			reply[1] = 5
		case "bad-reserved":
			reply[2] = 1
		case "bad-address-type":
			reply[3] = 9
		}
		if behavior != "success" {
			reply = reply[:4]
		}
		if _, err := connection.Write(reply); err != nil {
			return err
		}
		return verifyNoPayload(connection)
	})
}

func TestVerifyTCPNumericSOCKSAndProtocolBoundaries(t *testing.T) {
	for _, address := range []netip.Addr{netip.MustParseAddr("100.64.0.9"), netip.MustParseAddr("fd7a:115c:a1e0::9")} {
		for _, behavior := range []string{"success", "refused", "bad-version", "no-auth", "short-reply", "bad-reserved", "bad-address-type"} {
			t.Run(address.String()+"/"+behavior, func(t *testing.T) {
				port := verifySOCKSServer(t, address, 8443, behavior)
				err := verifyTCP(context.Background(), address, 8443, port)
				if (err == nil) != (behavior == "success") {
					t.Fatalf("unexpected SOCKS result: %v", err)
				}
			})
		}
	}
	t.Run("bounded-handshake", func(t *testing.T) {
		address := netip.MustParseAddr("100.64.0.9")
		port := verifySOCKSServer(t, address, 443, "stall")
		started := time.Now()
		err := verifyTCP(context.Background(), address, 443, port)
		if err == nil || time.Since(started) > 4*time.Second {
			t.Fatalf("SOCKS handshake deadline failed: %v after %v", err, time.Since(started))
		}
	})
	t.Run("system-no-payload", func(t *testing.T) {
		port := verifyTCPServer(t, verifyNoPayload)
		if err := verifyTCP(context.Background(), netip.MustParseAddr("127.0.0.1"), port, 0); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("system-refused", func(t *testing.T) {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := listener.Addr().(*net.TCPAddr).Port
		listener.Close()
		if err := verifyTCP(context.Background(), netip.MustParseAddr("127.0.0.1"), port, 0); err == nil {
			t.Fatal("closed TCP port appeared reachable")
		}
	})
}

func TestVerifyReportsIndependentRows(t *testing.T) {
	address := netip.MustParseAddr("100.64.0.9")
	dnsPort := verifyDNSServer(t, func(w dns.ResponseWriter, q *dns.Msg) {
		m := verifyAnswer(q, address.String())
		if _, udp := w.RemoteAddr().(*net.UDPAddr); udp {
			m.Rcode = dns.RcodeRefused
		}
		_ = w.WriteMsg(m)
	})
	resolverPort := verifyDNSServer(t, func(w dns.ResponseWriter, q *dns.Msg) { _ = w.WriteMsg(verifyAnswer(q, "198.18.0.7")) })
	for _, optional := range []bool{false, true} {
		t.Run(fmt.Sprint(optional), func(t *testing.T) {
			options := verifyOptions{dnsPort: dnsPort, name: "peer.tail.test.", address: address, targetPort: 443, socksPort: verifySOCKSServer(t, address, 443, "success")}
			expectedIDs := []string{"dns-udp", "dns-tcp", "tcp"}
			expectedOK := []bool{false, true, true}
			if optional {
				options.resolverPort = resolverPort
				expectedIDs = []string{"dns-udp", "dns-tcp", "resolver-udp", "resolver-tcp", "tcp"}
				expectedOK = []bool{false, true, false, false, true}
			}
			result := verifyPeer(context.Background(), options)
			if !result.OK || result.Path != "socks5" || result.Address != address.String() || result.Name != "peer.tail.test" || result.TargetPort != 443 || len(result.Checks) != len(expectedIDs) {
				t.Fatalf("incorrect result: %+v", result)
			}
			for index, row := range result.Checks {
				if row.ID != expectedIDs[index] || row.OK != expectedOK[index] || (row.Error == "") != row.OK || row.ElapsedMs < 0 {
					t.Fatalf("incorrect independent row: %+v", row)
				}
			}
			data, err := json.Marshal(result)
			if err != nil || !bytes.Contains(data, []byte(`"targetPort":443`)) || !bytes.Contains(data, []byte(`"elapsedMs":`)) || !bytes.Contains(data, []byte(`"addresses":["198.18.0.7"]`)) && optional {
				t.Fatalf("JSON report lost required fields: %s / %v", data, err)
			}
		})
	}
}

func TestVerifyUDPTimeoutDoesNotSkipTCP(t *testing.T) {
	address := netip.MustParseAddr("100.64.0.9")
	port := verifyDNSServer(t, func(w dns.ResponseWriter, q *dns.Msg) {
		if _, udp := w.RemoteAddr().(*net.UDPAddr); !udp {
			_ = w.WriteMsg(verifyAnswer(q, address.String()))
		}
	})
	result := verifyPeer(context.Background(), verifyOptions{
		dnsPort: port, name: "peer.tail.test.", address: address,
		targetPort: 443, socksPort: verifySOCKSServer(t, address, 443, "success"),
	})
	if len(result.Checks) != 3 || result.Checks[0].OK || !result.Checks[1].OK || !result.Checks[2].OK {
		t.Fatalf("UDP timeout suppressed independent checks: %+v", result)
	}
}

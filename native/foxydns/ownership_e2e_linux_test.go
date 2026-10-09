//go:build linux

package main

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/miekg/dns"
	"github.com/ti-mo/conntrack"
	"golang.org/x/sys/unix"
)

func TestPrivilegedLegacyOwnershipNamespace(t *testing.T) {
	root := requireDNSNamespace(t)
	kernelCommand(t, "ip", "link", "set", "lo", "up")
	kernelCommand(t, "iptables", "-t", "nat", "-P", "OUTPUT", "ACCEPT")
	kernelCommand(t, "iptables", "-t", "filter", "-A", "OUTPUT", "-m", "conntrack", "--ctstate", "NEW,ESTABLISHED", "-j", "ACCEPT")
	directory := t.TempDir()
	source, err := os.ReadFile(filepath.Join(root, "tailscale/scripts/foxytail.dns"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	start, end := strings.Index(text, "redirect_family_apply() {"), strings.Index(text, "# Android kernels can support IPv6")
	if start < 0 || end <= start {
		t.Fatal("legacy rule functions unavailable")
	}
	library := filepath.Join(directory, "legacy-rules.sh")
	if err = os.WriteFile(library, []byte(text[start:end]), 0600); err != nil {
		t.Fatal(err)
	}
	rules := func(port int, action string) {
		cmd := exec.Command("sh", "-c", `. "$1"; CHAIN_DNS=FOXY_DNS; DNS_PORT="$2"; log() { :; }; `+action, "test", library, strconv.Itoa(port))
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("legacy rules %s: %v %s", action, err, out)
		}
	}
	server := func(address, answer string) (*dns.Server, int) {
		packet, err := net.ListenPacket("udp4", address)
		if err != nil {
			t.Fatal(err)
		}
		s := &dns.Server{PacketConn: packet, Handler: dns.HandlerFunc(func(w dns.ResponseWriter, q *dns.Msg) {
			m := new(dns.Msg)
			m.SetReply(q)
			m.Answer = []dns.RR{&dns.A{Hdr: dns.RR_Header{Name: q.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET}, A: net.ParseIP(answer)}}
			w.WriteMsg(m)
		})}
		ready := make(chan struct{})
		s.NotifyStartedFunc = func() { close(ready) }
		go s.ActivateAndServe()
		select {
		case <-ready:
		case <-time.After(time.Second):
			t.Fatal("DNS bind timed out")
		}
		t.Cleanup(func() { s.Shutdown() })
		return s, packet.LocalAddr().(*net.UDPAddr).Port
	}
	_, _ = server("127.0.0.2:53", "198.51.100.77")
	old, oldPort := server("127.0.0.1:0", "100.65.0.1")
	_, foreignPort := server("127.0.0.1:0", "203.0.113.1")
	client, err := net.DialUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 42000}, &net.UDPAddr{IP: net.ParseIP("127.0.0.2"), Port: 53})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	conn := &dns.Conn{Conn: client, UDPSize: 4096}
	foreign, err := net.DialUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 42001}, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: foreignPort})
	if err != nil {
		t.Fatal(err)
	}
	defer foreign.Close()
	e2eQuery(t, &dns.Conn{Conn: foreign}, "foreign.example.", dns.TypeA)
	ct, err := conntrack.Dial(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ct.Close()
	foreignID := func() uint32 {
		timer := time.AfterFunc(3*time.Second, func() { ct.Close() })
		defer timer.Stop()
		flows, err := ct.Dump(nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, flow := range flows {
			if flow.TupleOrig.Proto.SourcePort == 42001 && flow.TupleOrig.Proto.DestinationPort == uint16(foreignPort) {
				return flow.ID
			}
		}
		t.Fatal("foreign connection vanished")
		return 0
	}
	canary := foreignID()
	claim := filepath.Join(directory, "claim")
	if err = legacyOwnership(claim, uint16(oldPort), false); err != nil {
		t.Fatal(err)
	}
	rules(oldPort, "redirect_apply")
	t.Cleanup(func() { rules(oldPort, "redirect_teardown") })
	answer := func(expected string) {
		m := e2eQuery(t, conn, "tuple.example.", dns.TypeA)
		if len(m.Answer) != 1 || m.Answer[0].(*dns.A).A.String() != expected {
			t.Fatalf("wrong same-tuple DNS response: %s", m)
		}
	}
	answer("100.65.0.1")
	flows, err := ct.Dump(nil)
	if err != nil {
		t.Fatal(err)
	}
	var captured *conntrack.Flow
	for index := range flows {
		if flows[index].TupleOrig.Proto.SourcePort == 42000 {
			captured = &flows[index]
			break
		}
	}
	if captured == nil || captured.ID == 0 {
		t.Fatal("captured flow lacks stable identity")
	}
	lookup, err := newCleanupLookup()
	if err != nil {
		t.Fatal(err)
	}
	defer lookup.ct.Close()
	stale := *captured
	stale.ID ^= 1
	if stale.ID == 0 {
		stale.ID = 2
	}
	if err = deleteOwnedConntrack(lookup.ct, &stale); !errors.Is(err, unix.ENOENT) {
		t.Fatalf("kernel accepted stale conntrack identity: %v", err)
	}
	preserved, err := ct.Get(conntrack.Flow{TupleOrig: captured.TupleOrig})
	if err != nil || preserved.ID != captured.ID {
		t.Fatalf("stale cleanup destroyed replacement flow: %v", err)
	}
	rules(oldPort, "redirect_teardown")
	if err = legacyOwnership(claim, uint16(oldPort), true); err != nil {
		t.Fatal(err)
	}
	old.Shutdown()
	_, nextPort := server("127.0.0.1:0", "100.65.0.2")
	if err = legacyOwnership(claim, uint16(nextPort), false); err != nil {
		t.Fatal(err)
	}
	rules(nextPort, "redirect_apply")
	answer("100.65.0.2")
	journalClient, err := net.DialUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 42003}, &net.UDPAddr{IP: net.ParseIP("127.0.0.2"), Port: 53})
	if err != nil {
		t.Fatal(err)
	}
	defer journalClient.Close()
	journalConn := &dns.Conn{Conn: journalClient}
	e2eQuery(t, journalConn, "journal.example.", dns.TypeA)
	journalPath := filepath.Join(directory, "modern-flows")
	journal, err := openFlowJournal(journalPath, uint16(nextPort))
	if err != nil {
		t.Fatal(err)
	}
	flows, err = ct.Dump(nil)
	if err != nil {
		t.Fatal(err)
	}
	recorded := false
	for _, flow := range flows {
		if flow.TupleOrig.Proto.SourcePort == 42003 {
			if err = journal.record(fromCTTuple(flow.TupleOrig), flow.ID); err != nil {
				t.Fatal(err)
			}
			recorded = true
		}
	}
	if !recorded {
		t.Fatal("journal test flow unavailable")
	}
	if err = journal.close(); err != nil {
		t.Fatal(err)
	}
	rules(nextPort, "redirect_teardown")
	if err = cleanupOwnedFlows(journalPath); err != nil {
		t.Fatal(err)
	}
	if m := e2eQuery(t, journalConn, "journal-restored.example.", dns.TypeA); m.Answer[0].(*dns.A).A.String() != "198.51.100.77" {
		t.Fatal("journal cleanup left same source tuple redirected")
	}
	answer("100.65.0.2") // Exact journal cleanup must not remove this unjournaled flow.
	if err = legacyOwnership(claim, uint16(nextPort), true); err != nil {
		t.Fatal(err)
	}
	answer("198.51.100.77")
	if foreignID() != canary {
		t.Fatal("unrelated conntrack was replaced")
	}
	// A pre-upgrade unmarked redirect is not ours to delete, even at our port.
	_, drainPort := server("127.0.0.1:0", "100.65.0.3")
	kernelCommand(t, "iptables", "-t", "nat", "-A", "OUTPUT", "-p", "udp", "--dport", "53", "-j", "REDIRECT", "--to-ports", strconv.Itoa(drainPort))
	unmarked, err := net.DialUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 42002}, &net.UDPAddr{IP: net.ParseIP("127.0.0.2"), Port: 53})
	if err != nil {
		t.Fatal(err)
	}
	defer unmarked.Close()
	drainConn := &dns.Conn{Conn: unmarked}
	e2eQuery(t, drainConn, "old.example.", dns.TypeA)
	kernelCommand(t, "iptables", "-t", "nat", "-D", "OUTPUT", "-p", "udp", "--dport", "53", "-j", "REDIRECT", "--to-ports", strconv.Itoa(drainPort))
	if err = legacyOwnership(claim, uint16(drainPort), true); err == nil || !strings.Contains(err.Error(), "reconnect-needed") {
		t.Fatalf("unmarked connection was claimed: %v", err)
	}
	if m := e2eQuery(t, drainConn, "draining.example.", dns.TypeA); m.Answer[0].(*dns.A).A.String() != "100.65.0.3" {
		t.Fatal("old listener flow was destroyed")
	}
	if foreignID() != canary {
		t.Fatal("unrelated flow lost during upgrade drain")
	}
}

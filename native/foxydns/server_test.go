package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func contextFixture(t *testing.T) Config {
	t.Helper()
	dir := t.TempDir()
	cfg := Config{Listen: "127.0.0.1:0", Mode: "local", ContextFile: filepath.Join(dir, "context.json"), StateFile: filepath.Join(dir, "state.json")}
	if err := os.WriteFile(cfg.ContextFile, []byte(`{"suffix":"tail.test.ts.net","hosts":[{"ip":"100.65.0.1","name":"nas.tail.test.ts.net","short":"nas"},{"ip":"100.65.0.1","name":"nas.tail.test.ts.net","short":"nas"},{"ip":"fd7a:115c:a1e0::1","name":"nas.tail.test.ts.net","short":"nas"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	return cfg
}

func query(t *testing.T, network, address, name string, typ uint16) *dns.Msg {
	t.Helper()
	q := new(dns.Msg)
	q.SetQuestion(name, typ)
	response, _, err := (&dns.Client{Net: network, Timeout: time.Second}).Exchange(q, address)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func TestContextReplacementAndInvalidation(t *testing.T) {
	cfg := contextFixture(t)
	store := recordStore{path: cfg.ContextFile}
	first, err := store.get()
	if err != nil {
		t.Fatal(err)
	}
	stat, _ := os.Stat(cfg.ContextFile)
	data, _ := os.ReadFile(cfg.ContextFile)
	data = []byte(strings.ReplaceAll(string(data), "nas", "new"))
	replacement := cfg.ContextFile + ".next"
	if err = os.WriteFile(replacement, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(replacement, stat.ModTime(), stat.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(replacement, cfg.ContextFile); err != nil {
		t.Fatal(err)
	}
	next, err := store.get()
	if err != nil {
		t.Fatal(err)
	}
	if next == first || next.hosts["nas."] != nil || len(next.hosts["new."]) != 2 {
		t.Fatal("atomic same-mtime update reused stale identity")
	}
	if err = os.WriteFile(cfg.ContextFile, []byte(`{"suffix":""}`), 0600); err != nil {
		t.Fatal(err)
	}
	if records, err := store.get(); err == nil || records != nil {
		t.Fatal("invalid context retained prior account")
	}
}

// The control socket lives beside StateFile; keep its path inside the unix
// socket sun_path limit on every platform's t.TempDir layout.
func shortStateFile(t *testing.T, cfg *Config) {
	t.Helper()
	dir, err := os.MkdirTemp("", "fdns-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	cfg.StateFile = filepath.Join(dir, "state")
}

type fakeFlowLookup struct {
	flow  FlowContext
	err   error
	calls int
}

func (f *fakeFlowLookup) Lookup(string, net.Addr, net.Addr) (FlowContext, error) {
	f.calls++
	return f.flow, f.err
}

type responseSink struct {
	msg     *dns.Msg
	network string
}

func (s *responseSink) LocalAddr() net.Addr {
	if s.network == "udp" {
		return &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1054}
	}
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1054}
}
func (s *responseSink) RemoteAddr() net.Addr {
	if s.network == "udp" {
		return &net.UDPAddr{IP: net.IPv4(100, 65, 0, 1), Port: 53000}
	}
	return &net.TCPAddr{IP: net.IPv4(100, 65, 0, 1), Port: 53000}
}
func (s *responseSink) WriteMsg(m *dns.Msg) error   { s.msg = m; return nil }
func (s *responseSink) Write(p []byte) (int, error) { return 0, errors.New("unexpected raw response") }
func (*responseSink) Close() error                  { return nil }
func (*responseSink) TsigStatus() error             { return nil }
func (*responseSink) TsigTimersOnly(bool)           {}
func (*responseSink) Hijack()                       {}

func validTestFlow() FlowContext {
	return FlowContext{OriginalSource: netip.MustParseAddrPort("100.65.0.1:53000"), OriginalDestination: netip.MustParseAddrPort("192.0.2.53:53"), UID: 10123, Mark: 0x1234, OutIfIndex: 1, InterfaceName: "test-vpn", protocol: 17, validate: func() error { return nil }}
}

func TestForwardUsesExactContextAndPreservesResolverResponse(t *testing.T) {
	for _, network := range []string{"udp", "tcp"} {
		t.Run(network, func(t *testing.T) {
			cfg := contextFixture(t)
			flow := validTestFlow()
			if network == "tcp" {
				flow.protocol = 6
			}
			var server *dns.Server
			handler := dns.HandlerFunc(func(w dns.ResponseWriter, q *dns.Msg) {
				m := new(dns.Msg)
				m.SetRcode(q, dns.RcodeRefused)
				m.AuthenticatedData = true
				m.Truncated = true
				m.Question[0].Name = strings.ToLower(m.Question[0].Name)
				_ = w.WriteMsg(m)
			})
			var address string
			if network == "udp" {
				p, err := net.ListenPacket("udp4", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				server = &dns.Server{PacketConn: p, Handler: handler}
				address = p.LocalAddr().String()
			} else {
				l, err := net.Listen("tcp4", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				server = &dns.Server{Listener: l, Handler: handler}
				address = l.Addr().String()
			}
			started := make(chan struct{})
			server.NotifyStartedFunc = func() { close(started) }
			go func() { _ = server.ActivateAndServe() }()
			<-started
			defer server.Shutdown()
			lookup := &fakeFlowLookup{flow: flow}
			dials := 0
			r := resolver{records: &recordStore{path: cfg.ContextFile}, transport: lookup, slots: make(chan struct{}, 1), dial: func(ctx context.Context, n string, f FlowContext) (net.Conn, error) {
				dials++
				if n != network || f.UID != flow.UID || f.Mark != flow.Mark || f.OriginalDestination != flow.OriginalDestination || f.InterfaceName != flow.InterfaceName {
					t.Error("original routing context changed")
				}
				return (&net.Dialer{}).DialContext(ctx, n, address)
			}}
			q := new(dns.Msg)
			q.SetQuestion("Public.Example.", dns.TypeA)
			w := &responseSink{network: network}
			r.ServeDNS(w, q)
			if w.msg == nil || w.msg.Rcode != dns.RcodeRefused || !w.msg.AuthenticatedData || !w.msg.Truncated || dials != 1 || lookup.calls != 1 || r.forwarded.Load() != 1 {
				t.Fatalf("response changed: %v dials=%d", w.msg, dials)
			}
		})
	}
}

func TestNoFallbackWhenOriginalContextUnavailable(t *testing.T) {
	cfg := contextFixture(t)
	for _, problem := range []string{"lookup", "invalid", "dial", "capacity", "bad-context"} {
		t.Run(problem, func(t *testing.T) {
			lookup := &fakeFlowLookup{flow: validTestFlow()}
			dials := 0
			r := resolver{records: &recordStore{path: cfg.ContextFile}, transport: lookup, slots: make(chan struct{}, 1), dial: func(context.Context, string, FlowContext) (net.Conn, error) {
				dials++
				return nil, errors.New("original network unavailable")
			}}
			switch problem {
			case "lookup":
				lookup.err = ErrFlowContext
			case "invalid":
				lookup.flow = FlowContext{}
			case "capacity":
				r.slots <- struct{}{}
			case "bad-context":
				r.records.path = "/missing-context"
			}
			q := new(dns.Msg)
			q.SetQuestion("public.example.", dns.TypeA)
			w := &responseSink{network: "udp"}
			r.ServeDNS(w, q)
			if w.msg == nil || w.msg.Rcode != dns.RcodeServerFailure {
				t.Fatal(w.msg)
			}
			expected := 0
			if problem == "dial" {
				expected = 1
			}
			if dials != expected {
				t.Fatalf("unexpected fallback dial: %d", dials)
			}
		})
	}
}

type failingQueue struct{ calls int }

func (f *failingQueue) Health() error { return nil }
func (f *failingQueue) Close() error {
	f.calls++
	return errors.New("closeOnce cached failure")
}

// The SIGTERM path used to retry a failing cleanup on every signal forever.
// It now reports to stderr and exits non-zero after a few attempts.
func TestServeTerminatesAfterBoundedCleanupRetries(t *testing.T) {
	cfg := contextFixture(t)
	cfg.Mode, cfg.Queue = "transparent", 1053
	shortStateFile(t, &cfg)
	cfg.OwnershipFile = filepath.Join(t.TempDir(), "flows.jsonl")
	configPath := filepath.Join(t.TempDir(), "foxydns.json")
	body := fmt.Sprintf(`{"Listen":"127.0.0.1:0","Mode":"transparent","Queue":1053,"ContextFile":%q,"StateFile":%q,"OwnershipFile":%q}`, cfg.ContextFile, cfg.StateFile, cfg.OwnershipFile)
	if err := os.WriteFile(configPath, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	original := cleanupOwned
	defer func() { cleanupOwned = original }()
	cleanupCalls := 0
	cleanupOwned = func(string) error { cleanupCalls++; return errors.New("conntrack unavailable") }
	done := make(chan error, 1)
	go func() { done <- run([]string{"serve", "--config", configPath}) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(cfg.StateFile); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("serve exited early: %v", err)
		case <-time.After(10 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			t.Fatal("service did not start")
		}
	}
	self, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if err = self.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err == nil {
			t.Fatal("failing cleanup exited successfully")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("failing cleanup made SIGTERM unkillable")
	}
	if cleanupCalls != 3 || time.Since(started) > 5*time.Second {
		t.Fatalf("cleanup retried unboundedly: calls=%d elapsed=%s", cleanupCalls, time.Since(started))
	}
}

type statQueue struct{}

func (statQueue) Health() error                   { return nil }
func (statQueue) Close() error                    { return nil }
func (statQueue) Stats() (uint64, uint64, uint64) { return 2, 40, 7 }

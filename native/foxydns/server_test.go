package main

import (
	"context"
	"encoding/json"
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

func TestLocalEndpointUDPAndTCP(t *testing.T) {
	cfg := contextFixture(t)
	s, err := startService(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	addr := s.servers[0].Listener.Addr().String()
	ptr, _ := dns.ReverseAddr("fd7a:115c:a1e0::1")
	for _, network := range []string{"udp", "tcp"} {
		for _, tc := range []struct {
			name          string
			typ           uint16
			code, answers int
		}{
			{"NaS.tail.test.ts.net.", dns.TypeA, 0, 1}, {"nas.", dns.TypeAAAA, 0, 1},
			{ptr, dns.TypePTR, 0, 1}, {"nas.", dns.TypeTXT, 0, 0},
			{"missing.tail.test.ts.net.", dns.TypeA, dns.RcodeNameError, 0},
			{"public.example.", dns.TypeA, dns.RcodeRefused, 0},
			{"unknownshort.", dns.TypeA, dns.RcodeRefused, 0},
		} {
			r := query(t, network, addr, tc.name, tc.typ)
			if r.Rcode != tc.code || len(r.Answer) != tc.answers {
				t.Fatalf("%s %s: %v", network, tc.name, r)
			}
		}
	}
	state, err := os.ReadFile(cfg.StateFile)
	if err != nil {
		t.Fatal(err)
	}
	var values map[string]any
	if err = json.Unmarshal(state, &values); err != nil {
		t.Fatal(err)
	}
	if values["ready"] != true || values["queueReady"] != false {
		t.Fatalf("unexpected state: %s", state)
	}
	s.Close()
	state, _ = os.ReadFile(cfg.StateFile)
	_ = json.Unmarshal(state, &values)
	if values["ready"] != false {
		t.Fatalf("stale ready state: %s", state)
	}
	cfg.Listen = addr
	reopened, err := startService(cfg)
	if err != nil {
		t.Fatalf("listener leaked after stop: %v", err)
	}
	reopened.Close()
}

func TestTCPConnectionSupportsMultipleQueries(t *testing.T) {
	s, err := startService(contextFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	conn, err := dns.DialTimeout("tcp", s.servers[0].Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(time.Second))
	for _, name := range []string{"nas.", "public.example.", "nas.tail.test.ts.net."} {
		q := new(dns.Msg)
		q.SetQuestion(name, dns.TypeA)
		if err := conn.WriteMsg(q); err != nil {
			t.Fatal(err)
		}
		r, err := conn.ReadMsg()
		if err != nil || r.Id != q.Id {
			t.Fatalf("multiquery: %v %v", r, err)
		}
	}
}

func TestBindConflictDoesNotWriteReadyState(t *testing.T) {
	cfg := contextFixture(t)
	s, err := startService(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	other := contextFixture(t)
	other.Listen = s.servers[0].Listener.Addr().String()
	if _, err := startService(other); err == nil {
		t.Fatal("port conflict accepted")
	}
	if _, err := os.Stat(other.StateFile); !os.IsNotExist(err) {
		t.Fatal("failed listener wrote state")
	}
	if r := query(t, "udp", other.Listen, "nas.", dns.TypeA); r.Rcode != 0 {
		t.Fatal(r)
	}
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

func TestConfigAndContextValidation(t *testing.T) {
	cfg := contextFixture(t)
	for _, body := range []string{`null`, `{}`, `{"Listen":"0.0.0.0:1053","Mode":"local","ContextFile":"/tmp/context"}`, `{"Listen":"127.0.0.1:1053","Mode":"local","ContextFile":"/tmp/context","publicFallback":"1.1.1.1"}`} {
		path := filepath.Join(t.TempDir(), "config.json")
		_ = os.WriteFile(path, []byte(body), 0600)
		if _, err := readConfig(path); err == nil {
			t.Fatalf("accepted %s", body)
		}
	}
	for _, body := range []string{`{"suffix":"tail.test.ts.net","hosts":[{"ip":"100.64.0.1","name":"nas.evil.test","short":"nas"}]}`, `{"suffix":"tail.test.ts.net","hosts":[{"ip":"::","name":"nas.tail.test.ts.net","short":"nas"}]}`, `{"suffix":"tail.test.ts.net","hosts":[{"ip":"100.64.0.1","name":"nas.tail.test.ts.net","short":"other"}]}`} {
		_ = os.WriteFile(cfg.ContextFile, []byte(body), 0600)
		if _, err := loadRecords(cfg.ContextFile); err == nil {
			t.Fatalf("accepted %s", body)
		}
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

// A failing NFQUEUE open returns a typed nil *Selector. Storing it in the
// captureQueue interface used to nil-deref health and Close; the service must
// instead start degraded with the queue error reported.
func TestHijackQueueFailureDegradesWithoutPanic(t *testing.T) {
	original := newSelector
	newSelector = func(uint16, *recordStore) (*Selector, error) {
		return nil, errors.New("NFQUEUE unavailable")
	}
	defer func() { newSelector = original }()
	cfg := contextFixture(t)
	cfg.Mode, cfg.Queue = "hijack", 1053
	shortStateFile(t, &cfg)
	s, err := startService(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.interceptor != nil || s.queueError == nil {
		t.Fatal("failed queue must be reported as an error, not stored")
	}
	state := s.healthState()
	if state.QueueReady || state.Error == "" {
		t.Fatalf("degraded queue not surfaced in health: %+v", state)
	}
	if r := query(t, "udp", s.servers[0].Listener.Addr().String(), "nas.", dns.TypeA); r.Rcode != 0 || len(r.Answer) != 1 {
		t.Fatalf("degraded queue took the local endpoint down: %v", r)
	}
	s.Close()
	if after := s.healthState(); after.Ready {
		t.Fatal("closed service still reports ready")
	}
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

func TestMalformedQuestionAndTruncation(t *testing.T) {
	cfg := contextFixture(t)
	r := resolver{records: &recordStore{path: cfg.ContextFile}, slots: make(chan struct{}, 1)}
	for _, q := range []*dns.Msg{{}, {Question: []dns.Question{{Name: "nas.", Qtype: 1, Qclass: 3}}}, {Question: []dns.Question{{Name: "nas.", Qtype: 1, Qclass: 1}, {Name: "nas.", Qtype: 28, Qclass: 1}}}} {
		w := &responseSink{network: "udp"}
		r.ServeDNS(w, q)
		if w.msg.Rcode != dns.RcodeFormatError {
			t.Fatal(w.msg)
		}
	}
	largeContext := tailnetContext{Suffix: "tail.test.ts.net"}
	for i := 1; i < 200; i++ {
		largeContext.Hosts = append(largeContext.Hosts, struct{ IP, Name, Short string }{
			IP:   netip.AddrFrom4([4]byte{100, 64, 1, byte(i)}).String(),
			Name: "nas.tail.test.ts.net", Short: "nas",
		})
	}
	data, err := json.Marshal(largeContext)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(cfg.ContextFile, data, 0600); err != nil {
		t.Fatal(err)
	}
	q := new(dns.Msg)
	q.SetQuestion("nas.", dns.TypeA)
	w := &responseSink{network: "udp"}
	r.ServeDNS(w, q)
	if !w.msg.Truncated || w.msg.Len() > dns.MinMsgSize {
		t.Fatalf("oversized UDP response: %d", w.msg.Len())
	}
}

type failingQueue struct{ calls int }

func (f *failingQueue) Health() error { return nil }
func (f *failingQueue) Close() error {
	f.calls++
	return errors.New("closeOnce cached failure")
}

// A deterministically failing quiesce (closeOnce caches the error) used to
// make every SIGTERM retry forever. The drain must give up bounded and loud.
func TestShutdownCaptureRetriesBoundedly(t *testing.T) {
	original := cleanupOwned
	defer func() { cleanupOwned = original }()
	cleanupCalls := 0
	cleanupOwned = func(string) error { cleanupCalls++; return nil }
	queue := &failingQueue{}
	s := &service{cfg: Config{Mode: "transparent"}, interceptor: queue}
	started := time.Now()
	if err := s.shutdownCapture(); err == nil || queue.calls != 3 || cleanupCalls != 0 {
		t.Fatalf("deterministic quiesce failure must stop retrying: calls=%d cleanup=%d err=%v", queue.calls, cleanupCalls, err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("bounded shutdown exceeded its budget: %s", elapsed)
	}

	cleanupCalls = 0
	cleanupOwned = func(string) error { cleanupCalls++; return errors.New("conntrack unavailable") }
	s = &service{cfg: Config{Mode: "transparent"}}
	if err := s.shutdownCapture(); err == nil || cleanupCalls != 3 {
		t.Fatalf("deterministic cleanup failure must stop retrying: cleanup=%d err=%v", cleanupCalls, err)
	}

	cleanupCalls = 0
	cleanupOwned = func(string) error { cleanupCalls++; return nil }
	if err := s.shutdownCapture(); err != nil || cleanupCalls != 1 {
		t.Fatalf("clean drain must succeed on the first attempt: cleanup=%d err=%v", cleanupCalls, err)
	}
}

// serve honors --queue as an override of the config's queue number instead of
// silently ignoring it.
func TestServeQueueFlagOverridesConfig(t *testing.T) {
	cfg := contextFixture(t)
	cfg.Mode, cfg.Queue = "hijack", 1053
	shortStateFile(t, &cfg)
	configPath := filepath.Join(t.TempDir(), "foxydns.json")
	body := fmt.Sprintf(`{"Listen":"127.0.0.1:0","Mode":"hijack","Queue":1053,"ContextFile":%q,"StateFile":%q}`, cfg.ContextFile, cfg.StateFile)
	if err := os.WriteFile(configPath, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	original := newSelector
	defer func() { newSelector = original }()
	queues := make(chan uint16, 1)
	newSelector = func(queue uint16, _ *recordStore) (*Selector, error) {
		queues <- queue
		return nil, errors.New("NFQUEUE unavailable")
	}
	done := make(chan error, 1)
	go func() { done <- run([]string{"serve", "--config", configPath, "--queue", "1054"}) }()
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
	if err = self.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err != nil {
			t.Fatalf("hijack-mode SIGTERM failed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("SIGTERM did not stop serve")
	}
	if got := <-queues; got != 1054 {
		t.Fatalf("--queue was ignored; service used queue %d", got)
	}
	for _, args := range [][]string{
		{"serve", "--config", configPath, "--queue", "0"},
		{"serve", "--config", configPath, "--queue", "70000"},
		{"check", "--config", configPath, "--queue", "0"},
	} {
		if err := run(args); err == nil {
			t.Fatalf("accepted out-of-range queue flag: %v", args)
		}
	}
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

// The selector's passed-through count was counted but never surfaced; keep it
// additive in the state JSON.
func TestHealthStateSurfacesPassedAnswers(t *testing.T) {
	s := &service{cfg: Config{Mode: "hijack"}, interceptor: statQueue{}, resolver: &resolver{}}
	s.ready.Store(true)
	state := s.healthState()
	if state.Passed != 40 || state.LocalAnswers != 2 || state.Failed != 7 {
		t.Fatalf("selector counters lost: %+v", state)
	}
	data, err := json.Marshal(state)
	if err != nil || !strings.Contains(string(data), `"passed":40`) {
		t.Fatalf("passed count missing from state JSON: %s", data)
	}
}

func TestTailnetRecordsRejectNonRoutableHostAddresses(t *testing.T) {
	cfg := contextFixture(t)
	for _, ip := range []string{"0.0.0.0", "::", "224.0.0.1", "ff02::1", "127.0.0.1", "::1", "169.254.7.1", "fe80::1"} {
		body := fmt.Sprintf(`{"suffix":"tail.test.ts.net","hosts":[{"ip":%q,"name":"nas.tail.test.ts.net","short":"nas"}]}`, ip)
		if err := os.WriteFile(cfg.ContextFile, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadRecords(cfg.ContextFile); err == nil {
			t.Fatalf("accepted non-routable Tailnet host %s", ip)
		}
	}
}

// The several fail-closed gates before the upstream dial must share a single
// kernel re-verification; the write path then performs one fresh check.
func TestFlowContextSharesOneValidationBeforeWrite(t *testing.T) {
	calls := 0
	verify := &flowVerify{validate: func() error { calls++; return nil }}
	f := validTestFlow()
	f.validate = verify.cached
	f.revalidate = verify.validate
	for range 4 {
		if err := f.check(); err != nil || calls != 1 {
			t.Fatalf("dial-path gates must share one validation: calls=%d err=%v", calls, err)
		}
	}
	if err := f.recheck(); err != nil || calls != 2 {
		t.Fatalf("write must perform one fresh validation: calls=%d err=%v", calls, err)
	}
	if err := f.recheck(); err != nil || calls != 3 {
		t.Fatalf("each write revalidates: calls=%d err=%v", calls, err)
	}
	f.revalidate = nil
	if err := f.recheck(); err != nil || calls != 3 {
		t.Fatalf("recheck must fall back to the cached validator: calls=%d err=%v", calls, err)
	}

	calls = 0
	broken := &flowVerify{validate: func() error { calls++; return ErrFlowContext }}
	f.validate = broken.cached
	if err := f.check(); err == nil {
		t.Fatal("failed validation must reject")
	}
	if err := f.check(); err == nil || calls != 2 {
		t.Fatalf("a failed validation must not latch as success: calls=%d", calls)
	}
}

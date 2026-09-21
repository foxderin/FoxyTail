package main

import (
	"context"
	"errors"
	"net"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/miekg/dns"
)

type reviewUDPReader struct {
	dns.Reader
	timeouts chan<- time.Duration
}

func (r reviewUDPReader) ReadUDP(conn *net.UDPConn, timeout time.Duration) ([]byte, *dns.SessionUDP, error) {
	r.timeouts <- timeout
	return r.Reader.ReadUDP(conn, timeout)
}

func TestReviewUDPIdleDeadlineAllowsQueriesAndPromptShutdown(t *testing.T) {
	cfg := contextFixture(t)
	s := &service{resolver: &resolver{records: &recordStore{path: cfg.ContextFile}, slots: make(chan struct{}, 1)}}
	if err := s.bind("tcp4", "udp4", cfg.Listen); err != nil {
		t.Fatal(err)
	}
	defer s.closeListeners()
	server := s.servers[1]
	timeouts := make(chan time.Duration, 4)
	server.DecorateReader = func(reader dns.Reader) dns.Reader { return reviewUDPReader{reader, timeouts} }
	done := make(chan error, 1)
	go func() { done <- server.ActivateAndServe() }()
	defer server.Shutdown()
	// Observe the timeout used by the real UDP reader, without sleeping past
	// the old five-second deadline. Check both initial and post-query reads.
	for n := 0; n < 2; n++ {
		select {
		case timeout := <-timeouts:
			if timeout < time.Minute {
				t.Fatalf("UDP reader still schedules frequent idle wakeups: %s", timeout)
			}
		case <-time.After(time.Second):
			t.Fatal("UDP reader did not start")
		}
		if n == 0 {
			response := query(t, "udp", server.PacketConn.LocalAddr().String(), "nas.", dns.TypeA)
			if response.Rcode != dns.RcodeSuccess || len(response.Answer) != 1 {
				t.Fatalf("UDP query failed with long idle deadline: %v", response)
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := server.ShutdownContext(ctx); err != nil {
		t.Fatalf("shutdown did not interrupt the idle UDP read: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

type reviewSlowLookup struct {
	started chan struct{}
}

func (l *reviewSlowLookup) Lookup(string, net.Addr, net.Addr) (FlowContext, error) {
	close(l.started)
	// Model the kernel lookup's one-second deadline before an upstream dial.
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	<-timer.C
	flow := validTestFlow()
	flow.protocol = 6
	return flow, nil
}

func TestReviewServiceCloseBoundsInFlightTCPWork(t *testing.T) {
	s, err := startService(contextFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lookup := &reviewSlowLookup{started: make(chan struct{})}
	s.resolver.transport = lookup
	s.resolver.dial = func(ctx context.Context, _ string, _ FlowContext) (net.Conn, error) {
		<-ctx.Done() // Exercise the actual five-second upstream deadline.
		return nil, ctx.Err()
	}
	clientDone := make(chan error, 1)
	go func() {
		q := new(dns.Msg)
		q.SetQuestion("public.example.", dns.TypeA)
		_, _, err := (&dns.Client{Net: "tcp", Timeout: 7 * time.Second}).Exchange(q, s.servers[0].Listener.Addr().String())
		clientDone <- err
	}()
	select {
	case <-lookup.started:
	case <-time.After(time.Second):
		t.Fatal("TCP request did not reach the original-context lookup")
	}
	stopped := make(chan struct{})
	go func() { s.Close(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(7 * time.Second):
		t.Fatal("service shutdown exceeded bounded lookup plus upstream deadlines")
	}
	if err := <-clientDone; err == nil {
		t.Fatal("shutdown TCP client unexpectedly received a successful response")
	}
}

type reviewWriteConn struct {
	net.Conn
	deadline    time.Time
	deadlineErr error
	writes      int
}

func (c *reviewWriteConn) SetWriteDeadline(deadline time.Time) error {
	c.deadline = deadline
	return c.deadlineErr
}

func (c *reviewWriteConn) Write(data []byte) (int, error) {
	c.writes++
	return len(data), nil
}

func TestReviewTCPResponseWriteEnforcesDeadline(t *testing.T) {
	fake := &reviewWriteConn{}
	conn := &boundedConn{Conn: fake}
	before := time.Now()
	if n, err := conn.Write([]byte("DNS response")); err != nil || n != 12 {
		t.Fatalf("write: n=%d err=%v", n, err)
	}
	if fake.deadline.Before(before.Add(5*time.Second)) || fake.deadline.After(time.Now().Add(5*time.Second)) {
		t.Fatalf("response write has no bounded deadline: %s", fake.deadline)
	}
	fake.deadlineErr = errors.New("socket deadline unavailable")
	if _, err := conn.Write([]byte("second response")); err == nil || fake.writes != 1 {
		t.Fatal("write continued after failing to enforce its deadline")
	}
}

func TestReviewListenerCloseClosesAcceptedSockets(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	bounded := &boundedListener{Listener: listener, slots: make(chan struct{}, 1)}
	defer bounded.Close()
	client, err := net.DialTimeout("tcp4", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	accepted, err := bounded.Accept()
	if err != nil {
		t.Fatal(err)
	}
	if err = bounded.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = accepted.Write([]byte("late response")); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("accepted socket survived listener shutdown: %v", err)
	}
	if err = accepted.Close(); err != nil {
		t.Fatal(err)
	}
	if len(bounded.slots) != 0 || len(bounded.active) != 0 {
		t.Fatal("shutdown retained an accepted connection or capacity slot")
	}
	if _, err = bounded.Accept(); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("shutdown listener still accepts sockets: %v", err)
	}
}

type blockedReviewLookup struct {
	events  chan string
	release chan struct{}
}

func (b *blockedReviewLookup) Lookup(string, net.Addr, net.Addr) (FlowContext, error) {
	b.events <- "lookup"
	<-b.release
	return FlowContext{}, ErrFlowContext
}

func TestReviewCapacityBoundsOriginalContextLookup(t *testing.T) {
	const requests = 16
	cfg := contextFixture(t)
	lookup := &blockedReviewLookup{events: make(chan string, requests*2), release: make(chan struct{})}
	r := &resolver{records: &recordStore{path: cfg.ContextFile}, transport: lookup, slots: make(chan struct{}, 1)}
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range requests {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			q := new(dns.Msg)
			q.SetQuestion("public.example.", dns.TypeA)
			r.ServeDNS(&responseSink{network: "udp"}, q)
			lookup.events <- "done"
		}()
	}
	defer func() { close(lookup.release); wg.Wait() }()
	close(start)
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	lookups := 0
	// Every request must either reach the held lookup or finish at the limit.
	// No sleeps or scheduler assumptions are needed to count concurrent work.
	for range requests {
		select {
		case event := <-lookup.events:
			if event == "lookup" {
				lookups++
			}
		case <-deadline.C:
			t.Fatal("requests did not reach the lookup or capacity boundary")
		}
	}
	if lookups != 1 {
		t.Fatalf("capacity=1 allowed %d concurrent original-context lookups", lookups)
	}
}

func TestReviewRemovedContextStopsOldAnswersImmediately(t *testing.T) {
	cfg := contextFixture(t)
	store := &recordStore{path: cfg.ContextFile}
	if _, err := store.get(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(cfg.ContextFile); err != nil {
		t.Fatal(err)
	}
	if old, err := store.get(); old != nil || err == nil {
		t.Fatal("removed account context still returns cached records")
	}
}

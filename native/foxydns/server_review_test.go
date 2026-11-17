package main

import (
	"context"
	"net"
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

type blockedReviewLookup struct {
	events  chan string
	release chan struct{}
}

func (b *blockedReviewLookup) Lookup(string, net.Addr, net.Addr) (FlowContext, error) {
	b.events <- "lookup"
	<-b.release
	return FlowContext{}, ErrFlowContext
}

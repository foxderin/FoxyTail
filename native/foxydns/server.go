package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
)

type originalTransport interface {
	Lookup(string, net.Addr, net.Addr) (FlowContext, error)
}

type resolver struct {
	records                  *recordStore
	transport                originalTransport
	dial                     func(context.Context, string, FlowContext) (net.Conn, error)
	slots                    chan struct{}
	local, forwarded, failed atomic.Uint64
	health                   func() healthState
}

func (r *resolver) ServeDNS(w dns.ResponseWriter, q *dns.Msg) {
	if r.serveHealth(w, q) {
		return
	}
	if q.Response || q.Opcode != dns.OpcodeQuery || len(q.Question) != 1 || q.Question[0].Qclass != dns.ClassINET {
		r.fail(w, q, dns.RcodeFormatError)
		return
	}
	// Bound all potentially blocking work, including record reloads and kernel
	// conntrack lookups. Limiting only outbound dials leaves those earlier stages
	// free to accumulate an unbounded number of UDP handler goroutines.
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	default:
		r.fail(w, q, dns.RcodeServerFailure)
		return
	}
	records, err := r.records.get()
	if err != nil {
		// A stale identity must neither answer the old Tailnet nor leak its names
		// to an unrelated upstream while the lifecycle replaces its context.
		r.fail(w, q, dns.RcodeServerFailure)
		return
	}
	if response, local := records.answer(q); local {
		if _, udp := w.RemoteAddr().(*net.UDPAddr); udp {
			size := uint16(dns.MinMsgSize)
			if opt := q.IsEdns0(); opt != nil && opt.UDPSize() > size {
				size = opt.UDPSize()
			}
			if size > 4096 {
				size = 4096
			}
			response.Truncate(int(size))
		}
		r.local.Add(1)
		_ = w.WriteMsg(response)
		return
	}
	if r.transport == nil {
		r.fail(w, q, dns.RcodeRefused)
		return
	}
	network := "tcp"
	if _, udp := w.RemoteAddr().(*net.UDPAddr); udp {
		network = "udp"
	}
	flow, err := r.transport.Lookup(network, w.LocalAddr(), w.RemoteAddr())
	if err != nil || !flow.Valid() {
		r.fail(w, q, dns.RcodeServerFailure)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := r.dial(ctx, network, flow)
	if err != nil {
		r.fail(w, q, dns.RcodeServerFailure)
		return
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	if err = conn.SetDeadline(deadline); err != nil {
		r.fail(w, q, dns.RcodeServerFailure)
		return
	}
	upstream := &dns.Conn{Conn: conn, UDPSize: 65535}
	if err = upstream.WriteMsg(q); err != nil {
		r.fail(w, q, dns.RcodeServerFailure)
		return
	}
	response, err := upstream.ReadMsg()
	if err != nil || !response.Response || response.Id != q.Id || len(response.Question) != 1 ||
		!strings.EqualFold(response.Question[0].Name, q.Question[0].Name) ||
		response.Question[0].Qtype != q.Question[0].Qtype || response.Question[0].Qclass != q.Question[0].Qclass {
		r.fail(w, q, dns.RcodeServerFailure)
		return
	}
	// Keep the original resolver's response, including errors, TC and DNSSEC
	// flags. Do not retry another address or silently change UDP into TCP.
	r.forwarded.Add(1)
	_ = w.WriteMsg(response)
}

func (r *resolver) fail(w dns.ResponseWriter, q *dns.Msg, code int) {
	r.failed.Add(1)
	m := new(dns.Msg)
	m.SetRcode(q, code)
	_ = w.WriteMsg(m)
}

type service struct {
	cfg         Config
	port        int
	resolver    *resolver
	interceptor *Interceptor
	queueError  error
	servers     []*dns.Server
	closers     []interface{ Close() error }
	errors      chan error
	once        sync.Once
	wg          sync.WaitGroup
	stateMu     sync.Mutex
	ready       atomic.Bool
	instance    string
}

// All listeners are bound before any transparent queue is claimed. A port
// conflict must never leave native DNS disabled or half of a server running.
func startService(cfg Config) (*service, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	if _, err := loadRecords(cfg.ContextFile); err != nil {
		return nil, err
	}
	s := &service{cfg: cfg, errors: make(chan error, 5), instance: rand.Text()}
	s.resolver = &resolver{records: &recordStore{path: cfg.ContextFile}, dial: DialOriginal, slots: make(chan struct{}, 64)}
	s.resolver.health = s.healthState
	if err := s.bind("tcp4", "udp4", cfg.Listen); err != nil {
		s.closeListeners()
		return nil, err
	}
	if cfg.IPv6 {
		if err := s.bind("tcp6", "udp6", net.JoinHostPort("::1", strconv.Itoa(s.port))); err != nil {
			s.closeListeners()
			return nil, err
		}
	}
	if cfg.Mode == "transparent" {
		s.interceptor, s.queueError = NewInterceptor(cfg.Queue)
		if s.interceptor != nil {
			s.resolver.transport = s.interceptor
		}
	}
	ready := make(chan struct{}, len(s.servers))
	for _, server := range s.servers {
		server.NotifyStartedFunc = func() { ready <- struct{}{} }
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			if err := server.ActivateAndServe(); err != nil {
				s.ready.Store(false)
				select {
				case s.errors <- err:
				default:
				}
			}
		}()
	}
	for range s.servers {
		select {
		case <-ready:
		case err := <-s.errors:
			s.Close()
			return nil, err
		case <-time.After(3 * time.Second):
			s.Close()
			return nil, errors.New("DNS listener startup timed out")
		}
	}
	s.ready.Store(true)
	if err := s.writeState(true); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

func (s *service) bind(tcp, udp, address string) error {
	listener, err := net.Listen(tcp, address)
	if err != nil {
		return fmt.Errorf("bind DNS %s: %w", tcp, err)
	}
	bounded := &boundedListener{Listener: listener, slots: make(chan struct{}, 128)}
	s.closers = append(s.closers, bounded)
	if s.port == 0 {
		s.port = listener.Addr().(*net.TCPAddr).Port
	}
	host, _, _ := net.SplitHostPort(address)
	packet, err := net.ListenPacket(udp, net.JoinHostPort(host, strconv.Itoa(s.port)))
	if err != nil {
		return fmt.Errorf("bind DNS %s: %w", udp, err)
	}
	s.closers = append(s.closers, packet)
	s.servers = append(s.servers,
		&dns.Server{Listener: bounded, Handler: s.resolver, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: func() time.Duration { return 15 * time.Second }, MaxTCPQueries: 128},
		&dns.Server{PacketConn: packet, Handler: s.resolver, UDPSize: 65535, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second},
	)
	return nil
}

func (s *service) healthState() healthState {
	ready := s.ready.Load()
	queueError := s.queueError
	queueReady := false
	if s.interceptor != nil {
		queueError = s.interceptor.Health()
		queueReady = queueError == nil
	}
	state := healthState{
		Ready: ready, PID: os.Getpid(), Instance: s.instance, Mode: s.cfg.Mode, Port: s.port,
		IPv6ListenerReady: ready && s.cfg.IPv6, QueueReady: ready && queueReady,
		UpdatedAt: time.Now().Unix(), LocalAnswers: s.resolver.local.Load(),
		Forwarded: s.resolver.forwarded.Load(), Failed: s.resolver.failed.Load(),
	}
	if queueError != nil {
		state.Error = queueError.Error()
	}
	return state
}

func (s *service) writeState(ready bool) error {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	state := s.healthState()
	state.Ready, state.IPv6ListenerReady, state.QueueReady = ready, ready && s.cfg.IPv6, ready && state.QueueReady
	return writeJSON(s.cfg.StateFile, state)
}

func (s *service) closeListeners() {
	for _, closer := range s.closers {
		_ = closer.Close()
	}
}

func (s *service) Close() {
	s.once.Do(func() {
		s.ready.Store(false)
		if s.interceptor != nil {
			_ = s.interceptor.Close()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		for _, server := range s.servers {
			_ = server.ShutdownContext(ctx)
		}
		s.closeListeners()
		s.wg.Wait()
		_ = s.writeState(false)
	})
}

type boundedListener struct {
	net.Listener
	slots  chan struct{}
	mu     sync.Mutex
	active map[*boundedConn]struct{}
	closed bool
}
type boundedConn struct {
	net.Conn
	owner *boundedListener
	once  sync.Once
}

func (l *boundedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case l.slots <- struct{}{}:
			l.mu.Lock()
			if l.closed {
				l.mu.Unlock()
				_ = conn.Close()
				<-l.slots
				return nil, net.ErrClosed
			}
			if l.active == nil {
				l.active = make(map[*boundedConn]struct{})
			}
			bounded := &boundedConn{Conn: conn, owner: l}
			l.active[bounded] = struct{}{}
			l.mu.Unlock()
			return bounded, nil
		default:
			_ = conn.Close()
		}
	}
}

func (l *boundedListener) Close() error {
	err := l.Listener.Close()
	l.mu.Lock()
	l.closed = true
	connections := make([]*boundedConn, 0, len(l.active))
	for conn := range l.active {
		connections = append(connections, conn)
	}
	l.mu.Unlock()
	// dns.Server.ShutdownContext only interrupts reads on accepted sockets.
	// Closing them also interrupts a blocked write and releases every slot.
	for _, conn := range connections {
		_ = conn.Close()
	}
	return err
}

func (c *boundedConn) Write(data []byte) (int, error) {
	// miekg/dns v1.1.73 does not apply its Server.WriteTimeout field. Enforce
	// a deadline here so a slow reader cannot keep a handler alive indefinitely.
	if err := c.Conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return 0, err
	}
	return c.Conn.Write(data)
}

func (c *boundedConn) Close() error {
	var err error
	c.once.Do(func() {
		err = c.Conn.Close()
		if c.owner != nil {
			c.owner.mu.Lock()
			delete(c.owner.active, c)
			c.owner.mu.Unlock()
			<-c.owner.slots
		}
	})
	return err
}

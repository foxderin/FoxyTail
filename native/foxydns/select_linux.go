//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/florianl/go-nfqueue/v2"
	"github.com/miekg/dns"
	"golang.org/x/sys/unix"
)

// Selector verdicts queued DNS packets by question name instead of
// redirecting them. A Tailnet question is answered by injecting a forged
// answer that appears to come from the original resolver, then dropping the
// original packet; every other packet is accepted unchanged and keeps the
// device's real DNS path. Unlike the transparent path this needs no
// conntrack, no marks and no NAT, but it also cannot replay an upstream
// transport, so any failure degrades to passing traffic through.
type Selector struct {
	queue     *nfqueue.Nfqueue
	records   *recordStore
	inject    func(src, dst netip.AddrPort, payload []byte) error
	cancel    context.CancelFunc
	verdictMu sync.Mutex
	mu        sync.Mutex
	closed    bool
	err       error
	answered  atomic.Uint64
	passed    atomic.Uint64
	failed    atomic.Uint64
}

func NewSelector(queue uint16, records *recordStore) (*Selector, error) {
	if queue == 0 {
		return nil, errors.New("NFQUEUE number must be nonzero")
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Selector{records: records, inject: injectUDP, cancel: cancel}
	fail := func(err error) (*Selector, error) {
		_ = s.Close()
		return nil, err
	}
	var err error
	s.queue, err = nfqueue.Open(&nfqueue.Config{
		NfQueue:      queue,
		MaxQueueLen:  512,
		MaxPacketLen: 65535,
		Copymode:     nfqueue.NfQnlCopyPacket,
		AfFamily:     unix.AF_UNSPEC,
		Flags:        nfqueue.NfQaCfgFlagFailOpen | nfqueue.NfQaCfgFlagUIDGid,
		WriteTimeout: time.Second,
	})
	if err != nil {
		return fail(queueRegistrationError(err))
	}
	if err = s.queue.Con.SetReadBuffer(4 << 20); err != nil {
		return fail(fmt.Errorf("NFQUEUE receive buffer: %w", err))
	}
	if err = s.queue.RegisterWithErrorFunc(ctx, s.capture, func(err error) int {
		s.setError(fmt.Errorf("NFQUEUE receive: %w", err))
		return 1
	}); err != nil {
		return fail(queueRegistrationError(err))
	}
	return s, nil
}

func (s *Selector) setError(err error) {
	s.mu.Lock()
	if s.err == nil {
		s.err = err
	}
	s.mu.Unlock()
}

func (s *Selector) Health() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("DNS selection closed")
	}
	return s.err
}

func (s *Selector) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
	}
	if s.queue != nil {
		return s.queue.Close()
	}
	return nil
}

// Stats reports capture outcome counters for health reporting.
func (s *Selector) Stats() (answered, passed, failed uint64) {
	return s.answered.Load(), s.passed.Load(), s.failed.Load()
}

func (s *Selector) capture(a nfqueue.Attribute) int {
	s.verdictMu.Lock()
	defer s.verdictMu.Unlock()
	if a.PacketID == nil {
		s.setError(errors.New("NFQUEUE packet missing verdict ID"))
		return 1
	}
	if err := s.queue.SetVerdict(*a.PacketID, s.decide(a)); err != nil {
		s.setError(fmt.Errorf("NFQUEUE verdict: %w", err))
		return 1
	}
	return 0
}

// decide returns the verdict for one queued packet. Passing through is the
// default for everything the selector cannot positively prove is a Tailnet
// question, including every failure it can recover from, because the packet
// still has a fully intact path to its real resolver.
func (s *Selector) decide(a nfqueue.Attribute) int {
	// Injected answers never re-enter the queue (source port 53), but keep
	// the helper credential guard in step with the iptables exemption.
	if a.UID != nil && *a.UID == 0 && a.GID != nil && *a.GID == helperSocketGID {
		s.passed.Add(1)
		return nfqueue.NfAccept
	}
	if s.Health() != nil || a.Payload == nil ||
		(a.CapLen != nil && int(*a.CapLen) > len(*a.Payload)) {
		s.passed.Add(1)
		return nfqueue.NfAccept
	}
	tuple, payload, ok := udpQueryPayload(*a.Payload)
	if !ok {
		s.passed.Add(1)
		return nfqueue.NfAccept
	}
	q := new(dns.Msg)
	if err := q.Unpack(payload); err != nil || q.Response || q.Opcode != dns.OpcodeQuery ||
		len(q.Question) != 1 || q.Question[0].Qclass != dns.ClassINET {
		s.passed.Add(1)
		return nfqueue.NfAccept
	}
	if s.records == nil {
		s.passed.Add(1)
		return nfqueue.NfAccept
	}
	records, err := s.records.get()
	if err != nil {
		// Without a valid Tailnet context nothing can be answered; the query
		// still has its real resolver.
		s.passed.Add(1)
		return nfqueue.NfAccept
	}
	response, local := records.answer(q)
	if !local {
		s.passed.Add(1)
		return nfqueue.NfAccept
	}
	size := uint16(dns.MinMsgSize)
	if opt := q.IsEdns0(); opt != nil && opt.UDPSize() > size {
		size = opt.UDPSize()
	}
	if size > 4096 {
		size = 4096
	}
	response.Truncate(int(size))
	answer, err := response.Pack()
	if err != nil {
		s.failed.Add(1)
		s.passed.Add(1)
		return nfqueue.NfAccept
	}
	if err = s.inject(tuple.destination, tuple.source, answer); err != nil {
		s.failed.Add(1)
		s.noteInject(err)
		return nfqueue.NfAccept
	}
	s.answered.Add(1)
	return nfqueue.NfDrop
}

// noteInject promotes transport-layer injection denials into a persistent
// selector failure: a raw socket that cannot send never becomes usable, so
// the guard should tear the mode down and the shell can fall back to the
// local endpoint instead of silently degrading every Tailnet name.
func (s *Selector) noteInject(err error) {
	if errors.Is(err, unix.EPERM) || errors.Is(err, unix.EACCES) ||
		errors.Is(err, unix.EPROTONOSUPPORT) || errors.Is(err, unix.EAFNOSUPPORT) {
		s.setError(fmt.Errorf("DNS answer injection unavailable: %w", err))
	}
}

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
)

const recordTTL = 30

type tailnetContext struct {
	Suffix string
	Hosts  []struct{ IP, Name, Short string }
}

type records struct {
	suffix  string
	hosts   map[string][]netip.Addr
	reverse map[string]string
}

// This cache never retains an earlier account's records after an unreadable or
// invalid context update. The lifecycle writes the context with atomic rename.
type recordStore struct {
	mu      sync.Mutex
	path    string
	mtime   time.Time
	size    int64
	file    os.FileInfo
	current *records
	err     error
}

func name(value string) (string, error) {
	value = strings.ToLower(strings.TrimSuffix(value, "."))
	if value == "" || len(value) > 253 {
		return "", errors.New("invalid DNS name")
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", errors.New("invalid DNS label")
		}
		for _, c := range label {
			if c != '-' && (c < 'a' || c > 'z') && (c < '0' || c > '9') {
				return "", errors.New("invalid DNS label character")
			}
		}
	}
	return value + ".", nil
}

func loadRecords(path string) (*records, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 4*1024*1024+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 4*1024*1024 {
		return nil, errors.New("Tailnet context exceeds 4 MiB")
	}
	var ctx tailnetContext
	if err := json.Unmarshal(data, &ctx); err != nil {
		return nil, err
	}
	suffix, err := name(ctx.Suffix)
	if err != nil {
		return nil, fmt.Errorf("Tailnet suffix: %w", err)
	}
	if len(ctx.Hosts) > 32768 {
		return nil, errors.New("too many Tailnet host records")
	}
	r := &records{suffix: suffix, hosts: make(map[string][]netip.Addr), reverse: make(map[string]string)}
	for _, h := range ctx.Hosts {
		full, err := name(h.Name)
		if err != nil || !strings.HasSuffix(full, "."+suffix) {
			return nil, errors.New("host is outside the active Tailnet suffix")
		}
		short, err := name(h.Short)
		if err != nil || strings.Contains(strings.TrimSuffix(short, "."), ".") || short+suffix != full {
			return nil, errors.New("host short name does not match its full name")
		}
		ip, err := netip.ParseAddr(h.IP)
		if err != nil || ip.Zone() != "" || ip.IsUnspecified() || ip.IsMulticast() {
			return nil, errors.New("invalid Tailnet host address")
		}
		ip = ip.Unmap()
		for _, n := range []string{full, short} {
			duplicate := false
			for _, old := range r.hosts[n] {
				if old == ip {
					duplicate = true
				}
			}
			if !duplicate {
				r.hosts[n] = append(r.hosts[n], ip)
			}
		}
		ptr, _ := dns.ReverseAddr(ip.String())
		r.reverse[ptr] = full
	}
	return r, nil
}

func (s *recordStore) get() (*records, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Stat every query so a removed or atomically replaced account context
	// cannot continue answering from a time-based cache. Parsing still happens
	// only when the file identity, modification time or size changes.
	stat, err := os.Stat(s.path)
	if err != nil {
		s.current = nil
		s.err = err
		return nil, err
	}
	if s.current != nil && s.file != nil && os.SameFile(stat, s.file) && stat.ModTime() == s.mtime && stat.Size() == s.size {
		return s.current, nil
	}
	s.current, s.err = loadRecords(s.path)
	s.mtime, s.size = stat.ModTime(), stat.Size()
	s.file = stat
	return s.current, s.err
}

// Only the active Tailnet namespace and known short names are synthesized.
// Public DNS and other single-label names are never guessed or sent elsewhere.
func (r *records) answer(q *dns.Msg) (*dns.Msg, bool) {
	question := q.Question[0]
	n := strings.ToLower(question.Name)
	ips, known := r.hosts[n]
	ptr, reverse := r.reverse[n]
	inside := n == r.suffix || strings.HasSuffix(n, "."+r.suffix)
	if !known && !reverse && !inside {
		return nil, false
	}
	response := new(dns.Msg)
	response.SetReply(q)
	response.Authoritative = true
	if opt := q.IsEdns0(); opt != nil {
		response.SetEdns0(opt.UDPSize(), opt.Do())
	}
	if !known && !reverse {
		response.Rcode = dns.RcodeNameError
		return response, true
	}
	header := dns.RR_Header{Name: question.Name, Class: dns.ClassINET, Ttl: recordTTL}
	if question.Qtype == dns.TypePTR && reverse {
		header.Rrtype = dns.TypePTR
		response.Answer = []dns.RR{&dns.PTR{Hdr: header, Ptr: ptr}}
	}
	for _, ip := range ips {
		if question.Qtype == dns.TypeA && ip.Is4() {
			header.Rrtype = dns.TypeA
			response.Answer = append(response.Answer, &dns.A{Hdr: header, A: ip.AsSlice()})
		}
		if question.Qtype == dns.TypeAAAA && ip.Is6() {
			header.Rrtype = dns.TypeAAAA
			response.Answer = append(response.Answer, &dns.AAAA{Hdr: header, AAAA: ip.AsSlice()})
		}
	}
	return response, true
}

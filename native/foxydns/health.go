package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/miekg/dns"
)

const healthName = "_foxytail-health.invalid."

type healthState struct {
	Ready             bool   `json:"ready"`
	PID               int    `json:"pid"`
	Instance          string `json:"instance"`
	Mode              string `json:"mode"`
	Port              int    `json:"port"`
	IPv6ListenerReady bool   `json:"ipv6ListenerReady"`
	QueueReady        bool   `json:"queueReady"`
	UpdatedAt         int64  `json:"updatedAt"`
	LocalAnswers      uint64 `json:"localAnswers"`
	Forwarded         uint64 `json:"forwarded"`
	Failed            uint64 `json:"failed"`
	Error             string `json:"error,omitempty"`
}

// A fixed loopback-only CHAOS request uses the existing listener. It never
// reads Tailnet records, counts as user traffic, or reaches an upstream.
func (r *resolver) serveHealth(w dns.ResponseWriter, q *dns.Msg) bool {
	if len(q.Question) != 1 || !strings.EqualFold(q.Question[0].Name, healthName) {
		return false
	}
	response := new(dns.Msg)
	response.SetRcode(q, dns.RcodeRefused)
	var local bool
	switch addr := w.RemoteAddr().(type) {
	case *net.UDPAddr:
		local = addr.IP.IsLoopback()
	case *net.TCPAddr:
		local = addr.IP.IsLoopback()
	}
	if local && r.health != nil && !q.Response && q.Opcode == dns.OpcodeQuery &&
		q.Question[0].Qclass == dns.ClassCHAOS && q.Question[0].Qtype == dns.TypeTXT {
		data, _ := json.Marshal(r.health())
		encoded := base64.RawStdEncoding.EncodeToString(data)
		var chunks []string
		for len(encoded) > 0 {
			n := min(len(encoded), 255)
			chunks = append(chunks, encoded[:n])
			encoded = encoded[n:]
		}
		response.Rcode = dns.RcodeSuccess
		response.Answer = []dns.RR{&dns.TXT{Hdr: dns.RR_Header{Name: healthName, Rrtype: dns.TypeTXT, Class: dns.ClassCHAOS}, Txt: chunks}}
	}
	_ = w.WriteMsg(response)
	return true
}

func readHealth(conn *dns.Conn, expected healthState) (healthState, error) {
	var state healthState
	query := new(dns.Msg)
	query.SetQuestion(healthName, dns.TypeTXT)
	query.Question[0].Qclass = dns.ClassCHAOS
	query.SetEdns0(4096, false)
	if err := conn.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		return state, err
	}
	if err := conn.WriteMsg(query); err != nil {
		return state, err
	}
	response, err := conn.ReadMsg()
	if err != nil {
		return state, err
	}
	if !response.Response || response.Id != query.Id || response.Rcode != dns.RcodeSuccess || response.Truncated ||
		len(response.Question) != 1 || response.Question[0] != query.Question[0] || len(response.Answer) != 1 {
		return state, errors.New("invalid DNS health response")
	}
	txt, ok := response.Answer[0].(*dns.TXT)
	if !ok || txt.Hdr.Name != healthName || txt.Hdr.Class != dns.ClassCHAOS {
		return state, errors.New("invalid DNS health record")
	}
	data, err := base64.RawStdEncoding.DecodeString(strings.Join(txt.Txt, ""))
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return state, err
	}
	if !state.Ready || state.PID != expected.PID || state.Port != expected.Port || state.Instance != expected.Instance {
		return state, errors.New("DNS listener identity changed or is unready")
	}
	return state, nil
}

func monitorHealth(cfg Config, watch bool, instance string, parent int) error {
	if watch && (parent <= 1 || os.Getppid() != parent) {
		return errors.New("DNS guard exited")
	}
	data, err := os.ReadFile(cfg.StateFile)
	if err != nil {
		return err
	}
	var expected healthState
	if err := json.Unmarshal(data, &expected); err != nil {
		return err
	}
	if !expected.Ready || expected.PID <= 0 || expected.Instance == "" || (instance != "" && expected.Instance != instance) ||
		cfg.Listen != fmt.Sprintf("127.0.0.1:%d", expected.Port) {
		return errors.New("invalid DNS listener identity")
	}
	conn, err := dns.DialTimeout("udp", cfg.Listen, 2*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.UDPSize = 4096
	for {
		if watch && os.Getppid() != parent {
			return errors.New("DNS guard exited")
		}
		state, err := readHealth(conn, expected)
		if err != nil {
			return err
		}
		if !watch {
			return json.NewEncoder(os.Stdout).Encode(state)
		}
		if !state.QueueReady {
			return errors.New("DNS capture queue is unready")
		}
		time.Sleep(2 * time.Second)
	}
}

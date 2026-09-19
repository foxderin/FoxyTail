package main

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func TestHealthChecksDoNotWriteOrCountTraffic(t *testing.T) {
	cfg := contextFixture(t)
	s, err := startService(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	before, err := os.Stat(cfg.StateFile)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := dns.Dial("udp", s.servers[0].Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.UDPSize = 4096
	for range 5 {
		if state, err := readHealth(conn, s.healthState()); err != nil || !state.Ready || state.QueueReady {
			t.Fatalf("local health: %+v / %v", state, err)
		}
	}
	// Cross the previous two-second fsync ticker without business traffic.
	time.Sleep(2200 * time.Millisecond)
	after, err := os.Stat(cfg.StateFile)
	if err != nil || !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("idle health rewrote the state file")
	}
	if state := s.healthState(); state.LocalAnswers != 0 || state.Forwarded != 0 || state.Failed != 0 {
		t.Fatalf("health counted as business traffic: %+v", state)
	}
	for _, field := range []string{"pid", "port", "instance"} {
		expected := s.healthState()
		switch field {
		case "pid":
			expected.PID++
		case "port":
			expected.Port++
		case "instance":
			expected.Instance = "previous-instance"
		}
		if _, err := readHealth(conn, expected); err == nil {
			t.Fatalf("accepted mismatched %s", field)
		}
	}
	cfg.Listen = s.servers[0].Listener.Addr().String()
	if err := monitorHealth(cfg, true, s.instance, os.Getppid()); err == nil {
		t.Fatal("monitor accepted an unavailable capture queue")
	}
}

func TestHealthWatchRejectsExitedParentBeforeInitialization(t *testing.T) {
	dir := os.Getenv("FOXYDNS_PARENT_TEST")
	if dir != "" {
		if expected := os.Getenv("FOXYDNS_EXPECTED_PARENT"); expected != "" {
			parent, _ := strconv.Atoi(expected)
			// The parent exits before this monitor gets to initialize.
			deadline := time.Now().Add(3 * time.Second)
			for os.Getppid() == parent && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			err := monitorHealth(Config{StateFile: filepath.Join(dir, "absent-state")}, true, "instance", parent)
			if err == nil {
				os.Exit(2)
			}
			_ = os.WriteFile(filepath.Join(dir, "result"), []byte(err.Error()), 0600)
			os.Exit(0)
		}
		executable, _ := os.Executable()
		child := exec.Command(executable, "-test.run=^TestHealthWatchRejectsExitedParentBeforeInitialization$")
		child.Env = append(os.Environ(), "FOXYDNS_EXPECTED_PARENT="+strconv.Itoa(os.Getpid()))
		if err := child.Start(); err != nil {
			os.Exit(3)
		}
		os.Exit(0)
	}
	dir = t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	parent := exec.Command(executable, "-test.run=^TestHealthWatchRejectsExitedParentBeforeInitialization$")
	parent.Env = append(os.Environ(), "FOXYDNS_PARENT_TEST="+dir)
	if err := parent.Run(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if result, err := os.ReadFile(filepath.Join(dir, "result")); err == nil {
			if string(result) != "DNS guard exited" {
				t.Fatalf("monitor accepted its adopter as the guard: %s", result)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("orphaned monitor did not exit")
}

func TestHealthUnresponsiveListenerHasBoundedDeadline(t *testing.T) {
	listener, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	conn, err := dns.Dial("udp", listener.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	start := time.Now()
	if _, err := readHealth(conn, healthState{}); err == nil {
		t.Fatal("unresponsive listener appeared healthy")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("health exceeded its two-second deadline: %s", elapsed)
	}
}

func TestHealthRequestNeverReachesRecordsOrUpstream(t *testing.T) {
	lookup := &fakeFlowLookup{}
	r := resolver{transport: lookup}
	for _, class := range []uint16{dns.ClassCHAOS, dns.ClassINET} {
		for _, typ := range []uint16{dns.TypeTXT, dns.TypeA} {
			q := new(dns.Msg)
			q.SetQuestion(healthName, typ)
			q.Question[0].Qclass = class
			// The ordinary fixture has a non-loopback remote address.
			w := &responseSink{network: "udp"}
			r.ServeDNS(w, q)
			if w.msg == nil || w.msg.Rcode != dns.RcodeRefused || lookup.calls != 0 || r.failed.Load() != 0 {
				t.Fatal("health request escaped its loopback-only endpoint")
			}
		}
	}
}

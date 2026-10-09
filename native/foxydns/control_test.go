package main

import (
	"bufio"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestQuiesceAuthenticatesInstanceAndKeepsListener(t *testing.T) {
	cfg := contextFixture(t)
	s, err := startService(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	directory, err := os.MkdirTemp("", "fdns-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(directory)
	s.cfg.StateFile = filepath.Join(directory, "state")
	// A local resolver lets this protocol test run without privileged NFQUEUE.
	s.cfg.Mode = "transparent"
	if err = s.startControl(); err != nil {
		t.Fatal(err)
	}
	cfg = s.cfg
	path := controlPath(cfg, s.instance)
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("unsafe control socket: %v", err)
	}
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	conn.SetDeadline(time.Now().Add(time.Second))
	conn.Write([]byte("quiesce wrong-instance\n"))
	if line, err := bufio.NewReader(conn).ReadString('\n'); err == nil || line == "ok\n" {
		t.Fatal("foreign instance authorized")
	}
	conn.Close()
	if err = s.writeState(true); err != nil {
		t.Fatal(err)
	}
	if err = quiesceService(cfg); err != nil {
		t.Fatal(err)
	}
	if !s.healthState().Ready {
		t.Fatal("quiescence closed local endpoint")
	}
	conn, err = net.Dial("tcp", s.servers[0].Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	other := cfg
	other.StateFile = filepath.Join(t.TempDir(), "foreign-state")
	if err = quiesceService(other); err == nil {
		t.Fatal("missing instance accepted")
	}
}

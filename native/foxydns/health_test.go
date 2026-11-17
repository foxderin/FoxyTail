package main

import (
	"net"
	"testing"
	"time"

	"github.com/miekg/dns"
)

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

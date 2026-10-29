//go:build linux

package main

import (
	"context"
	"encoding/json"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/miekg/dns"
	"golang.org/x/sys/unix"
)

func kernelUnavailable(t *testing.T, format string, args ...any) {
	t.Helper()
	if os.Getenv("FOXYTAIL_REQUIRE_PRIVILEGED_TESTS") == "1" {
		t.Fatalf("required kernel integration unavailable: "+format, args...)
	}
	t.Skipf(format, args...)
}

// This test is never privileged merely because go test runs as root. The
// dedicated gate must opt in AND prove it entered fresh net/mount namespaces.
func requireDNSNamespace(t *testing.T) string {
	t.Helper()
	if os.Getenv("FOXYTAIL_PRIVILEGED_TESTS") != "1" {
		t.Skip("real kernel integration is opt-in; use .github/tools/verify-native-linux.sh")
	}
	if os.Geteuid() != 0 {
		kernelUnavailable(t, "real kernel integration needs namespace-local CAP_NET_ADMIN and socket ownership permissions")
	}
	for _, kind := range []string{"net", "mnt"} {
		parent := os.Getenv("FOXYTAIL_TEST_PARENT_" + strings.ToUpper(kind) + "NS")
		current, err := os.Readlink("/proc/self/ns/" + kind)
		if err != nil || !regexp.MustCompile(`^`+kind+`:\[[0-9]+\]$`).MatchString(parent) || current == parent {
			t.Fatalf("refusing netfilter access: %s namespace isolation is not established", kind)
		}
		if initial, err := os.Readlink("/proc/1/ns/" + kind); err == nil && current == initial {
			t.Fatalf("refusing netfilter access in PID 1's %s namespace", kind)
		}
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	for _, iface := range interfaces {
		if iface.Name == "lo" {
			continue
		}
		// Android instantiates undeletable, inert tunnel templates in fresh netns.
		switch iface.Name {
		case "tunl0", "gre0", "gretap0", "erspan0", "ip_vti0", "ip6_vti0", "sit0", "ip6tnl0", "ip6gre0":
			addresses, addressErr := iface.Addrs()
			if addressErr == nil && len(addresses) == 0 && iface.Flags&net.FlagUp == 0 {
				continue
			}
		}
		t.Fatalf("refusing netfilter access: nonempty interface %s", iface.Name)
	}
	root := os.Getenv("FOXYTAIL_TEST_REPO_ROOT")
	if !filepath.IsAbs(root) {
		t.Fatal("explicit source root is required for the real module rule functions")
	}
	for _, command := range []string{"ip", "iptables", "ip6tables", "sh"} {
		if _, err := exec.LookPath(command); err != nil {
			kernelUnavailable(t, "kernel integration tool unavailable: %s: %v", command, err)
		}
	}
	return root
}

func kernelCommand(t *testing.T, name string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("namespace command %s %v: %v\n%s", name, args, err, output)
	}
	return strings.TrimSpace(string(output))
}

func e2eRuleCommand(root, directory, port, command string) *exec.Cmd {
	cmd := exec.Command("sh", "-c", `. "$1"; `+command, "foxytail-dns-e2e",
		filepath.Join(root, "tailscale/scripts/foxytail.dns-modern.sh"))
	cmd.Env = append(os.Environ(), "TS_DIR="+directory, "TS_BIN_DIR="+directory,
		"TS_RUN_DIR="+directory, "DNS_PORT="+port, "IPV6=off")
	return cmd
}

func runE2ERules(t *testing.T, root, directory, port, command string) {
	t.Helper()
	if output, err := e2eRuleCommand(root, directory, port, command).CombinedOutput(); err != nil {
		t.Fatalf("module rule operation %q: %v\n%s", command, err, output)
	}
}

func netdDNSConnection(t *testing.T, network string, sourcePort int) net.Conn {
	t.Helper()
	var source net.Addr = &net.UDPAddr{IP: net.ParseIP("192.0.2.1"), Port: sourcePort}
	if network == "tcp" {
		source = &net.TCPAddr{IP: net.ParseIP("192.0.2.1"), Port: sourcePort}
	}
	dialer := net.Dialer{Timeout: 5 * time.Second, LocalAddr: source,
		Control: func(_, _ string, raw syscall.RawConn) error {
			var socketErr error
			if err := raw.Control(func(fd uintptr) {
				// netd creates with root file credentials, then assigns the app's
				// sk_uid. NFQUEUE's file-owner UID alone must not make this exempt.
				socketErr = unix.Fchown(int(fd), 10123, -1)
				if socketErr == nil {
					socketErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_MARK, 0x1234)
				}
			}); err != nil {
				return err
			}
			return socketErr
		},
	}
	conn, err := dialer.Dial(network+"4", "192.0.2.53:53")
	if err != nil {
		t.Fatalf("netd-style %s client: %v", network, err)
	}
	return conn
}

func e2eQuery(t *testing.T, conn *dns.Conn, host string, typ uint16) *dns.Msg {
	t.Helper()
	if err := conn.SetDeadline(time.Now().Add(8 * time.Second)); err != nil {
		t.Fatal(err)
	}
	request := new(dns.Msg)
	request.SetQuestion(host, typ)
	if err := conn.WriteMsg(request); err != nil {
		t.Fatal(err)
	}
	response, err := conn.ReadMsg()
	if err != nil {
		t.Fatalf("real DNS query %s: %v", host, err)
	}
	if response.Id != request.Id || response.Rcode != dns.RcodeSuccess {
		t.Fatalf("real DNS query %s returned %v", host, response)
	}
	return response
}

// Test-only tracing reports the failing transport operation without inspecting
// DNS payloads or adding probes/retries that could hide the original failure.
type e2eTraceTransport struct {
	originalTransport
	t *testing.T
}

func (tr e2eTraceTransport) Lookup(network string, local, remote net.Addr) (FlowContext, error) {
	flow, err := tr.originalTransport.Lookup(network, local, remote)
	if err != nil {
		tr.t.Logf("transport Lookup network=%s local=%s remote=%s: %v", network, local, remote, err)
		return flow, err
	}
	if validate := flow.validate; validate != nil {
		flow.validate = func() error {
			err := validate()
			if err != nil {
				tr.t.Logf("transport validate network=%s source=%s destination=%s: %v", network, flow.OriginalSource, flow.OriginalDestination, err)
			}
			return err
		}
	}
	if checkSource := flow.checkSource; checkSource != nil {
		flow.checkSource = func(source netip.AddrPort) error {
			err := checkSource(source)
			if err != nil {
				tr.t.Logf("transport checkSource network=%s upstream-source=%s uid=%d mark=%#x interface=%s: %v", network, source, flow.UID, flow.Mark, flow.InterfaceName, err)
			}
			return err
		}
	}
	return flow, nil
}

type e2eTraceConn struct {
	net.Conn
	t       *testing.T
	network string
}

func (c *e2eTraceConn) Read(data []byte) (int, error) {
	n, err := c.Conn.Read(data)
	if err != nil {
		c.t.Logf("upstream Read network=%s source=%s destination=%s bytes=%d: %v", c.network, c.LocalAddr(), c.RemoteAddr(), n, err)
	}
	return n, err
}

func (c *e2eTraceConn) Write(data []byte) (int, error) {
	n, err := c.Conn.Write(data)
	if err != nil {
		c.t.Logf("upstream Write network=%s source=%s destination=%s bytes=%d: %v", c.network, c.LocalAddr(), c.RemoteAddr(), n, err)
	}
	return n, err
}

func (c *e2eTraceConn) SetDeadline(deadline time.Time) error {
	err := c.Conn.SetDeadline(deadline)
	if err != nil {
		c.t.Logf("upstream SetDeadline network=%s: %v", c.network, err)
	}
	return err
}

// dns.Conn selects UDP framing through net.PacketConn. Keep that identity and
// delegate packet methods to the original socket without substituting streams.
type e2eTracePacketConn struct {
	*e2eTraceConn
	packet net.PacketConn
}

func (c *e2eTracePacketConn) ReadFrom(data []byte) (int, net.Addr, error) {
	n, address, err := c.packet.ReadFrom(data)
	if err != nil {
		c.t.Logf("upstream ReadFrom network=%s bytes=%d: %v", c.network, n, err)
	}
	return n, address, err
}

func (c *e2eTracePacketConn) WriteTo(data []byte, address net.Addr) (int, error) {
	n, err := c.packet.WriteTo(data, address)
	if err != nil {
		c.t.Logf("upstream WriteTo network=%s bytes=%d: %v", c.network, n, err)
	}
	return n, err
}

func traceE2ETransport(t *testing.T, r *resolver) {
	r.transport = e2eTraceTransport{originalTransport: r.transport, t: t}
	dial := r.dial
	r.dial = func(ctx context.Context, network string, flow FlowContext) (net.Conn, error) {
		connection, err := dial(ctx, network, flow)
		if err != nil {
			t.Logf("transport DialOriginal network=%s source=%s destination=%s uid=%d mark=%#x interface=%s: %v", network, flow.OriginalSource, flow.OriginalDestination, flow.UID, flow.Mark, flow.InterfaceName, err)
			return connection, err
		}
		traced := &e2eTraceConn{Conn: connection, t: t, network: network}
		if packet, ok := connection.(net.PacketConn); ok {
			return &e2eTracePacketConn{e2eTraceConn: traced, packet: packet}, nil
		}
		return traced, nil
	}
}

func TestPrivilegedDNSNamespace(t *testing.T) {
	root := requireDNSNamespace(t) // Must precede every ip/iptables invocation.
	kernelCommand(t, "ip", "link", "set", "lo", "up")
	for _, address := range []string{"192.0.2.1/32", "192.0.2.53/32"} {
		kernelCommand(t, "ip", "address", "add", address, "dev", "lo")
	}
	// A fresh namespace can lack kernel support even when the runner is root.
	// Report that as an explicit skipped experiment, never a successful test.
	for _, table := range []string{"mangle", "nat"} {
		if output, err := exec.Command("iptables", "-t", table, "-S").CombinedOutput(); err != nil {
			kernelUnavailable(t, "kernel %s table unavailable: %v: %s", table, err, output)
		}
	}
	cfg := contextFixture(t)
	cfg.Mode, cfg.Queue = "transparent", 1053
	cfg.OwnershipFile = filepath.Join(filepath.Dir(cfg.ContextFile), "flows.jsonl")
	s, err := startService(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if s.interceptor == nil || s.queueError != nil {
		kernelUnavailable(t, "kernel queue/conntrack/socket-context capability unavailable: %v", s.queueError)
	}
	traceE2ETransport(t, s.resolver)
	port := strconv.Itoa(s.port)
	var receivedMu sync.Mutex
	var received []string
	originalDNS := dns.HandlerFunc(func(w dns.ResponseWriter, q *dns.Msg) {
		receivedMu.Lock()
		received = append(received, q.Question[0].Name+" from "+w.RemoteAddr().String())
		receivedMu.Unlock()
		response := new(dns.Msg)
		response.SetReply(q)
		response.RecursionAvailable = true
		response.Answer = []dns.RR{&dns.A{Hdr: dns.RR_Header{Name: q.Question[0].Name,
			Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 17}, A: net.ParseIP("198.51.100.77")}}
		_ = w.WriteMsg(response)
	})
	for _, network := range []string{"udp", "tcp"} {
		server := &dns.Server{Handler: originalDNS}
		if network == "udp" {
			server.PacketConn, err = net.ListenPacket("udp4", "192.0.2.53:53")
		} else {
			server.Listener, err = net.Listen("tcp4", "192.0.2.53:53")
		}
		if err != nil {
			t.Fatal(err)
		}
		ready := make(chan struct{})
		server.NotifyStartedFunc = func() { close(ready) }
		go func() { _ = server.ActivateAndServe() }()
		select {
		case <-ready:
		case <-time.After(time.Second):
			t.Fatal("original DNS server did not start")
		}
		t.Cleanup(func() { _ = server.Shutdown() })
	}
	// Keep an unrelated rule as an ownership canary within this namespace.
	kernelCommand(t, "iptables", "-t", "nat", "-N", "E2E_FOREIGN_KEEP")
	kernelCommand(t, "iptables", "-t", "nat", "-A", "E2E_FOREIGN_KEEP", "-j", "RETURN")
	kernelCommand(t, "iptables", "-t", "nat", "-A", "OUTPUT", "-j", "E2E_FOREIGN_KEEP")
	baselineNat := kernelCommand(t, "iptables", "-t", "nat", "-S")
	baselineMangle := kernelCommand(t, "iptables", "-t", "mangle", "-S")
	t.Cleanup(func() {
		if output, err := e2eRuleCommand(root, filepath.Dir(cfg.ContextFile), port, "modern_rules_teardown").CombinedOutput(); err != nil {
			t.Errorf("namespace DNS rules failed cleanup: %v: %s", err, output)
		}
	})
	runE2ERules(t, root, filepath.Dir(cfg.ContextFile), port, "modern_rules_family iptables && modern_rules_present iptables")
	for index, network := range []string{"udp", "tcp"} {
		conn := &dns.Conn{Conn: netdDNSConnection(t, network, 42000+index), UDPSize: 4096}
		t.Cleanup(func() { _ = conn.Close() })
		for _, host := range []string{"nas.tail.test.ts.net.", "nas."} {
			response := e2eQuery(t, conn, host, dns.TypeA)
			if len(response.Answer) != 1 || response.Answer[0].(*dns.A).A.String() != "100.65.0.1" {
				t.Fatalf("%s Tailnet query reached the wrong resolver: %s", network, response)
			}
		}
		response := e2eQuery(t, conn, "public.example.", dns.TypeA)
		if len(response.Answer) != 1 || response.Answer[0].(*dns.A).A.String() != "198.51.100.77" || response.Answer[0].Header().Ttl != 17 || !response.RecursionAvailable {
			t.Fatalf("%s changed the original upstream's answer: %s", network, response)
		}
		response = e2eQuery(t, conn, "nas.", dns.TypeAAAA)
		if len(response.Answer) != 1 || response.Answer[0].(*dns.AAAA).AAAA.String() != "fd7a:115c:a1e0::1" {
			t.Fatalf("%s lost AAAA records on an IPv4 DNS transport: %s", network, response)
		}
		_ = conn.Close()
	}
	receivedMu.Lock()
	observed := append([]string(nil), received...)
	receivedMu.Unlock()
	if len(observed) != 2 {
		t.Fatalf("Tailnet queries leaked to the original upstream: %v", observed)
	}
	for _, query := range observed {
		if !strings.HasPrefix(query, "public.example. from 192.0.2.1:") {
			t.Fatalf("original query or source address changed: %s", query)
		}
	}
	interceptor, ok := s.interceptor.(*Interceptor)
	if !ok {
		t.Fatal("transparent service did not keep its interceptor")
	}
	interceptor.mu.Lock()
	protocols := make(map[uint8]bool)
	for _, observation := range interceptor.flows {
		flow := observation.context
		if flow.UID != 10123 || flow.Mark != 0x1234 || flow.InterfaceName != "lo" || flow.OriginalDestination.String() != "192.0.2.53:53" {
			interceptor.mu.Unlock()
			t.Fatalf("lost real netd UID/mark/interface context: %+v", flow)
		}
		protocols[flow.protocol] = true
	}
	interceptor.mu.Unlock()
	if !protocols[6] || !protocols[17] || s.resolver.forwarded.Load() != 2 {
		t.Fatalf("both real transports must be captured and forwarded: protocols=%v count=%d", protocols, s.resolver.forwarded.Load())
	}
	runE2ERules(t, root, filepath.Dir(cfg.ContextFile), port, "modern_rules_teardown")
	if err := s.quiesce(); err != nil {
		t.Fatal(err)
	}
	if err := cleanupOwnedFlows(cfg.OwnershipFile); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if kernelCommand(t, "iptables", "-t", "nat", "-S") != baselineNat || kernelCommand(t, "iptables", "-t", "mangle", "-S") != baselineMangle {
		t.Fatal("normal stop failed to remove only FoxyTail's rules")
	}
	state, err := os.ReadFile(cfg.StateFile)
	if err != nil {
		t.Fatal(err)
	}
	var stopped map[string]any
	if err = json.Unmarshal(state, &stopped); err != nil || stopped["ready"] != false || stopped["queueReady"] != false {
		t.Fatalf("normal stop left a ready state: %s", state)
	}
	for index, network := range []string{"udp", "tcp"} {
		sourcePort := 43000 + index
		if network == "udp" {
			sourcePort = 42000
		}
		conn := &dns.Conn{Conn: netdDNSConnection(t, network, sourcePort), UDPSize: 4096}
		response := e2eQuery(t, conn, "after-stop.example.", dns.TypeA)
		_ = conn.Close()
		if len(response.Answer) != 1 || response.Answer[0].(*dns.A).A.String() != "198.51.100.77" {
			t.Fatal("original DNS did not resume after interception was removed")
		}
	}
	t.Log("verified real UDP/TCP NFQUEUE and conntrack, app UID 10123, mark 0x1234, original source/upstream, Tailnet A/AAAA and selective rule cleanup")
}

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/netip"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/miekg/dns"
	"golang.org/x/net/proxy"
)

type verifyOptions struct {
	dnsPort      int
	resolverPort int
	socksPort    int
	targetPort   int
	name         string
	address      netip.Addr
}

type verifyCheck struct {
	ID        string   `json:"id"`
	OK        bool     `json:"ok"`
	Error     string   `json:"error,omitempty"`
	Addresses []string `json:"addresses,omitempty"`
	ElapsedMs int64    `json:"elapsedMs"`
}

type verifyResult struct {
	OK         bool          `json:"ok"`
	Name       string        `json:"name"`
	Address    string        `json:"address"`
	TargetPort int           `json:"targetPort"`
	Path       string        `json:"path"`
	Checks     []verifyCheck `json:"checks"`
}

func parseVerifyOptions(args []string) (verifyOptions, error) {
	var options verifyOptions
	var address string
	flags := flag.NewFlagSet("verify", flag.ContinueOnError)
	decimalPort := func(target *int) func(string) error {
		return func(value string) error {
			port, err := strconv.Atoi(value)
			if err != nil || port < 1 || port > 65535 {
				return errors.New("ports must be between 1 and 65535")
			}
			*target = port
			return nil
		}
	}
	flags.Func("dns-port", "FoxyTail DNS port on 127.0.0.1 (1..65535)", decimalPort(&options.dnsPort))
	flags.Func("resolver-port", "optional proxy DNS port on 127.0.0.1 (1..65535)", decimalPort(&options.resolverPort))
	flags.Func("socks-port", "optional SOCKS5 port on 127.0.0.1 (1..65535)", decimalPort(&options.socksPort))
	flags.Func("target-port", "target TCP port (1..65535)", decimalPort(&options.targetPort))
	flags.StringVar(&options.name, "name", "", "fully qualified peer DNS name")
	flags.StringVar(&address, "address", "", "numeric non-loopback unicast peer IP")
	if err := flags.Parse(args); err != nil {
		return options, err
	}
	if flags.NArg() != 0 {
		return options, errors.New("unexpected positional argument")
	}
	if options.dnsPort == 0 || options.targetPort == 0 {
		return options, errors.New("ports must be between 1 and 65535")
	}
	if options.resolverPort == options.dnsPort {
		return options, errors.New("resolver-port must differ from dns-port")
	}
	canonicalName, err := name(options.name)
	if err != nil || !strings.Contains(strings.TrimSuffix(canonicalName, "."), ".") {
		return options, errors.New("name must be a fully qualified DNS name")
	}
	options.name = canonicalName
	ip, err := netip.ParseAddr(address)
	if err != nil || ip.Zone() != "" {
		return options, errors.New("address must be a numeric unicast IP without a zone")
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return options, errors.New("address must be a non-loopback, non-link-local unicast IP")
	}
	options.address = ip
	return options, nil
}

func runVerify(args []string) error {
	options, err := parseVerifyOptions(args)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 11*time.Second)
	defer cancel()
	return json.NewEncoder(os.Stdout).Encode(verifyPeer(ctx, options))
}

func verifyPeer(ctx context.Context, options verifyOptions) verifyResult {
	result := verifyResult{OK: true, Name: strings.TrimSuffix(options.name, "."), Address: options.address.String(), TargetPort: options.targetPort, Path: "system", Checks: make([]verifyCheck, 0, 5)}
	if options.socksPort != 0 {
		result.Path = "socks5"
	}
	for _, resolver := range []struct {
		id   string
		port int
	}{{"dns", options.dnsPort}, {"resolver", options.resolverPort}} {
		if resolver.port == 0 {
			continue
		}
		for _, network := range []string{"udp", "tcp"} {
			started := time.Now()
			addresses, err := verifyDNS(ctx, network, resolver.port, options.name, options.address)
			row := verifyCheck{ID: resolver.id + "-" + network, OK: err == nil, Addresses: addresses, ElapsedMs: time.Since(started).Milliseconds()}
			if err != nil {
				row.Error = err.Error()
			}
			result.Checks = append(result.Checks, row)
		}
	}
	started := time.Now()
	err := verifyTCP(ctx, options.address, options.targetPort, options.socksPort)
	row := verifyCheck{ID: "tcp", OK: err == nil, ElapsedMs: time.Since(started).Milliseconds()}
	if err != nil {
		row.Error = err.Error()
	}
	result.Checks = append(result.Checks, row)
	return result
}

func verifyDNS(ctx context.Context, network string, port int, hostname string, address netip.Addr) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	defer connection.Close()
	deadline, _ := ctx.Deadline()
	if err := connection.SetDeadline(deadline); err != nil {
		return nil, err
	}
	conn := &dns.Conn{Conn: connection, UDPSize: 4096}
	query := new(dns.Msg)
	qtype := uint16(dns.TypeA)
	if address.Is6() {
		qtype = dns.TypeAAAA
	}
	query.SetQuestion(hostname, qtype)
	if err := conn.WriteMsg(query); err != nil {
		return nil, err
	}
	response, err := conn.ReadMsg()
	if err != nil {
		return nil, err
	}
	var addresses []string
	validRecords := true
	for _, record := range response.Answer {
		var ip net.IP
		switch record := record.(type) {
		case *dns.A:
			ip = record.A
		case *dns.AAAA:
			ip = record.AAAA
		default:
			validRecords = false
			continue
		}
		observed, valid := netip.AddrFromSlice(ip)
		if !valid {
			validRecords = false
			continue
		}
		value := observed.Unmap().String()
		if !slices.Contains(addresses, value) {
			addresses = append(addresses, value)
		}
		header := record.Header()
		if !strings.EqualFold(header.Name, hostname) || header.Class != dns.ClassINET || header.Rrtype != qtype {
			validRecords = false
		}
	}
	if !response.Response || response.Id != query.Id || response.Opcode != dns.OpcodeQuery || response.Truncated || len(response.Question) != 1 {
		return addresses, errors.New("invalid DNS response header or question")
	}
	question := response.Question[0]
	if !strings.EqualFold(question.Name, hostname) || question.Qclass != dns.ClassINET || question.Qtype != qtype {
		return addresses, errors.New("DNS response question does not match")
	}
	if response.Rcode != dns.RcodeSuccess {
		return addresses, fmt.Errorf("DNS response code %s", dns.RcodeToString[response.Rcode])
	}
	if !validRecords || len(addresses) != 1 || addresses[0] != address.String() {
		return addresses, errors.New("DNS answer is not the exact selected peer address")
	}
	return addresses, nil
}

func verifyTCP(ctx context.Context, address netip.Addr, port, socksPort int) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var dialer proxy.ContextDialer = &net.Dialer{}
	if socksPort != 0 {
		socks, err := proxy.SOCKS5("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(socksPort)), nil, &net.Dialer{})
		if err != nil {
			return err
		}
		var ok bool
		dialer, ok = socks.(proxy.ContextDialer)
		if !ok {
			return errors.New("SOCKS dialer lacks deadline support")
		}
	}
	connection, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(address.String(), strconv.Itoa(port)))
	if err != nil {
		return err
	}
	return connection.Close()
}

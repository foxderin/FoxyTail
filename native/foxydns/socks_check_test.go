package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"strconv"
	"testing"
	"time"
)

func socksProbeCertificate(t *testing.T, address string) (tls.Certificate, *x509.Certificate) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	certificate := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "SOCKS probe fixture"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true, IsCA: true, IPAddresses: []net.IP{net.ParseIP(address)},
	}
	der, err := x509.CreateCertificate(rand.Reader, certificate, certificate, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, parsed
}

func socksProbeServer(t *testing.T, serve func(net.Conn) error) int {
	t.Helper()
	return verifyTCPServer(t, func(connection net.Conn) error {
		var greeting [3]byte
		if _, err := io.ReadFull(connection, greeting[:]); err != nil {
			return err
		}
		if greeting != [3]byte{5, 1, 0} {
			return fmt.Errorf("invalid SOCKS greeting: %v", greeting)
		}
		if _, err := connection.Write([]byte{5, 0}); err != nil {
			return err
		}
		var target [10]byte
		if _, err := io.ReadFull(connection, target[:]); err != nil {
			return err
		}
		if target != [10]byte{5, 1, 0, 1, 1, 1, 1, 1, 1, 187} {
			return fmt.Errorf("probe escaped the fixed endpoint: %v", target)
		}
		if _, err := connection.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 1}); err != nil {
			return err
		}
		return serve(connection)
	})
}

func TestSocksHTTPSUsesProxyAndPreservesHTTPOutcomes(t *testing.T) {
	certificate, root := socksProbeCertificate(t, "1.1.1.1")
	roots := x509.NewCertPool()
	roots.AddCert(root)
	for _, status := range []int{204, 302, 503} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			port := socksProbeServer(t, func(connection net.Conn) error {
				secure := tls.Server(connection, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12})
				defer secure.Close()
				request, err := http.ReadRequest(bufio.NewReader(secure))
				if err != nil {
					return err
				}
				defer request.Body.Close()
				if request.Method != http.MethodHead || request.Host != "1.1.1.1" || request.URL.Path != "/" {
					return fmt.Errorf("unexpected probe request: %s %s %s", request.Method, request.Host, request.URL)
				}
				_, err = fmt.Fprintf(secure, "HTTP/1.1 %d %s\r\nLocation: https://127.0.0.1:1/must-not-follow\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", status, http.StatusText(status))
				return err
			})
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			result := checkSocksHTTPS(ctx, port, roots)
			if !result.OK || result.Success != (status < 400) || result.HTTPCode != strconv.Itoa(status) || result.ElapsedMs < 0 {
				t.Fatalf("incorrect HTTP outcome: %+v", result)
			}
			if (result.Error != "") != (status >= 400) {
				t.Fatalf("incorrect error preservation: %+v", result)
			}
		})
	}
}

func TestSocksHTTPSRejectsUntrustedAndWrongIdentityCertificates(t *testing.T) {
	for _, test := range []struct {
		name, ip string
		trust    bool
	}{{"untrusted", "1.1.1.1", false}, {"wrong-IP", "127.0.0.1", true}} {
		t.Run(test.name, func(t *testing.T) {
			certificate, root := socksProbeCertificate(t, test.ip)
			roots := x509.NewCertPool()
			if test.trust {
				roots.AddCert(root)
			}
			port := socksProbeServer(t, func(connection net.Conn) error {
				secure := tls.Server(connection, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12})
				defer secure.Close()
				if err := secure.Handshake(); err == nil {
					return fmt.Errorf("client trusted an invalid certificate")
				}
				return nil
			})
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			result := checkSocksHTTPS(ctx, port, roots)
			if !result.OK || result.Success || result.HTTPCode != "" || result.Error == "" {
				t.Fatalf("invalid certificate appeared reachable: %+v", result)
			}
		})
	}
}

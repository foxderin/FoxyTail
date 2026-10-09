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
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
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

func TestSocksHTTPSDeadlineAndRefusal(t *testing.T) {
	certificate, root := socksProbeCertificate(t, "1.1.1.1")
	roots := x509.NewCertPool()
	roots.AddCert(root)
	for _, stage := range []string{"socks", "tls", "http", "refused"} {
		t.Run(stage, func(t *testing.T) {
			serve := func(connection net.Conn) error {
				if stage == "http" {
					secure := tls.Server(connection, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12})
					defer secure.Close()
					if _, err := http.ReadRequest(bufio.NewReader(secure)); err != nil {
						return err
					}
					connection = secure
				}
				_, err := io.Copy(io.Discard, connection)
				return err
			}
			var port int
			if stage == "socks" || stage == "refused" {
				port = verifyTCPServer(t, func(connection net.Conn) error {
					var greeting [3]byte
					if _, err := io.ReadFull(connection, greeting[:]); err != nil {
						return err
					}
					if stage == "refused" {
						_, err := connection.Write([]byte{5, 255})
						return err
					}
					return serve(connection)
				})
			} else {
				port = socksProbeServer(t, serve)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
			defer cancel()
			started := time.Now()
			result := checkSocksHTTPS(ctx, port, roots)
			if !result.OK || result.Success || result.HTTPCode != "" || result.Error == "" || time.Since(started) > 2*time.Second {
				t.Fatalf("failed probe did not terminate honestly: %+v", result)
			}
		})
	}
}

func TestSocksCheckAndroidTrustDirectoryPrecedence(t *testing.T) {
	_, root := socksProbeCertificate(t, "1.1.1.1")
	base := t.TempDir()
	apex, legacy := filepath.Join(base, "apex"), filepath.Join(base, "legacy")
	if err := os.Mkdir(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: root.Raw})
	if err := os.WriteFile(filepath.Join(legacy, "root.0"), cert, 0600); err != nil {
		t.Fatal(err)
	}
	pool, err := socksCheckRoots([]string{apex, legacy})
	if err != nil || pool == nil {
		t.Fatalf("legacy system trust not found: %v", err)
	}
	if _, err := root.Verify(x509.VerifyOptions{Roots: pool, DNSName: "1.1.1.1"}); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(apex, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := socksCheckRoots([]string{apex, legacy}); err == nil {
		t.Fatal("empty authoritative APEX store fell back to legacy trust")
	}
	_, other := socksProbeCertificate(t, "1.1.1.1")
	if err := os.WriteFile(filepath.Join(apex, "root.0"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: other.Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	pool, err = socksCheckRoots([]string{apex, legacy})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := root.Verify(x509.VerifyOptions{Roots: pool, DNSName: "1.1.1.1"}); err == nil {
		t.Fatal("legacy certificate leaked into authoritative APEX trust")
	}
	if _, err := other.Verify(x509.VerifyOptions{Roots: pool, DNSName: "1.1.1.1"}); err != nil {
		t.Fatal(err)
	}
}

func TestSocksCheckRejectsUnsupportedInputsBeforeNetwork(t *testing.T) {
	for _, args := range [][]string{nil, {"--socks-port", "0"}, {"--socks-port", "65536"}, {"--socks-port", "-1"}, {"--socks-port", "text"}, {"--socks-port", "1099", "https://elsewhere"}, {"--socks-port", "1099", "--url", "https://elsewhere"}} {
		if err := run(append([]string{"socks-check"}, args...)); err == nil {
			t.Fatalf("accepted invalid command: %v", args)
		}
	}
}

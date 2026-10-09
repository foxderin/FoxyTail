package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/net/proxy"
)

type socksCheckResult struct {
	OK        bool   `json:"ok"`
	Success   bool   `json:"success"`
	HTTPCode  string `json:"httpCode"`
	ElapsedMs int64  `json:"elapsedMs"`
	Error     string `json:"error,omitempty"`
}

func runSocksCheck(args []string) error {
	flags := flag.NewFlagSet("socks-check", flag.ContinueOnError)
	port := flags.Int("socks-port", 0, "applied SOCKS5 port on 127.0.0.1 (1..65535)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *port < 1 || *port > 65535 {
		return errors.New("socks-check requires only --socks-port between 1 and 65535")
	}
	roots, err := socksCheckRoots([]string{"/apex/com.android.conscrypt/cacerts", "/system/etc/security/cacerts"})
	if err != nil {
		return fmt.Errorf("cannot load system TLS trust: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return json.NewEncoder(os.Stdout).Encode(checkSocksHTTPS(ctx, *port, roots))
}

// Static GOOS=linux builds do not search Android's system/APEX CA directories.
func socksCheckRoots(directories []string) (*x509.CertPool, error) {
	for _, directory := range directories {
		entries, err := os.ReadDir(directory)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		roots := x509.NewCertPool()
		loaded := false
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			cert, err := os.ReadFile(filepath.Join(directory, entry.Name()))
			if err != nil {
				return nil, err
			}
			loaded = roots.AppendCertsFromPEM(cert) || loaded
		}
		if !loaded {
			return nil, fmt.Errorf("no usable system certificates in %s", directory)
		}
		return roots, nil
	}
	return x509.SystemCertPool()
}

func checkSocksHTTPS(ctx context.Context, port int, roots *x509.CertPool) socksCheckResult {
	started := time.Now()
	result := socksCheckResult{OK: true}
	err := func() error {
		socks, err := proxy.SOCKS5("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), nil, &net.Dialer{})
		if err != nil {
			return err
		}
		dialer, ok := socks.(proxy.ContextDialer)
		if !ok {
			return errors.New("SOCKS dialer lacks deadline support")
		}
		transport := &http.Transport{
			DialContext:            dialer.DialContext,
			TLSClientConfig:        &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
			TLSHandshakeTimeout:    5 * time.Second,
			ResponseHeaderTimeout:  5 * time.Second,
			MaxResponseHeaderBytes: 32 << 10,
			DisableKeepAlives:      true,
		}
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		request, err := http.NewRequestWithContext(ctx, http.MethodHead, "https://1.1.1.1/", nil)
		if err != nil {
			return err
		}
		response, err := client.Do(request)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		result.HTTPCode = strconv.Itoa(response.StatusCode)
		result.Success = response.StatusCode >= 200 && response.StatusCode < 400
		if !result.Success {
			return fmt.Errorf("HTTPS endpoint returned HTTP %d", response.StatusCode)
		}
		return nil
	}()
	if err != nil {
		result.Error = err.Error()
	}
	result.ElapsedMs = time.Since(started).Milliseconds()
	return result
}

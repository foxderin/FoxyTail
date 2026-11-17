package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReceiveModeDistinguishesBufferedFromUnavailable(t *testing.T) {
	for _, tc := range []struct {
		label     string
		status    int
		body      string
		direct    bool
		wantError bool
	}{
		{"direct", 500, "opens not allowed in direct mode\n", true, false},
		{"buffered-absent", 500, "open file: no such file or directory", false, false},
		{"permission", 403, "file access denied", false, true},
		{"unavailable", 500, "Taildrop not available", false, true},
		{"file-response", 200, "opens not allowed in direct mode", false, true},
		{"unexpected-suffix", 500, "opens not allowed in direct mode extra", false, true},
	} {
		t.Run(tc.label, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, "/localapi/v0/files/.foxytail-mode-probe-") {
					t.Errorf("unexpected receive probe: %s %s", r.Method, r.URL.Path)
				}
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer server.Close()
			client := server.Client()
			client.Transport = rewriteProbeHost{client.Transport, strings.TrimPrefix(server.URL, "http://")}
			api := &localAPI{client: client}
			direct, err := api.receiveDirect(context.Background())
			if direct != tc.direct || (err != nil) != tc.wantError {
				t.Fatalf("direct=%v error=%v; want direct=%v error=%v", direct, err, tc.direct, tc.wantError)
			}
		})
	}
}

type rewriteProbeHost struct {
	http.RoundTripper
	host string
}

func (r rewriteProbeHost) RoundTrip(request *http.Request) (*http.Response, error) {
	request.URL.Host = r.host
	return r.RoundTripper.RoundTrip(request)
}

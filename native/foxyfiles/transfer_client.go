package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/netip"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type taildropPeer struct {
	ID       string   `json:"id"`
	Hostname string   `json:"hostname"`
	IPs      []string `json:"ips"`
	Online   bool     `json:"online"`
}

type localAPI struct {
	client    *http.Client
	transport *http.Transport
}

func newLocalAPI(socket string) (*localAPI, error) {
	if !filepath.IsAbs(socket) || len(socket) > 4096 {
		return nil, errors.New("LocalAPI socket must be an absolute path")
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", socket)
		},
		DisableKeepAlives:      true,
		MaxResponseHeaderBytes: 32 << 10,
	}
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return &localAPI{client, transport}, nil
}

func (api *localAPI) Close() { api.transport.CloseIdleConnections() }

func decodeBoundedJSON(input io.Reader, maximum int64, value any) error {
	data, err := io.ReadAll(io.LimitReader(input, maximum+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > maximum {
		return errors.New("JSON response exceeds limit")
	}
	if err = json.Unmarshal(data, value); err != nil {
		return fmt.Errorf("invalid JSON response: %w", err)
	}
	return nil
}

func stableNodeID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (api *localAPI) getJSON(ctx context.Context, path string, value any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://local-tailscaled.sock/localapi/v0/"+path, nil)
	if err != nil {
		return err
	}
	response, err := api.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return responseError(response)
	}
	return decodeBoundedJSON(response.Body, 4<<20, value)
}

func responseError(response *http.Response) error {
	data, err := io.ReadAll(io.LimitReader(response.Body, 2048))
	if err != nil {
		return fmt.Errorf("LocalAPI HTTP %d: %w", response.StatusCode, err)
	}
	message := strings.TrimSpace(strings.ToValidUTF8(string(data), "?"))
	return fmt.Errorf("LocalAPI HTTP %d: %s", response.StatusCode, message)
}

func (api *localAPI) self(ctx context.Context) (string, error) {
	var status struct {
		BackendState string
		Self         *struct{ ID string }
	}
	if err := api.getJSON(ctx, "status?peers=false", &status); err != nil {
		return "", err
	}
	if status.BackendState != "Running" || status.Self == nil || !stableNodeID(status.Self.ID) {
		return "", errors.New("Tailscale is not Running with a signed-in account")
	}
	return status.Self.ID, nil
}

func (api *localAPI) targets(ctx context.Context) ([]taildropPeer, error) {
	var targets []struct {
		Node *struct {
			StableID  string
			Name      string
			Addresses []string
			Online    *bool
		}
		PeerAPIURL string
	}
	if err := api.getJSON(ctx, "file-targets", &targets); err != nil {
		return nil, err
	}
	if len(targets) > 4096 {
		return nil, errors.New("too many Taildrop targets")
	}
	peers := []taildropPeer{}
	seen := map[string]bool{}
	for _, target := range targets {
		if target.Node == nil || !stableNodeID(target.Node.StableID) || seen[target.Node.StableID] {
			return nil, errors.New("invalid or duplicate Taildrop target identity")
		}
		node := target.Node
		if len(node.Name) > 1024 || len(node.Addresses) > 32 {
			return nil, errors.New("invalid Taildrop target metadata")
		}
		peerURL, err := url.Parse(target.PeerAPIURL)
		if err != nil || peerURL.Scheme != "http" || peerURL.User != nil || peerURL.Hostname() == "" {
			return nil, errors.New("invalid Taildrop peer API URL")
		}
		apiIP, err := netip.ParseAddr(peerURL.Hostname())
		if err != nil || apiIP.Zone() != "" {
			return nil, errors.New("Taildrop peer API must use an IP address")
		}
		peer := taildropPeer{ID: node.StableID, Hostname: strings.TrimSuffix(node.Name, "."), IPs: []string{}}
		if peer.Hostname == "" {
			peer.Hostname = peer.ID
		}
		if node.Online != nil {
			peer.Online = *node.Online
		}
		matchesURL := false
		seenIP := map[string]bool{}
		for _, address := range node.Addresses {
			prefix, err := netip.ParsePrefix(address)
			if err != nil || prefix.Bits() != prefix.Addr().BitLen() || prefix.Addr().Zone() != "" {
				return nil, errors.New("invalid Taildrop target address")
			}
			ip := prefix.Addr().Unmap()
			if !ip.IsGlobalUnicast() {
				return nil, errors.New("Taildrop target address must be unicast")
			}
			if ip == apiIP.Unmap() {
				matchesURL = true
			}
			if !seenIP[ip.String()] {
				peer.IPs = append(peer.IPs, ip.String())
				seenIP[ip.String()] = true
			}
		}
		if len(peer.IPs) == 0 || !matchesURL {
			return nil, errors.New("Taildrop target has no matching peer API address")
		}
		seen[peer.ID] = true
		peers = append(peers, peer)
	}
	sort.Slice(peers, func(i, j int) bool {
		if peers[i].Hostname == peers[j].Hostname {
			return peers[i].ID < peers[j].ID
		}
		return peers[i].Hostname < peers[j].Hostname
	})
	return peers, nil
}

func (api *localAPI) validatePeer(ctx context.Context, peerID, address, expectedSelf string) (string, taildropPeer, error) {
	if !stableNodeID(peerID) {
		return "", taildropPeer{}, errors.New("invalid peer identity")
	}
	ip, err := netip.ParseAddr(address)
	if err != nil || ip.Zone() != "" {
		return "", taildropPeer{}, errors.New("invalid peer IP address")
	}
	self, err := api.self(ctx)
	if err != nil {
		return "", taildropPeer{}, err
	}
	if expectedSelf != "" && self != expectedSelf {
		return "", taildropPeer{}, errors.New("Tailscale account or local node changed; transfer stopped")
	}
	peers, err := api.targets(ctx)
	if err != nil {
		return "", taildropPeer{}, err
	}
	for _, peer := range peers {
		if peer.ID != peerID {
			continue
		}
		for _, current := range peer.IPs {
			if current == ip.Unmap().String() {
				return self, peer, nil
			}
		}
		return "", taildropPeer{}, errors.New("selected peer address changed; select the current target again")
	}
	return "", taildropPeer{}, errors.New("selected peer is no longer an eligible Taildrop target")
}

type outgoingEvent struct {
	ID           string
	PeerID       string
	Name         string
	Sent         int64
	DeclaredSize int64
	Finished     bool
	Succeeded    bool
}

func (api *localAPI) watch(ctx context.Context, update func(outgoingEvent), unavailable func()) (func(), error) {
	busCtx, cancel := context.WithCancel(ctx)
	request, err := http.NewRequestWithContext(busCtx, http.MethodGet, "http://local-tailscaled.sock/localapi/v0/watch-ipn-bus?mask=4160", nil)
	if err != nil {
		cancel()
		return nil, err
	}
	connectTimer := time.AfterFunc(5*time.Second, cancel)
	response, err := api.client.Do(request)
	if err != nil {
		connectTimer.Stop()
		cancel()
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		err = responseError(response)
		response.Body.Close()
		connectTimer.Stop()
		cancel()
		return nil, err
	}
	connectTimer.Stop()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer response.Body.Close()
		defer unavailable()
		scanner := bufio.NewScanner(response.Body)
		scanner.Buffer(make([]byte, 16<<10), 1<<20)
		for scanner.Scan() {
			var notification struct{ OutgoingFiles []outgoingEvent }
			if json.Unmarshal(scanner.Bytes(), &notification) != nil || len(notification.OutgoingFiles) > 4096 {
				return
			}
			for _, event := range notification.OutgoingFiles {
				update(event)
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { cancel(); response.Body.Close(); <-done }) }, nil
}

func (api *localAPI) upload(ctx context.Context, peerID string, file transferFile, input *os.File) error {
	// Multipart framing is tiny; the actual file is streamed without a pipe writer
	// goroutine, so cancellation cannot strand a reader holding a source descriptor.
	var framing bytes.Buffer
	multipartWriter := multipart.NewWriter(&framing)
	manifest, err := multipartWriter.CreatePart(textproto.MIMEHeader{"Content-Type": {"application/json"}})
	if err != nil {
		return err
	}
	escaped := url.PathEscape(file.Name)
	if err = json.NewEncoder(manifest).Encode([]outgoingEvent{{ID: file.ID, PeerID: peerID, Name: escaped, DeclaredSize: file.Size}}); err != nil {
		return err
	}
	if _, err = multipartWriter.CreateFormFile("file", escaped); err != nil {
		return err
	}
	prefix := append([]byte(nil), framing.Bytes()...)
	framing.Reset()
	if err = multipartWriter.Close(); err != nil {
		return err
	}
	suffix := append([]byte(nil), framing.Bytes()...)
	body := io.MultiReader(bytes.NewReader(prefix), io.NewSectionReader(input, 0, file.Size), bytes.NewReader(suffix))
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://local-tailscaled.sock/localapi/v0/file-put/"+peerID, body)
	if err != nil {
		return err
	}
	request.ContentLength = int64(len(prefix)) + file.Size + int64(len(suffix))
	request.Header.Set("Content-Type", multipartWriter.FormDataContentType())
	response, err := api.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return responseError(response)
	}
	n, err := io.Copy(io.Discard, io.LimitReader(response.Body, (64<<10)+1))
	if err == nil && n > 64<<10 {
		return errors.New("LocalAPI upload response exceeds limit")
	}
	return err
}

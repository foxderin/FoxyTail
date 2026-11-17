package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const maxReceiveSize int64 = 2 << 30

type waitingFile struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}
type receiveStatus struct {
	Mode    string        `json:"mode"`
	SelfID  string        `json:"selfId"`
	Pending []waitingFile `json:"pending"`
	Error   string        `json:"error,omitempty"`
}

func (api *localAPI) receiveStatus(ctx context.Context) (receiveStatus, error) {
	result := receiveStatus{Mode: "unavailable", Pending: []waitingFile{}}
	self, err := api.self(ctx)
	if err != nil {
		return result, err
	}
	result.SelfID = self
	var pending []waitingFile
	if err = api.getJSON(ctx, "files/", &pending); err != nil {
		return result, err
	}
	if len(pending) > maxInboxFiles {
		return result, errors.New("too many pending received files")
	}
	seen := map[string]bool{}
	for _, f := range pending {
		if !plainName(f.Name) || strings.HasSuffix(f.Name, ".partial") || strings.HasSuffix(f.Name, ".deleted") || f.Size < 0 || seen[f.Name] {
			return result, errors.New("invalid pending received file metadata")
		}
		seen[f.Name] = true
	}
	// The pinned daemon returns an empty list in direct mode. A successful
	// buffered listing must not be confused with that empty direct-mode list.
	direct, err := api.receiveDirect(ctx)
	if err != nil {
		return result, err
	}
	if direct {
		result.Mode = "direct"
	} else {
		result.Mode = "buffered"
		result.Pending = append(result.Pending, pending...)
	}
	current, err := api.self(ctx)
	if err != nil || current != self {
		return receiveStatus{Mode: "unavailable", Pending: []waitingFile{}}, errors.New("account changed during receive status; refresh")
	}
	return result, nil
}

func inboxReceiveStatus(socket string) receiveStatus {
	result := receiveStatus{Mode: "unavailable", Pending: []waitingFile{}}
	api, err := newLocalAPI(socket)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer api.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err = api.receiveStatus(ctx)
	if err != nil {
		result.Mode = "unavailable"
		result.Pending = []waitingFile{}
		result.Error = err.Error()
	}
	return result
}

type receiveResult struct {
	OK            bool   `json:"ok"`
	Name          string `json:"name"`
	Received      bool   `json:"received"`
	SourceDeleted bool   `json:"sourceDeleted"`
	Error         string `json:"error,omitempty"`
}

func (api *localAPI) requireSelf(ctx context.Context, expected string) error {
	self, err := api.self(ctx)
	if err != nil {
		return err
	}
	if self != expected {
		return errors.New("account changed; refresh pending files")
	}
	return nil
}

// completedMatches permits a retry after publication succeeded but the daemon's
// DELETE failed. It never overwrites a different file or follows a symlink.
func completedMatches(root *os.Root, name string, size int64, digest []byte) error {
	file, err := root.OpenFile(name, taildropReadFlags(), 0)
	if err != nil {
		return err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return err
	}
	if !stat.Mode().IsRegular() || stat.Size() != size {
		return errors.New("destination already exists with different contents")
	}
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(file, size+1))
	if err != nil {
		return err
	}
	if n != size || string(hash.Sum(nil)) != string(digest) {
		return errors.New("destination already exists with different contents")
	}
	entry, err := root.Lstat(name)
	if err != nil || !os.SameFile(stat, entry) {
		return errors.New("destination changed during verification")
	}
	return file.Sync()
}

func (api *localAPI) receiveFile(ctx context.Context, root *os.Root, name, expectedSelf string) (receiveResult, error) {
	result := receiveResult{Name: name}
	if !plainName(name) || strings.HasSuffix(name, ".partial") || strings.HasSuffix(name, ".deleted") || !stableNodeID(expectedSelf) {
		return result, errors.New("invalid receive request")
	}
	status, err := api.receiveStatus(ctx)
	if err != nil {
		return result, err
	}
	if status.Mode != "buffered" || status.SelfID != expectedSelf {
		return result, errors.New("receive mode or account changed; refresh pending files")
	}
	size := int64(-1)
	for _, f := range status.Pending {
		if f.Name == name {
			size = f.Size
		}
	}
	if size < 0 {
		return result, errors.New("pending file no longer exists; refresh")
	}
	if size > maxReceiveSize {
		return result, errors.New("pending file exceeds the 2 GiB recovery limit; source retained")
	}
	id, err := randomID()
	if err != nil {
		return result, err
	}
	temporary := ".foxytail-receive-" + id + ".partial"
	output, err := root.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return result, err
	}
	defer func() { output.Close(); root.Remove(temporary) }()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://local-tailscaled.sock/localapi/v0/files/"+url.PathEscape(name), nil)
	if err != nil {
		return result, err
	}
	response, err := api.client.Do(req)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return result, responseError(response)
	}
	if response.ContentLength >= 0 && response.ContentLength != size {
		return result, errors.New("pending file size changed; source retained")
	}
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(output, hash), io.LimitReader(response.Body, size+1))
	if err != nil {
		return result, err
	}
	if n != size {
		return result, errors.New("incomplete or changed received file; source retained")
	}
	if err = output.Sync(); err != nil {
		return result, err
	}
	if err = output.Close(); err != nil {
		return result, err
	}
	if err = api.requireSelf(ctx, expectedSelf); err != nil {
		return result, err
	}
	if err = publishReceive(root, temporary, name); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return result, fmt.Errorf("cannot safely publish received file (source retained): %w", err)
		}
		if err = completedMatches(root, name, size, hash.Sum(nil)); err != nil {
			return result, err
		}
	}
	result.OK = true
	result.Received = true
	// Shared-storage durability is required before removing the daemon's copy.
	if err = syncRoot(root); err != nil {
		result.Error = "File copied, but directory sync failed; source retained: " + err.Error()
		return result, nil
	}
	if err = api.requireSelf(ctx, expectedSelf); err != nil {
		result.Error = "File copied; source retained: " + err.Error()
		return result, nil
	}
	if err = completedMatches(root, name, size, hash.Sum(nil)); err != nil {
		result.Error = "File copied; source retained: " + err.Error()
		return result, nil
	}
	req, err = http.NewRequestWithContext(ctx, http.MethodDelete, "http://local-tailscaled.sock/localapi/v0/files/"+url.PathEscape(name), nil)
	if err != nil {
		return result, err
	}
	response, err = api.client.Do(req)
	if err != nil {
		result.Error = "File copied; source cleanup not confirmed: " + err.Error()
		return result, nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		result.Error = "File copied; source retained: " + responseError(response).Error()
		return result, nil
	}
	result.SourceDeleted = true
	return result, nil
}

func runReceive(args []string) error {
	flags := flag.NewFlagSet("receive", flag.ContinueOnError)
	socket := flags.String("socket", "", "LocalAPI socket")
	path := flags.String("root", "", "shared inbox directory")
	self := flags.String("self", "", "expected account node identity")
	name := flags.String("name", "", "pending filename")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected receive arguments")
	}
	root, err := archiveSourceRoot(*path)
	if err != nil {
		return err
	}
	defer root.Close()
	api, err := newLocalAPI(*socket)
	if err != nil {
		return err
	}
	defer api.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Minute)
	defer cancel()
	result, err := api.receiveFile(ctx, root, *name, *self)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

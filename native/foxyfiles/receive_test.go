package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type receiveFixture struct {
	api           *localAPI
	mode          string
	self          string
	pending       []waitingFile
	data          string
	deleteFail    bool
	changeAccount bool
	deleted       int
	beforeDelete  func()
	shortBody     bool
	cancelRead    context.CancelFunc
}

func newReceiveFixture(t *testing.T) *receiveFixture {
	t.Helper()
	f := &receiveFixture{mode: "buffered", self: "self-1", data: "received content"}
	f.pending = []waitingFile{{"photo.txt", int64(len(f.data))}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/localapi/v0/status":
			json.NewEncoder(w).Encode(map[string]any{"BackendState": "Running", "Self": map[string]string{"ID": f.self}})
		case r.URL.Path == "/localapi/v0/files/":
			if f.mode == "unavailable" {
				http.Error(w, "unavailable", 500)
				return
			}
			if f.mode == "direct" {
				json.NewEncoder(w).Encode(nil)
			} else {
				json.NewEncoder(w).Encode(f.pending)
			}
		case strings.HasPrefix(r.URL.Path, "/localapi/v0/files/.foxytail-mode-probe-"):
			if f.mode == "direct" {
				http.Error(w, "opens not allowed in direct mode", 500)
			} else {
				http.Error(w, "open file: no such file or directory", 500)
			}
		case r.URL.Path == "/localapi/v0/files/photo.txt" && r.Method == "DELETE":
			if f.beforeDelete != nil {
				f.beforeDelete()
			}
			if f.deleteFail {
				http.Error(w, "cleanup failed", 500)
				return
			}
			f.deleted++
			f.pending = nil
			w.WriteHeader(204)
		case r.URL.Path == "/localapi/v0/files/photo.txt" && r.Method == "GET":
			if f.changeAccount {
				f.self = "self-2"
			}
			if f.shortBody {
				w.Header().Set("Content-Length", strconv.Itoa(len(f.data)))
				w.Write([]byte(f.data[:1]))
				return
			}
			if f.cancelRead != nil {
				f.cancelRead()
				return
			}
			w.Write([]byte(f.data))
		default:
			http.Error(w, "unexpected request", 400)
		}
	}))
	t.Cleanup(server.Close)
	client := server.Client()
	client.Transport = rewriteProbeHost{client.Transport, strings.TrimPrefix(server.URL, "http://")}
	f.api = &localAPI{client: client}
	return f
}
func receiveRoot(t *testing.T) (*os.Root, string) {
	t.Helper()
	path := t.TempDir()
	root, err := archiveSourceRoot(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { root.Close() })
	return root, path
}

func TestReceivePublishesBeforeDeleting(t *testing.T) {
	f := newReceiveFixture(t)
	root, path := receiveRoot(t)
	f.beforeDelete = func() {
		data, err := os.ReadFile(filepath.Join(path, "photo.txt"))
		if err != nil || string(data) != f.data {
			t.Error("DELETE occurred before complete shared publication", err)
		}
	}
	result, err := f.api.receiveFile(context.Background(), root, "photo.txt", "self-1")
	if err != nil || !result.Received || !result.SourceDeleted || f.deleted != 1 {
		t.Fatalf("%+v %v", result, err)
	}
	data, err := os.ReadFile(filepath.Join(path, "photo.txt"))
	if err != nil || string(data) != f.data {
		t.Fatalf("%s %v", data, err)
	}
	entries, _ := os.ReadDir(path)
	if len(entries) != 1 {
		t.Fatalf("temporary files leaked: %v", entries)
	}
}
func TestReceiveConflictNeverOverwrites(t *testing.T) {
	f := newReceiveFixture(t)
	root, path := receiveRoot(t)
	os.WriteFile(filepath.Join(path, "photo.txt"), []byte("keep original"), 0600)
	_, err := f.api.receiveFile(context.Background(), root, "photo.txt", "self-1")
	if err == nil || f.deleted != 0 {
		t.Fatalf("conflict removed source: %v", err)
	}
	data, _ := os.ReadFile(filepath.Join(path, "photo.txt"))
	if string(data) != "keep original" {
		t.Fatal("overwritten")
	}
}
func TestReceiveCleanupFailureCanRetryIdenticalCopy(t *testing.T) {
	f := newReceiveFixture(t)
	root, _ := receiveRoot(t)
	f.deleteFail = true
	result, err := f.api.receiveFile(context.Background(), root, "photo.txt", "self-1")
	if err != nil || !result.Received || result.SourceDeleted || result.Error == "" {
		t.Fatalf("%+v %v", result, err)
	}
	f.deleteFail = false
	result, err = f.api.receiveFile(context.Background(), root, "photo.txt", "self-1")
	if err != nil || !result.SourceDeleted || f.deleted != 1 {
		t.Fatalf("retry %+v %v", result, err)
	}
}
func TestReceiveRejectsIncompleteChangedAndLargeSources(t *testing.T) {
	for _, mode := range []string{"truncated", "oversized", "account", "symlink"} {
		t.Run(mode, func(t *testing.T) {
			f := newReceiveFixture(t)
			root, path := receiveRoot(t)
			switch mode {
			case "truncated":
				f.pending[0].Size++
			case "oversized":
				f.pending[0].Size = maxReceiveSize + 1
			case "account":
				f.changeAccount = true
			case "symlink":
				os.Symlink("/outside", filepath.Join(path, "photo.txt"))
			}
			_, err := f.api.receiveFile(context.Background(), root, "photo.txt", "self-1")
			if err == nil || f.deleted != 0 {
				t.Fatalf("unsafe receive: %v", err)
			}
			entries, _ := os.ReadDir(path)
			for _, e := range entries {
				if strings.HasSuffix(e.Name(), ".partial") {
					t.Fatal("partial leaked")
				}
			}
		})
	}
}
func TestReceiveInvalidNamesAndAccount(t *testing.T) {
	for _, name := range []string{"../escape", "thing.partial", "photo.txt"} {
		t.Run(name, func(t *testing.T) {
			f := newReceiveFixture(t)
			root, _ := receiveRoot(t)
			if _, err := f.api.receiveFile(context.Background(), root, name, "wrong-self"); err == nil || f.deleted != 0 {
				t.Fatalf("invalid request accepted: %v", err)
			}
		})
	}
}

func TestReceiveInterruptedStreamRetainsSource(t *testing.T) {
	for _, mode := range []string{"short-body", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			f := newReceiveFixture(t)
			root, path := receiveRoot(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "short-body" {
				f.shortBody = true
			} else {
				f.cancelRead = cancel
			}
			if _, err := f.api.receiveFile(ctx, root, "photo.txt", "self-1"); err == nil {
				t.Fatal("interrupted stream succeeded")
			}
			if f.deleted != 0 {
				t.Fatal("interruption deleted daemon source")
			}
			entries, _ := os.ReadDir(path)
			if len(entries) != 0 {
				t.Fatalf("partial published/leaked: %v", entries)
			}
		})
	}
}

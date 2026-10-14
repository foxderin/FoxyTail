package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && (os.Args[1] == "send-worker" || os.Args[1] == "send-start" || os.Args[1] == "send-status" || os.Args[1] == "send-cancel" || os.Args[1] == "send-history" || os.Args[1] == "send-delete" || os.Args[1] == "send-clear" || os.Args[1] == "send-stop") {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type localFixture struct {
	socket           string
	events           chan outgoingEvent
	puts             atomic.Int32
	self             atomic.Value
	watchUnavailable atomic.Bool
	mu               sync.RWMutex
	put              func(http.ResponseWriter, *http.Request, outgoingEvent, []byte)
}

func (fixture *localFixture) setPut(handler func(http.ResponseWriter, *http.Request, outgoingEvent, []byte)) {
	fixture.mu.Lock()
	fixture.put = handler
	fixture.mu.Unlock()
}

func newLocalFixture(t *testing.T) *localFixture {
	t.Helper()
	base, err := os.MkdirTemp("/tmp", "foxyfiles-unix-")
	if err != nil {
		t.Fatal(err)
	}
	fixture := &localFixture{socket: filepath.Join(base, "api.sock"), events: make(chan outgoingEvent, 32)}
	fixture.self.Store("nSelf123")
	listener, err := net.Listen("unix", fixture.socket)
	if err != nil {
		os.RemoveAll(base)
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "local-tailscaled.sock" {
			http.Error(w, "wrong host", 403)
			return
		}
		switch r.URL.Path {
		case "/localapi/v0/status":
			json.NewEncoder(w).Encode(map[string]any{"BackendState": "Running", "Self": map[string]string{"ID": fixture.self.Load().(string)}})
		case "/localapi/v0/file-targets":
			io.WriteString(w, `[{"Node":{"StableID":"nPeer123","Name":"peer.example.ts.net.","Addresses":["100.64.0.2/32","fd7a:115c:a1e0::2/128"],"Online":true},"PeerAPIURL":"http://100.64.0.2:1234"}]`)
		case "/localapi/v0/watch-ipn-bus":
			if r.URL.Query().Get("mask") != "4160" {
				http.Error(w, "wrong mask", 400)
				return
			}
			if fixture.watchUnavailable.Load() {
				http.Error(w, "bus disabled", 503)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.(http.Flusher).Flush()
			for {
				select {
				case event := <-fixture.events:
					if err := json.NewEncoder(w).Encode(map[string]any{"OutgoingFiles": []outgoingEvent{event}}); err != nil {
						return
					}
					w.(http.Flusher).Flush()
				case <-r.Context().Done():
					return
				}
			}
		case "/localapi/v0/file-put/nPeer123":
			fixture.puts.Add(1)
			if r.Method != http.MethodPost {
				http.Error(w, "not multipart POST", 400)
				return
			}
			reader, err := r.MultipartReader()
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			manifestPart, err := reader.NextPart()
			if err != nil || manifestPart.Header.Get("Content-Type") != "application/json" {
				http.Error(w, "missing manifest", 400)
				return
			}
			var manifest []outgoingEvent
			if err = json.NewDecoder(manifestPart).Decode(&manifest); err != nil || len(manifest) != 1 || !validID(manifest[0].ID) || manifest[0].PeerID != "nPeer123" {
				http.Error(w, "invalid manifest", 400)
				return
			}
			part, err := reader.NextPart()
			if err != nil || part.FileName() != manifest[0].Name {
				http.Error(w, "escaped file name mismatch", 400)
				return
			}
			data, err := io.ReadAll(part)
			if err != nil || int64(len(data)) != manifest[0].DeclaredSize {
				http.Error(w, "file size mismatch", 400)
				return
			}
			if _, err = reader.NextPart(); err != io.EOF {
				http.Error(w, "extra part", 400)
				return
			}
			fixture.mu.RLock()
			handler := fixture.put
			fixture.mu.RUnlock()
			if handler != nil {
				handler(w, r, manifest[0], data)
				return
			}
			w.WriteHeader(204)
		default:
			http.NotFound(w, r)
		}
	})}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close(); listener.Close(); os.RemoveAll(base) })
	return fixture
}

func testTransferRecord(t *testing.T, root, source, socket string, paths []string) *transferRecord {
	t.Helper()
	id, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	record := &transferRecord{transfer: transfer{ID: id, PeerID: "nPeer123", PeerName: "peer.example.ts.net", PeerIP: "100.64.0.2", SelfID: "nSelf123", Status: "queued", StartedAt: now, UpdatedAt: now}, Socket: socket, Source: source}
	for _, path := range paths {
		opened, err := openSendSource(root, source, path)
		if err != nil {
			t.Fatal(err)
		}
		fileID, err := randomID()
		if err != nil {
			t.Fatal(err)
		}
		record.Files = append(record.Files, transferFile{ID: fileID, Name: opened.name, Path: path, Size: opened.before.Size(), Status: "queued"})
		record.Identities = append(record.Identities, identity(opened.before))
		opened.Close()
	}
	return record
}

func testSendFiles(t *testing.T, names ...string) (string, []string) {
	t.Helper()
	shared := t.TempDir()
	paths := []string{}
	for _, name := range names {
		path := filepath.Join(shared, name)
		if err := os.WriteFile(path, []byte("file payload: "+name), 0600); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, path)
	}
	return shared, paths
}

func testExecute(t *testing.T, root string, record *transferRecord) *transferRecord {
	t.Helper()
	store, err := openTransferStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	lock, err := store.activeLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err = store.save(record); err != nil {
		t.Fatal(err)
	}
	if err = executeTransfer(context.Background(), store, record); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.load(record.ID)
	if err != nil {
		t.Fatal(err)
	}
	return loaded
}

func TestLocalAPIMultipartHTTPAuthorityAndFailedOnlyRetry(t *testing.T) {
	fixture := newLocalFixture(t)
	root := t.TempDir()
	shared, paths := testSendFiles(t, "failed #%.txt", "good.txt")
	fixture.setPut(func(w http.ResponseWriter, r *http.Request, event outgoingEvent, data []byte) {
		name, err := url.PathUnescape(event.Name)
		if err != nil || string(data) != "file payload: "+name {
			http.Error(w, "bad encoded name or payload", 400)
			return
		}
		event.Sent, event.Finished, event.Succeeded = event.DeclaredSize, true, true
		fixture.events <- event
		if strings.HasPrefix(name, "failed") {
			http.Error(w, "upstream rejected despite Succeeded event", 500)
			return
		}
		w.WriteHeader(204)
	})
	record := testTransferRecord(t, root, shared, fixture.socket, paths)
	loaded := testExecute(t, root, record)
	if loaded.Status != "failed" || loaded.Files[0].Status != "failed" || loaded.Files[1].Status != "completed" || fixture.puts.Load() != 2 {
		t.Fatalf("HTTP authority/continue: %+v", loaded)
	}
	if loaded.Files[1].SentBytes != loaded.Files[1].Size || !loaded.Files[1].ProgressKnown {
		t.Fatal("successful HTTP response did not finalize progress")
	}
	for _, path := range paths {
		if _, err := os.Stat(path); err != nil {
			t.Fatal("shared source removed", err)
		}
	}
	fixture.setPut(nil)
	retry := testTransferRecord(t, root, shared, fixture.socket, []string{loaded.Files[0].Path})
	loaded = testExecute(t, root, retry)
	if loaded.Status != "completed" || len(loaded.Files) != 1 || fixture.puts.Load() != 3 {
		t.Fatalf("failed-only retry: %+v", loaded)
	}
}

func TestLocalAPIAccountAndSourceRevalidation(t *testing.T) {
	fixture := newLocalFixture(t)
	root := t.TempDir()
	shared, paths := testSendFiles(t, "first", "second")
	fixture.setPut(func(w http.ResponseWriter, r *http.Request, event outgoingEvent, data []byte) {
		fixture.self.Store("nOtherAccount")
		w.WriteHeader(204)
	})
	loaded := testExecute(t, root, testTransferRecord(t, root, shared, fixture.socket, paths))
	if loaded.Status != "failed" || loaded.Files[0].Status != "completed" || loaded.Files[1].Status != "failed" || fixture.puts.Load() != 1 {
		t.Fatalf("account changed: %+v", loaded)
	}
	fixture.self.Store("nSelf123")
	fixture.setPut(nil)
	record := testTransferRecord(t, root, shared, fixture.socket, []string{paths[1]})
	if err := os.Remove(paths[1]); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths[1], []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	loaded = testExecute(t, root, record)
	if loaded.Status != "failed" || fixture.puts.Load() != 1 {
		t.Fatal("replaced source uploaded", loaded)
	}
	api, err := newLocalAPI(fixture.socket)
	if err != nil {
		t.Fatal(err)
	}
	defer api.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for _, peer := range []struct{ id, address string }{{"nOtherPeer", "100.64.0.2"}, {"nPeer123", "100.64.0.9"}} {
		if _, _, err := api.validatePeer(ctx, peer.id, peer.address, "nSelf123"); err == nil {
			t.Fatal("accepted stale peer", peer)
		}
	}
}

func TestOutgoingProgressRequiresExactIDAndPeer(t *testing.T) {
	root := t.TempDir()
	shared, paths := testSendFiles(t, "same-name")
	store, err := openTransferStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	record := testTransferRecord(t, root, shared, "", paths)
	record.Status, record.Files[0].Status = "sending", "sending"
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	progress := &transferProgress{store: store, record: record, current: 0, cancel: cancel, observed: time.Now().Add(-time.Second)}
	good := outgoingEvent{ID: record.Files[0].ID, PeerID: record.PeerID, Name: record.Files[0].Name, DeclaredSize: record.Files[0].Size, Sent: 5}
	wrong := good
	wrong.ID = strings.Repeat("a", 32)
	progress.update(wrong)
	wrong = good
	wrong.PeerID = "nAnother"
	progress.update(wrong)
	if record.Files[0].ProgressKnown || record.Files[0].SentBytes != 0 {
		t.Fatal("accepted unrelated outgoing event")
	}
	progress.update(good)
	if !record.Files[0].ProgressKnown || record.Files[0].SentBytes != 5 || record.Files[0].BytesPerSecond <= 0 || ctx.Err() != nil {
		t.Fatal("exact outgoing event not recorded", record.Files[0], ctx.Err())
	}
	good.Sent = record.Files[0].Size + 100
	good.Finished, good.Succeeded = true, true
	progress.update(good)
	if record.Files[0].SentBytes != record.Files[0].Size || record.Files[0].Status != "sending" {
		t.Fatal("event fabricated completion or exceeded file size")
	}
	progress.unavailable()
	if record.Files[0].ProgressKnown {
		t.Fatal("unavailable bus left progress known")
	}
}

func TestDetachedWorkerCancelAndInterruption(t *testing.T) {
	fixture := newLocalFixture(t)
	root := t.TempDir()
	shared, paths := testSendFiles(t, "first", "second")
	entered := make(chan struct{}, 1)
	fixture.setPut(func(w http.ResponseWriter, r *http.Request, event outgoingEvent, data []byte) {
		entered <- struct{}{}
		<-r.Context().Done()
	})
	pathsJSON, _ := json.Marshal(paths)
	launcher := exec.Command(os.Args[0], "send-start", "--root", root, "--source", shared, "--socket", fixture.socket, "--peer", "nPeer123", "--address", "100.64.0.2", "--paths", string(pathsJSON))
	output, err := launcher.CombinedOutput()
	if err != nil {
		t.Fatalf("launch: %s %v", output, err)
	}
	var started struct {
		OK       bool     `json:"ok"`
		Transfer transfer `json:"transfer"`
	}
	if err = json.Unmarshal(output, &started); err != nil || !started.OK || !validID(started.Transfer.ID) {
		t.Fatalf("start JSON: %s %v", output, err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		exec.CommandContext(ctx, os.Args[0], "send-stop", "--root", root).Run()
	})
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("detached worker did not upload after launcher exited")
	}
	store, err := openTransferStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if lock, err := store.activeLock(); err == nil {
		lock.Close()
		t.Fatal("worker lost inherited lock")
	} else if !lockBusy(err) {
		t.Fatal(err)
	}
	if _, err = startTransfer(root, fixture.socket, shared, "nPeer123", "100.64.0.2", string(pathsJSON)); err == nil {
		t.Fatal("accepted overlapping worker")
	}
	cancelCommand := exec.Command(os.Args[0], "send-cancel", "--root", root, "--id", started.Transfer.ID)
	if output, err = cancelCommand.CombinedOutput(); err != nil {
		t.Fatalf("cancel: %s %v", output, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		record, err := store.load(started.Transfer.ID)
		if err != nil {
			t.Fatal(err)
		}
		if !activeTransfer(record.Status) {
			if record.Status != "cancelled" || record.Files[0].Status != "cancelled" || record.Files[1].Status != "cancelled" || fixture.puts.Load() != 1 {
				t.Fatalf("cancel state: %+v", record)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("worker did not acknowledge cancellation")
		}
		time.Sleep(20 * time.Millisecond)
	}
	stopCommand := exec.Command(os.Args[0], "send-stop", "--root", root)
	if output, err = stopCommand.CombinedOutput(); err != nil {
		t.Fatalf("stop: %s %v", output, err)
	}
	historyCommand := exec.Command(os.Args[0], "send-history", "--root", root)
	if output, err = historyCommand.CombinedOutput(); err != nil || !strings.Contains(string(output), `"cancelled"`) {
		t.Fatalf("history after UI/process exit: %s %v", output, err)
	}
}

func TestBusUnavailableStaysUnknownUntilHTTPAndStageSuccessCleans(t *testing.T) {
	fixture := newLocalFixture(t)
	fixture.watchUnavailable.Store(true)
	root := t.TempDir()
	staged, err := stageFile(root, "zero", 0, strings.NewReader(""))
	if err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	fixture.setPut(func(w http.ResponseWriter, r *http.Request, event outgoingEvent, data []byte) {
		once.Do(func() {
			store, err := openTransferStore(root)
			if err != nil {
				t.Error(err)
				return
			}
			defer store.Close()
			records, err := store.records()
			if err != nil || len(records) != 1 {
				t.Error("missing active record", err)
				return
			}
			if records[0].Files[0].ProgressKnown || records[0].Files[0].Status != "sending" {
				t.Error("fabricated progress before HTTP success")
			}
		})
		w.WriteHeader(204)
	})
	loaded := testExecute(t, root, testTransferRecord(t, root, t.TempDir(), fixture.socket, []string{staged.Path}))
	if loaded.Status != "completed" || !loaded.Files[0].ProgressKnown || loaded.Files[0].SentBytes != 0 {
		t.Fatalf("zero file: %+v", loaded)
	}
	if _, err = os.Stat(staged.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("successful private stage retained", err)
	}
}

func TestTransferHistoryBoundedAndInstallingRejected(t *testing.T) {
	fixture := newLocalFixture(t)
	root := t.TempDir()
	shared, paths := testSendFiles(t, "one")
	store, err := openTransferStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for index := range 103 {
		record := testTransferRecord(t, root, shared, fixture.socket, paths)
		record.Status, record.Files[0].Status = "failed", "failed"
		record.StartedAt += int64(index)
		if err = store.save(record); err != nil {
			t.Fatal(err)
		}
	}
	guard, err := store.guard()
	if err != nil {
		t.Fatal(err)
	}
	err = store.maintain()
	guard.Close()
	if err != nil {
		t.Fatal(err)
	}
	records, err := store.records()
	if err != nil || len(records) > 100 {
		t.Fatalf("history unbounded: %d %v", len(records), err)
	}
	if err = os.WriteFile(filepath.Join(root, ".installing"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	pathsJSON, _ := json.Marshal(paths)
	if _, err = startTransfer(root, fixture.socket, shared, "nPeer123", "100.64.0.2", string(pathsJSON)); err == nil || !strings.Contains(err.Error(), "upgrade") {
		t.Fatal("upgrade boundary ignored", err)
	}
	if err = decodeBoundedJSON(strings.NewReader(`{"ok":true} {}`), 100, new(any)); err == nil {
		t.Fatal("accepted trailing JSON")
	}
	if err = decodeBoundedJSON(strings.NewReader(`{"ok":true}`), 3, new(any)); err == nil {
		t.Fatal("accepted oversized JSON")
	}
}

func TestUnixBusDeliversExactOutgoingBytesBeforeHTTPCompletion(t *testing.T) {
	fixture := newLocalFixture(t)
	api, err := newLocalAPI(fixture.socket)
	if err != nil {
		t.Fatal(err)
	}
	defer api.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	updates := make(chan outgoingEvent, 4)
	stop, err := api.watch(ctx, func(event outgoingEvent) { updates <- event }, func() {})
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	id, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	wanted := outgoingEvent{ID: id, PeerID: "nPeer123", Name: "ignored-for-correlation", Sent: 7, DeclaredSize: 10}
	fixture.events <- wanted
	select {
	case event := <-updates:
		if event != wanted {
			t.Fatalf("bus event changed: %+v", event)
		}
	case <-ctx.Done():
		t.Fatal("no daemon outgoing event observed")
	}
}

func TestPrivateStageDeleteRejectsActiveClaim(t *testing.T) {
	root := t.TempDir()
	stage, err := stageFile(root, "claimed", 3, strings.NewReader("abc"))
	if err != nil {
		t.Fatal(err)
	}
	store, err := openTransferStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	active, err := store.activeLock()
	if err != nil {
		t.Fatal(err)
	}
	defer active.Close()
	record := testTransferRecord(t, root, t.TempDir(), "", []string{stage.Path})
	if err = store.save(record); err != nil {
		t.Fatal(err)
	}
	if err = runStageDelete([]string{"--root", root, "--path", stage.Path}); err == nil {
		t.Fatal("deleted a source claimed by live worker")
	}
	if _, err = os.Stat(stage.Path); err != nil {
		t.Fatal("active stage disappeared", err)
	}
}

func TestSourceChangesDuringHTTPUploadAreNotReportedSuccessful(t *testing.T) {
	fixture := newLocalFixture(t)
	root := t.TempDir()
	shared, paths := testSendFiles(t, "changing")
	fixture.setPut(func(w http.ResponseWriter, r *http.Request, event outgoingEvent, data []byte) {
		if err := os.WriteFile(paths[0], []byte("changed while in flight"), 0600); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.WriteHeader(204)
	})
	loaded := testExecute(t, root, testTransferRecord(t, root, shared, fixture.socket, paths))
	if loaded.Status != "failed" || loaded.Files[0].Status != "failed" || !strings.Contains(loaded.Files[0].Error, "changed") {
		t.Fatalf("mutable source reported successful: %+v", loaded)
	}
}

func TestWorkerDeathRecoveredFromReleasedLock(t *testing.T) {
	fixture := newLocalFixture(t)
	root := t.TempDir()
	shared, paths := testSendFiles(t, "crash", "never-started")
	entered := make(chan struct{}, 1)
	fixture.setPut(func(w http.ResponseWriter, r *http.Request, event outgoingEvent, data []byte) {
		entered <- struct{}{}
		<-r.Context().Done()
	})
	store, err := openTransferStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	active, err := store.activeLock()
	if err != nil {
		t.Fatal(err)
	}
	defer active.Close()
	record := testTransferRecord(t, root, shared, fixture.socket, paths)
	if err = store.save(record); err != nil {
		t.Fatal(err)
	}
	worker := exec.Command(os.Args[0], "send-worker", "--root", root, "--id", record.ID)
	worker.ExtraFiles = []*os.File{active}
	if err = worker.Start(); err != nil {
		t.Fatal(err)
	}
	active.Close()
	defer func() { worker.Process.Kill(); worker.Wait() }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not reach upload")
	}
	if err = worker.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	worker.Wait()
	corruptOtherTransfer(t, root)
	result := queryTransfer(t, root, "send-status", record.ID)
	if result.Status != "interrupted" {
		t.Fatalf("crashed worker query returned active state: %+v", result)
	}
	loaded, err := store.load(record.ID)
	if err != nil || loaded.Status != "interrupted" || loaded.Files[0].Status != "failed" || loaded.Files[1].Status != "failed" {
		t.Fatalf("crashed worker left active state: %+v %v", loaded, err)
	}
}

package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func queryTransfer(t *testing.T, root, command, id string) transfer {
	t.Helper()
	output, err := exec.Command(os.Args[0], command, "--root", root, "--id", id).CombinedOutput()
	if err != nil {
		t.Fatalf("%s: %s %v", command, output, err)
	}
	var result struct {
		OK       bool     `json:"ok"`
		Transfer transfer `json:"transfer"`
	}
	if err := json.Unmarshal(output, &result); err != nil || !result.OK || result.Transfer.ID != id {
		t.Fatalf("%s response: %s %v", command, output, err)
	}
	return result.Transfer
}

func corruptOtherTransfer(t *testing.T, root string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, "state", "taildrop", strings.Repeat("f", 32)+".json"), []byte("not JSON"), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestActiveTransferQueriesStayTargetedAndKeepWorkerOwnership(t *testing.T) {
	root := t.TempDir()
	shared, paths := testSendFiles(t, "sending")
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
	record := testTransferRecord(t, root, shared, "", paths)
	record.Status, record.Files[0].Status = "sending", "sending"
	record.Files[0].SentBytes, record.Files[0].BytesPerSecond, record.Files[0].ProgressKnown = 3, 2, true
	if err := store.save(record); err != nil {
		t.Fatal(err)
	}
	corruptOtherTransfer(t, root)
	for _, command := range []string{"send-status", "send-cancel", "send-cancel", "send-status"} {
		got := queryTransfer(t, root, command, record.ID)
		if !reflect.DeepEqual(got, record.transfer) {
			t.Fatalf("healthy worker was recovered or progress changed: %+v", got)
		}
		if next, err := store.activeLock(); !lockBusy(err) {
			if next != nil {
				next.Close()
			}
			t.Fatal("query replaced or released worker ownership", err)
		}
	}
	if cancelled, err := store.cancelled(record.ID); err != nil || !cancelled {
		t.Fatal("targeted cancellation marker missing", err)
	}
	if err := store.root.Remove(record.ID + ".cancel"); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "keep")
	if err := os.WriteFile(outside, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "state", "taildrop", record.ID+".cancel")); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(os.Args[0], "send-cancel", "--root", root, "--id", record.ID).CombinedOutput(); err == nil {
		t.Fatalf("accepted unsafe cancel marker: %s", output)
	}
	if body, err := os.ReadFile(outside); err != nil || string(body) != "keep" {
		t.Fatal("cancel followed marker symlink", err)
	}
}

func TestTransferQueryRecoversOnlyRequestedOrphan(t *testing.T) {
	for _, command := range []string{"send-status", "send-cancel"} {
		for _, status := range []string{"queued", "sending"} {
			t.Run(command+"/"+status, func(t *testing.T) {
				root := t.TempDir()
				shared, paths := testSendFiles(t, "done", "partial", "queued")
				store, err := openTransferStore(root)
				if err != nil {
					t.Fatal(err)
				}
				defer store.Close()
				record := testTransferRecord(t, root, shared, "", paths)
				record.Status = status
				record.UpdatedAt = 1
				record.Files[0].Status, record.Files[0].ProgressKnown = "completed", true
				record.Files[0].SentBytes = record.Files[0].Size
				record.Files[1].Status, record.Files[1].ProgressKnown = "sending", true
				record.Files[1].SentBytes, record.Files[1].BytesPerSecond = 3, 2
				if err := store.save(record); err != nil {
					t.Fatal(err)
				}
				if err := store.requestCancel(record.ID); err != nil {
					t.Fatal(err)
				}
				other := testTransferRecord(t, root, shared, "", paths)
				if err := store.save(other); err != nil {
					t.Fatal(err)
				}
				corruptOtherTransfer(t, root)
				got := queryTransfer(t, root, command, record.ID)
				if got.Status != "interrupted" || got.Error == "" || got.UpdatedAt <= 1 || !reflect.DeepEqual(got.Files[0], record.Files[0]) {
					t.Fatalf("incorrect recovered result: %+v", got)
				}
				for _, file := range got.Files[1:] {
					if file.Status != "failed" || file.Error != got.Error || file.BytesPerSecond != 0 {
						t.Fatalf("unfinished source not recovered: %+v", file)
					}
				}
				if got.Files[1].SentBytes != 3 || !got.Files[1].ProgressKnown {
					t.Fatalf("recovery lost observed progress: %+v", got.Files[1])
				}
				persisted, err := store.load(record.ID)
				if err != nil || !reflect.DeepEqual(persisted.transfer, got) {
					t.Fatal("recovered result not durable", err)
				}
				if cancelled, err := store.cancelled(record.ID); err != nil || cancelled {
					t.Fatal("recovered transfer retained cancel marker", err)
				}
				unchanged, err := store.load(other.ID)
				if err != nil || !reflect.DeepEqual(unchanged, other) {
					t.Fatal("targeted query touched other record", err)
				}
				lock, err := store.activeLock()
				if err != nil {
					t.Fatal("recovery leaked active lock", err)
				}
				lock.Close()
			})
		}
	}
}

func TestTransferHistoryRemovalPreservesActiveSourcesAndStages(t *testing.T) {
	for _, workerOwned := range []bool{false, true} {
		t.Run(map[bool]string{false: "orphan", true: "worker"}[workerOwned], func(t *testing.T) {
			root := t.TempDir()
			shared, paths := testSendFiles(t, "original")
			stage, err := stageFile(root, "retry", 3, strings.NewReader("abc"))
			if err != nil {
				t.Fatal(err)
			}
			old := time.Now().Add(-25 * time.Hour)
			if err := os.Chtimes(filepath.Dir(stage.Path), old, old); err != nil {
				t.Fatal(err)
			}
			store, err := openTransferStore(root)
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			if workerOwned {
				active, err := store.activeLock()
				if err != nil {
					t.Fatal(err)
				}
				defer active.Close()
			}
			records := []*transferRecord{}
			for _, status := range []string{"queued", "sending", "completed", "failed", "cancelled", "interrupted"} {
				record := testTransferRecord(t, root, shared, "", append(paths, stage.Path))
				record.Status = status
				if err := store.save(record); err != nil {
					t.Fatal(err)
				}
				if err := store.requestCancel(record.ID); err != nil {
					t.Fatal(err)
				}
				records = append(records, record)
			}
			for _, record := range records[:2] {
				output, err := exec.Command(os.Args[0], "send-delete", "--root", root, "--id", record.ID).CombinedOutput()
				if err == nil || !strings.Contains(string(output), "active transfer") {
					t.Fatalf("active deletion: %s %v", output, err)
				}
			}
			assertRemoval := func(command, id string, removed int) {
				t.Helper()
				args := []string{command, "--root", root}
				if id != "" {
					args = append(args, "--id", id)
				}
				output, err := exec.Command(os.Args[0], args...).CombinedOutput()
				var result struct {
					OK       bool `json:"ok"`
					Removed  int  `json:"removed"`
					Retained int  `json:"retained"`
				}
				if err != nil || json.Unmarshal(output, &result) != nil || !result.OK || result.Removed != removed || result.Retained != 2 {
					t.Fatalf("%s: %s %v", command, output, err)
				}
			}
			assertRemoval("send-delete", records[2].ID, 1)
			if output, err := exec.Command(os.Args[0], "send-delete", "--root", root, "--id", records[2].ID).CombinedOutput(); err == nil || !strings.Contains(string(output), "not found") {
				t.Fatalf("missing deletion: %s %v", output, err)
			}
			assertRemoval("send-clear", "", 3)
			assertRemoval("send-clear", "", 0)
			for _, record := range records {
				got, err := store.load(record.ID)
				if activeTransfer(record.Status) {
					if err != nil || !reflect.DeepEqual(got, record) {
						t.Fatalf("active record changed: %+v %v", got, err)
					}
					if cancelled, err := store.cancelled(record.ID); err != nil || !cancelled {
						t.Fatal("active cancellation lost", err)
					}
				} else {
					if !errors.Is(err, os.ErrNotExist) {
						t.Fatal("terminal metadata retained", err)
					}
					if cancelled, err := store.cancelled(record.ID); err != nil || cancelled {
						t.Fatal("terminal cancellation retained", err)
					}
				}
			}
			for path, expected := range map[string]string{paths[0]: "file payload: original", stage.Path: "abc"} {
				if body, err := os.ReadFile(path); err != nil || string(body) != expected {
					t.Fatalf("source/stage modified: %s %v", path, err)
				}
			}
			if workerOwned {
				if lock, err := store.activeLock(); !lockBusy(err) {
					if lock != nil {
						lock.Close()
					}
					t.Fatal("history removal released worker ownership", err)
				}
			}
		})
	}
}

func TestTransferHistoryRemovalRejectsUnsafeMetadata(t *testing.T) {
	for _, command := range []string{"send-delete", "send-clear"} {
		for _, invalid := range []string{"cancel-symlink", "unknown-status"} {
			t.Run(command+"/"+invalid, func(t *testing.T) {
				root := t.TempDir()
				shared, paths := testSendFiles(t, "keep")
				store, err := openTransferStore(root)
				if err != nil {
					t.Fatal(err)
				}
				defer store.Close()
				record := testTransferRecord(t, root, shared, "", paths)
				record.Status = "completed"
				if invalid == "unknown-status" {
					record.Status = "unrecognized"
				}
				if err := store.save(record); err != nil {
					t.Fatal(err)
				}
				if invalid == "cancel-symlink" {
					if err := os.Symlink(paths[0], filepath.Join(root, "state", "taildrop", record.ID+".cancel")); err != nil {
						t.Fatal(err)
					}
				}
				args := []string{command, "--root", root}
				if command == "send-delete" {
					args = append(args, "--id", record.ID)
				}
				if output, err := exec.Command(os.Args[0], args...).CombinedOutput(); err == nil {
					t.Fatalf("accepted unsafe metadata: %s", output)
				}
				if got, err := store.load(record.ID); err != nil || !reflect.DeepEqual(got, record) {
					t.Fatal("validation failure deleted valid metadata", err)
				}
				if body, err := os.ReadFile(paths[0]); err != nil || string(body) != "file payload: keep" {
					t.Fatal("validation followed source path", err)
				}
			})
		}
	}
	for _, id := range []string{"", "../outside", strings.Repeat("a", 31), strings.Repeat("z", 32)} {
		if output, err := exec.Command(os.Args[0], "send-delete", "--root", t.TempDir(), "--id", id).CombinedOutput(); err == nil || !strings.Contains(string(output), "invalid transfer ID") {
			t.Fatalf("invalid ID %q: %s %v", id, output, err)
		}
	}
}

type shortWriter struct{}

func (shortWriter) Write(p []byte) (int, error) { return len(p) - 1, nil }

func TestCorruptRecordQuarantinedAndAuxSwept(t *testing.T) {
	root := t.TempDir()
	shared, paths := testSendFiles(t, "one")
	store, err := openTransferStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	record := testTransferRecord(t, root, shared, "", paths)
	record.Status, record.Files[0].Status = "completed", "completed"
	if err := store.save(record); err != nil {
		t.Fatal(err)
	}
	corruptOtherTransfer(t, root)
	stateDir := filepath.Join(root, "state", "taildrop")
	orphanID := strings.Repeat("b", 32)
	old := time.Now().Add(-25 * time.Hour)
	for name, stale := range map[string]bool{".write-stale": true, orphanID + ".cancel": true} {
		path := filepath.Join(stateDir, name)
		if err := os.WriteFile(path, []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
		if stale {
			if err := os.Chtimes(path, old, old); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := store.requestCancel(record.ID); err != nil {
		t.Fatal(err)
	}
	records, err := store.records()
	if err != nil || len(records) != 1 || records[0].ID != record.ID {
		t.Fatalf("corrupt record wedged listing: %d %v", len(records), err)
	}
	corruptPath := filepath.Join(stateDir, strings.Repeat("f", 32)+".corrupt")
	if _, err := os.Lstat(filepath.Join(stateDir, strings.Repeat("f", 32)+".json")); !os.IsNotExist(err) {
		t.Fatal("corrupt record left in place", err)
	}
	if _, err := os.Lstat(corruptPath); err != nil {
		t.Fatal("corrupt record not quarantined", err)
	}
	guard, err := store.guard()
	if err != nil {
		t.Fatal(err)
	}
	if err = store.maintain(); err != nil {
		guard.Close()
		t.Fatal(err)
	}
	guard.Close()
	for _, name := range []string{".write-stale", orphanID + ".cancel"} {
		if _, err := os.Lstat(filepath.Join(stateDir, name)); !os.IsNotExist(err) {
			t.Fatal("stale aux retained", name, err)
		}
	}
	if cancelled, err := store.cancelled(record.ID); err != nil || !cancelled {
		t.Fatal("record cancellation swept", err)
	}
	if _, err := os.Lstat(corruptPath); err != nil {
		t.Fatal("fresh quarantine swept early", err)
	}
	if err := os.Chtimes(corruptPath, old, old); err != nil {
		t.Fatal(err)
	}
	guard, err = store.guard()
	if err != nil {
		t.Fatal(err)
	}
	if err = store.maintain(); err != nil {
		guard.Close()
		t.Fatal(err)
	}
	guard.Close()
	if _, err := os.Lstat(corruptPath); !os.IsNotExist(err) {
		t.Fatal("aged quarantine retained", err)
	}
}

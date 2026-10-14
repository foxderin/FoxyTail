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

func TestFinalTransferQueriesIgnoreUnrelatedHistoryAndActiveLock(t *testing.T) {
	root := t.TempDir()
	shared, paths := testSendFiles(t, "finished")
	store, err := openTransferStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	corruptOtherTransfer(t, root)
	outside := filepath.Join(t.TempDir(), "lock-target")
	if err := os.WriteFile(outside, []byte("untouched"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "state", "taildrop", "active.lock")); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"completed", "failed", "cancelled", "interrupted"} {
		t.Run(status, func(t *testing.T) {
			record := testTransferRecord(t, root, shared, "", paths)
			record.Status, record.Files[0].Status = status, status
			if err := store.save(record); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(filepath.Join(root, "state", "taildrop", record.ID+".json"))
			if err != nil {
				t.Fatal(err)
			}
			for _, command := range []string{"send-status", "send-cancel"} {
				got := queryTransfer(t, root, command, record.ID)
				if !reflect.DeepEqual(got, record.transfer) {
					t.Fatalf("final record changed: %+v", got)
				}
			}
			after, err := os.ReadFile(filepath.Join(root, "state", "taildrop", record.ID+".json"))
			if err != nil || string(after) != string(before) {
				t.Fatalf("final query wrote record: %v", err)
			}
			if cancelled, err := store.cancelled(record.ID); err != nil || cancelled {
				t.Fatal("final query created cancel marker", err)
			}
		})
	}
	if output, err := exec.Command(os.Args[0], "send-history", "--root", root).CombinedOutput(); err == nil {
		t.Fatalf("history bypassed unsafe full maintenance: %s", output)
	}
	if body, err := os.ReadFile(outside); err != nil || string(body) != "untouched" {
		t.Fatal("final query followed unrelated lock symlink", err)
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

func TestTransferQueryWaitsForStateOwnerBeforeReading(t *testing.T) {
	root := t.TempDir()
	shared, paths := testSendFiles(t, "one")
	store, err := openTransferStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	record := testTransferRecord(t, root, shared, "", paths)
	if err := store.save(record); err != nil {
		t.Fatal(err)
	}
	guard, err := store.guard()
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	command := exec.Command(os.Args[0], "send-status", "--root", root, "--id", record.ID)
	stdout := new(strings.Builder)
	command.Stdout, command.Stderr = stdout, stdout
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	defer command.Process.Kill()
	select {
	case err := <-finished:
		t.Fatalf("query bypassed state owner: %s %v", stdout, err)
	case <-time.After(100 * time.Millisecond):
	}
	record.Status, record.Files[0].Status = "completed", "completed"
	if err := store.save(record); err != nil {
		t.Fatal(err)
	}
	guard.Close()
	select {
	case err := <-finished:
		if err != nil || !strings.Contains(stdout.String(), `"status":"completed"`) || strings.Contains(stdout.String(), "interrupted") {
			t.Fatalf("query returned state from before ownership handoff: %s %v", stdout, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("query failed to release state owner wait")
	}
}

func TestInterruptedRecoveryKeepsCancelMarkerOnSaveFailure(t *testing.T) {
	root := t.TempDir()
	shared, paths := testSendFiles(t, "one")
	store, err := openTransferStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	guard, err := store.guard()
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	active, err := store.activeLock()
	if err != nil {
		t.Fatal(err)
	}
	defer active.Close()
	record := testTransferRecord(t, root, shared, "", paths)
	if err := store.requestCancel(record.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.root.Mkdir(record.ID+".json", 0700); err != nil {
		t.Fatal(err)
	}
	if err := store.interruptRecord(record); err == nil {
		t.Fatal("record save unexpectedly replaced directory")
	}
	if cancelled, err := store.cancelled(record.ID); err != nil || !cancelled {
		t.Fatal("failed recovery lost cancellation", err)
	}
	if _, err := store.root.Lstat(record.ID + ".json"); errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed recovery destroyed record path")
	}
}

func TestTransferQueriesRejectInvalidSelectedRecord(t *testing.T) {
	for _, invalid := range []string{"oversized", "trailing", "wrong-id", "symlink"} {
		t.Run(invalid, func(t *testing.T) {
			root := t.TempDir()
			shared, paths := testSendFiles(t, "one")
			store, err := openTransferStore(root)
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			record := testTransferRecord(t, root, shared, "", paths)
			record.Status, record.Files[0].Status = "completed", "completed"
			if invalid == "wrong-id" {
				record.ID = strings.Repeat("f", 32)
			}
			data, err := json.Marshal(record)
			if err != nil {
				t.Fatal(err)
			}
			switch invalid {
			case "oversized":
				data = append(data, []byte(strings.Repeat(" ", 128<<10))...)
			case "trailing":
				data = append(data, []byte(" {}")...)
			}
			id := strings.Repeat("a", 32)
			if invalid != "wrong-id" {
				id = record.ID
			}
			path := filepath.Join(root, "state", "taildrop", id+".json")
			if invalid == "symlink" {
				outside := filepath.Join(t.TempDir(), "record")
				if err := os.WriteFile(outside, data, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, path); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			for _, command := range []string{"send-status", "send-cancel", "send-delete", "send-clear"} {
				args := []string{command, "--root", root}
				if command != "send-clear" {
					args = append(args, "--id", id)
				}
				if output, err := exec.Command(os.Args[0], args...).CombinedOutput(); err == nil {
					t.Fatalf("accepted %s record: %s", invalid, output)
				}
			}
		})
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
		for _, invalid := range []string{"cancel-symlink", "unknown-status", "malformed-record"} {
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
				} else if invalid == "malformed-record" {
					corruptOtherTransfer(t, root)
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

func TestTransferHistoryRemovalWaitsForStateOwner(t *testing.T) {
	for _, name := range []string{"send-delete", "send-clear"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			shared, paths := testSendFiles(t, "one")
			store, err := openTransferStore(root)
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			record := testTransferRecord(t, root, shared, "", paths)
			if err := store.save(record); err != nil {
				t.Fatal(err)
			}
			guard, err := store.guard()
			if err != nil {
				t.Fatal(err)
			}
			defer guard.Close()
			args := []string{name, "--root", root}
			if name == "send-delete" {
				args = append(args, "--id", record.ID)
			}
			command := exec.Command(os.Args[0], args...)
			output := new(strings.Builder)
			command.Stdout, command.Stderr = output, output
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			defer command.Process.Kill()
			finished := make(chan error, 1)
			go func() { finished <- command.Wait() }()
			select {
			case err := <-finished:
				t.Fatalf("removal bypassed owner: %s %v", output, err)
			case <-time.After(100 * time.Millisecond):
			}
			record.Status = "completed"
			if err := store.save(record); err != nil {
				t.Fatal(err)
			}
			guard.Close()
			select {
			case err := <-finished:
				if err != nil || !strings.Contains(output.String(), `"removed":1`) {
					t.Fatalf("removal ignored handoff: %s %v", output, err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("removal did not resume after handoff")
			}
			if _, err := store.load(record.ID); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("terminal metadata not removed", err)
			}
		})
	}
}

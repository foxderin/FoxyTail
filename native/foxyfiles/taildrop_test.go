package main

import (
	"os"
	"path/filepath"
	"testing"
)

func taildropFixture(t *testing.T) (string, string, string) {
	t.Helper()
	base := t.TempDir()
	shared := filepath.Join(base, "shared")
	incoming := filepath.Join(shared, "Download", "Taildrop")
	if err := os.MkdirAll(incoming, 0700); err != nil {
		t.Fatal(err)
	}
	return shared, incoming, filepath.Join(base, "private")
}

func TestTaildropImportPreservesInputAndReceipts(t *testing.T) {
	shared, incoming, inbox := taildropFixture(t)
	name := "meeting ' * [1].txt"
	input := filepath.Join(incoming, name)
	if err := os.WriteFile(input, []byte("first"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := importTaildrop(shared, inbox)
	if err != nil || result.Received != 1 || result.Files[0] != name {
		t.Fatalf("first import: %+v %v", result, err)
	}
	if body, err := os.ReadFile(input); err != nil || string(body) != "first" {
		t.Fatal("input changed")
	}
	result, err = importTaildrop(shared, inbox)
	if err != nil || result.Received != 0 {
		t.Fatalf("repeated import: %+v %v", result, err)
	}
	if err = os.Remove(filepath.Join(inbox, name)); err != nil {
		t.Fatal(err)
	}
	result, err = importTaildrop(shared, inbox)
	if err != nil || result.Received != 0 {
		t.Fatal("deleted receipt was reimported", err)
	}
	if err = os.WriteFile(input, []byte("second"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err = importTaildrop(shared, inbox)
	if err != nil || result.Received != 1 {
		t.Fatalf("new content: %+v %v", result, err)
	}
	if body, err := os.ReadFile(filepath.Join(inbox, name)); err != nil || string(body) != "second" {
		t.Fatal("new content lost")
	}
}

func TestTaildropRepairsPublicationWithoutReceipt(t *testing.T) {
	shared, incoming, inbox := taildropFixture(t)
	if err := os.WriteFile(filepath.Join(incoming, "a.txt"), []byte("received"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := importTaildrop(shared, inbox); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(inbox, ".taildrop"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != "lock" {
			if err = os.Remove(filepath.Join(inbox, ".taildrop", entry.Name())); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Simulate the leftovers of a killed import, with publication already durable.
	if err = os.WriteFile(filepath.Join(inbox, ".taildrop", "stage"), []byte("interrupted"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := importTaildrop(shared, inbox)
	if err != nil || result.Received != 0 {
		t.Fatalf("crash recovery: %+v %v", result, err)
	}
	if _, err = os.Stat(filepath.Join(inbox, "a-1.txt")); !os.IsNotExist(err) {
		t.Fatal("duplicate published after crash")
	}
	if err = os.Remove(filepath.Join(inbox, "a.txt")); err != nil {
		t.Fatal(err)
	}
	result, err = importTaildrop(shared, inbox)
	if err != nil || result.Received != 0 {
		t.Fatal("receipt not repaired", err)
	}
}

func TestTaildropSkipsIncompleteAndUnsafeEntries(t *testing.T) {
	shared, incoming, inbox := taildropFixture(t)
	for _, name := range []string{"x.partial", "x.deleted", ".taildrop", ".outgoing", "line\nbreak"} {
		if err := os.WriteFile(filepath.Join(incoming, name), []byte("skip"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	secret := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(secret, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(incoming, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(incoming, "directory"), 0700); err != nil {
		t.Fatal(err)
	}
	result, err := importTaildrop(shared, inbox)
	if err != nil || result.Received != 0 {
		t.Fatalf("unsafe import: %+v %v", result, err)
	}
	entries, err := os.ReadDir(inbox)
	if err != nil || len(entries) != 1 || entries[0].Name() != ".taildrop" {
		t.Fatal("unsafe files published", err)
	}
}

func TestTaildropRejectsSymlinkDirectoriesAndReceiptState(t *testing.T) {
	for _, target := range []string{"Download", "Taildrop", "inbox", "receipts"} {
		t.Run(target, func(t *testing.T) {
			shared, incoming, inbox := taildropFixture(t)
			if err := os.Mkdir(inbox, 0700); err != nil {
				t.Fatal(err)
			}
			path := inbox
			switch target {
			case "Download":
				path = filepath.Dir(incoming)
			case "Taildrop":
				path = incoming
			case "receipts":
				path = filepath.Join(inbox, ".taildrop")
			}
			if err := os.RemoveAll(path); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(t.TempDir(), path); err != nil {
				t.Fatal(err)
			}
			if _, err := importTaildrop(shared, inbox); err == nil {
				t.Fatal("accepted symlink directory")
			}
		})
	}
}

func TestTaildropExclusivePublicationAndRootReplacement(t *testing.T) {
	shared, incoming, inbox := taildropFixture(t)
	if err := os.WriteFile(filepath.Join(incoming, "same.txt"), []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(inbox, 0700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(inbox, "same.txt")); err != nil {
		t.Fatal(err)
	}
	result, err := importTaildrop(shared, inbox)
	if err != nil || result.Received != 1 || result.Files[0] != "same-1.txt" {
		t.Fatalf("exclusive publication: %+v %v", result, err)
	}
	if body, _ := os.ReadFile(outside); string(body) != "old" {
		t.Fatal("overwrote symlink target")
	}
	root, err := os.OpenRoot(incoming)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err = os.Rename(incoming, incoming+"-old"); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(filepath.Dir(outside), incoming); err != nil {
		t.Fatal(err)
	}
	// A path replacement after open cannot redirect the held root into secrets.
	if _, err = root.Open("secret"); !os.IsNotExist(err) {
		t.Fatal("root followed replacement", err)
	}
	private, err := os.OpenRoot(inbox)
	if err != nil {
		t.Fatal(err)
	}
	defer private.Close()
	receipts, err := private.OpenRoot(".taildrop")
	if err != nil {
		t.Fatal(err)
	}
	defer receipts.Close()
	for _, name := range []string{"../secret", "/secret", ".taildrop", "x.partial"} {
		if _, err = importTaildropFile(root, private, receipts, name); err == nil {
			t.Fatal("accepted unsafe name", name)
		}
	}
	if err = os.Symlink(outside, filepath.Join(incoming+"-old", "race.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err = importTaildropFile(root, private, receipts, "race.txt"); err == nil {
		t.Fatal("followed symlink swapped before leaf open")
	}
}

func TestTaildropConcurrentImportLock(t *testing.T) {
	shared, _, inbox := taildropFixture(t)
	if _, err := importTaildrop(shared, inbox); err != nil {
		t.Fatal(err)
	}
	lock, err := os.OpenFile(filepath.Join(inbox, ".taildrop", "lock"), taildropReadWriteFlags(), 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err = taildropLock(lock); err != nil {
		t.Fatal(err)
	}
	if _, err = importTaildrop(shared, inbox); err == nil {
		t.Fatal("concurrent receiver bypassed lock")
	}
}

package main

import (
	"os"
	"path/filepath"
	"strings"
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

func TestTaildropImportPreservesReceiptsAndRemovesSources(t *testing.T) {
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
	if _, err := os.Lstat(input); !os.IsNotExist(err) {
		t.Fatal("imported source retained", err)
	}
	result, err = importTaildrop(shared, inbox)
	if err != nil || result.Received != 0 {
		t.Fatalf("repeated import: %+v %v", result, err)
	}
	if err = os.Remove(filepath.Join(inbox, name)); err != nil {
		t.Fatal(err)
	}
	// The same content re-dropped is deduplicated by its receipt, not reimported.
	if err = os.WriteFile(input, []byte("first"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err = importTaildrop(shared, inbox)
	if err != nil || result.Received != 0 {
		t.Fatal("deleted receipt was reimported", err)
	}
	if _, err := os.Lstat(input); !os.IsNotExist(err) {
		t.Fatal("deduplicated source retained", err)
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
	source := filepath.Join(incoming, "a.txt")
	if err := os.WriteFile(source, []byte("received"), 0600); err != nil {
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
	// Offering the same content again repairs the missing receipt.
	if err = os.WriteFile(source, []byte("received"), 0600); err != nil {
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
	if err = os.WriteFile(source, []byte("received"), 0600); err != nil {
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
	if err != nil || result.Received != 0 || result.Ignored != 3 {
		t.Fatalf("unsafe import: %+v %v", result, err)
	}
	entries, err := os.ReadDir(inbox)
	if err != nil || len(entries) != 1 || entries[0].Name() != ".taildrop" {
		t.Fatal("unsafe files published", err)
	}
}

func TestTaildropNamesMatchInboxBoundary(t *testing.T) {
	for _, name := range []string{"", ".", "..", ".taildrop", ".outgoing", "a/b", "a\\b", strings.Repeat("a", 256), strings.Repeat("界", 86), "invalid\xff", "bidi\u202Ename", "zero\u200Bwidth", "\uFEFFbom", "soft\u00ADhyphen"} {
		if taildropCompletedName(name) {
			t.Errorf("accepted incompatible name %q", name)
		}
	}
	for character := rune(0); character <= 0x9f; character++ {
		if character > 0x1f && character < 0x7f {
			continue
		}
		if taildropCompletedName("file" + string(character) + ".txt") {
			t.Errorf("accepted ISO control U+%04X", character)
		}
	}
	for _, name := range []string{".env", "..hidden", "meeting ' * [1].txt", "你好.txt", strings.Repeat("a", 255), strings.Repeat("界", 85)} {
		if !taildropCompletedName(name) {
			t.Errorf("rejected supported name %q", name)
		}
	}
}

func TestTaildropIgnoresUnsupportedNamesWithoutChangingInput(t *testing.T) {
	shared, incoming, inbox := taildropFixture(t)
	invalid := []string{"tab\tname", "line\nbreak", "return\rname", "escape\x1bname", "delete\x7fname", "c1\u0085name", "back\\slash", ".outgoing"}
	for _, name := range append(invalid, "normal.txt") {
		if err := os.WriteFile(filepath.Join(incoming, name), []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := importTaildrop(shared, inbox)
	if err != nil || result.Received != 1 || result.Ignored != len(invalid) || result.Files[0] != "normal.txt" {
		t.Fatalf("mixed import: %+v %v", result, err)
	}
	for _, name := range invalid {
		if body, err := os.ReadFile(filepath.Join(incoming, name)); err != nil || string(body) != "keep" {
			t.Fatalf("unsupported original changed: %q %v", name, err)
		}
		if _, err := os.Lstat(filepath.Join(inbox, name)); !os.IsNotExist(err) {
			t.Fatalf("unsupported name entered inbox: %q %v", name, err)
		}
	}
	entries, err := os.ReadDir(inbox)
	if err != nil || len(entries) != 2 {
		t.Fatalf("unexpected renamed files: %v %v", entries, err)
	}
	result, err = importTaildrop(shared, inbox)
	if err != nil || result.Received != 0 || result.Ignored != len(invalid) {
		t.Fatalf("repeated import: %+v %v", result, err)
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
	for _, name := range []string{"../secret", "/secret", ".taildrop", ".outgoing", "x.partial", "tab\tname", "c1\u0085name", "delete\x7fname", "bidi\u202Ename"} {
		if _, _, err = importTaildropFile(root, private, receipts, name); err == nil {
			t.Fatal("accepted unsafe name", name)
		}
	}
	if err = os.Symlink(outside, filepath.Join(incoming+"-old", "race.txt")); err != nil {
		t.Fatal(err)
	}
	if _, _, err = importTaildropFile(root, private, receipts, "race.txt"); err == nil {
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
	if _, err = importTaildrop(shared, inbox); err == nil || !strings.Contains(err.Error(), "in progress") {
		t.Fatal("concurrent receiver bypassed lock", err)
	}
}

func TestTaildropCollectsFailuresAndEnforcesCaps(t *testing.T) {
	restoreSize, restoreBytes, restoreFiles := maxReceiveSize, maxReceiveBytes, maxInboxFiles
	defer func() { maxReceiveSize, maxReceiveBytes, maxInboxFiles = restoreSize, restoreBytes, restoreFiles }()

	// A poisoned first entry must not block later files; oversized drops are
	// skipped and reported, never imported or deleted.
	shared, incoming, inbox := taildropFixture(t)
	poison := filepath.Join(incoming, "aaa-poison")
	if err := os.WriteFile(poison, []byte("denied"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(poison, 0); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(poison, 0600)
	good := filepath.Join(incoming, "mid-good")
	if err := os.WriteFile(good, []byte("good"), 0600); err != nil {
		t.Fatal(err)
	}
	huge := filepath.Join(incoming, "zzz-huge")
	if err := os.WriteFile(huge, []byte("012345"), 0600); err != nil {
		t.Fatal(err)
	}
	maxReceiveSize = 4
	result, err := importTaildrop(shared, inbox)
	if err != nil || !result.OK || result.Received != 1 || len(result.Files) != 1 || result.Files[0] != "mid-good" {
		t.Fatalf("per-file failure isolation: %+v %v", result, err)
	}
	if result.FailedCount != 1 || len(result.Failed) != 1 || result.Failed[0].Name != "aaa-poison" {
		t.Fatalf("failure not reported: %+v", result)
	}
	if result.SkippedCount != 1 || len(result.Skipped) != 1 || result.Skipped[0].Name != "zzz-huge" {
		t.Fatalf("oversize not skipped: %+v", result)
	}
	if _, err := os.Lstat(good); !os.IsNotExist(err) {
		t.Fatal("imported source retained", err)
	}
	for _, kept := range []string{poison, huge} {
		if _, err := os.Lstat(kept); err != nil {
			t.Fatal("unimported source removed", kept, err)
		}
	}
	maxReceiveSize = restoreSize

	// The per-call byte cap stops new imports once the budget is spent.
	maxReceiveBytes = 4
	shared, incoming, inbox = taildropFixture(t)
	for _, name := range []string{"a", "b", "c"} {
		if err := os.WriteFile(filepath.Join(incoming, name), []byte("xxx"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err = importTaildrop(shared, inbox)
	if err != nil || result.Received != 2 || len(result.Files) != 2 {
		t.Fatalf("byte cap: %+v %v", result, err)
	}
	if result.SkippedCount != 1 || len(result.Skipped) != 1 {
		t.Fatalf("byte cap not reported: %+v", result)
	}
	kept := result.Skipped[0].Name
	if kept != "a" && kept != "b" && kept != "c" {
		t.Fatalf("unexpected skip: %+v", result.Skipped)
	}
	if _, err := os.Lstat(filepath.Join(incoming, kept)); err != nil {
		t.Fatal("capped source removed", err)
	}
	for _, name := range []string{"a", "b", "c"} {
		if name != kept {
			if _, err := os.Lstat(filepath.Join(incoming, name)); !os.IsNotExist(err) {
				t.Fatal("imported source retained", name, err)
			}
		}
	}
	maxReceiveBytes = restoreBytes

	// Existing inbox entries consume the file-count budget before new imports.
	maxInboxFiles = 2
	shared, incoming, inbox = taildropFixture(t)
	if err := os.MkdirAll(inbox, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inbox, "exists"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"first", "second"} {
		if err := os.WriteFile(filepath.Join(incoming, name), []byte("new"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err = importTaildrop(shared, inbox)
	if err != nil || result.Received != 1 || len(result.Files) != 1 {
		t.Fatalf("inbox cap: %+v %v", result, err)
	}
	if result.SkippedCount != 1 || len(result.Skipped) != 1 || !strings.Contains(result.Skipped[0].Reason, "full") {
		t.Fatalf("inbox cap not reported: %+v", result)
	}
	if result.Files[0] == result.Skipped[0].Name {
		t.Fatalf("same file imported and skipped: %+v", result)
	}
	if _, err := os.Lstat(filepath.Join(incoming, result.Skipped[0].Name)); err != nil {
		t.Fatal("inbox-full source removed", err)
	}
	maxInboxFiles = restoreFiles
}

func TestTaildropRejectsUncleanReceivePaths(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "inbox")
	for _, args := range [][]string{
		{"--source", "/sdcard/../escape", "--destination", destination},
		{"--source", "/sdcard", "--destination", "/tmp/../inbox"},
		{"--source", "relative/dir", "--destination", destination},
		{"--source", "/sdcard/", "--destination", destination},
	} {
		if err := runTaildrop(args); err == nil {
			t.Fatalf("accepted unclean receive arguments %v", args)
		}
	}
}

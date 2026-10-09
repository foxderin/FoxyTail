package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBrowseRejectsEscapesAndBoundsEntries(t *testing.T) {
	shared := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"b-dir", "a-dir"} {
		if err := os.Mkdir(filepath.Join(shared, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(shared, "a-file"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(shared, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(shared, "secret")); err != nil {
		t.Fatal(err)
	}
	result, err := browseFiles(shared, "")
	if err != nil || len(result.Entries) != 3 || result.Truncated {
		t.Fatalf("browse: %+v %v", result, err)
	}
	if result.Entries[0].Name != "a-dir" || result.Entries[1].Name != "b-dir" || result.Entries[2].Name != "a-file" {
		t.Fatalf("not directory first: %+v", result.Entries)
	}
	for _, path := range []string{"..", ".", "a-dir/../", "/", "escape", "a-dir\\x", "a-dir//x", "line\nbreak"} {
		if _, err = browseFiles(shared, path); err == nil {
			t.Fatalf("accepted %q", path)
		}
	}
	for i := range 1001 {
		if err := os.WriteFile(filepath.Join(shared, fmt.Sprintf("item-%04d", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err = browseFiles(shared, "")
	if err != nil || !result.Truncated || len(result.Entries) > 1000 {
		t.Fatalf("unbounded browse: %+v %v", result, err)
	}
}

func TestStageLengthPermissionsDeletionAndInboxRead(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"", ".", "..", "a/b", "a\\b", "bad\x01", ".lease", ".data"} {
		if _, err := stageFile(root, name, 0, strings.NewReader("")); err == nil {
			t.Fatalf("accepted stage name %q", name)
		}
	}
	for _, expected := range []int64{2, 4, maxSendSize + 1, -2} {
		if _, err := stageFile(root, "wrong", expected, strings.NewReader("abc")); err == nil {
			t.Fatalf("accepted size %d", expected)
		}
	}
	outgoing := filepath.Join(root, "files", ".outgoing")
	entries, err := os.ReadDir(outgoing)
	if err != nil || len(entries) != 0 {
		t.Fatalf("partial stage leaked: %v %v", entries, err)
	}
	staged, err := stageFile(root, "quote ' %.txt", -1, strings.NewReader("abc"))
	if err != nil || staged.Size != 3 || !staged.OK {
		t.Fatalf("stage: %+v %v", staged, err)
	}
	info, err := os.Stat(staged.Path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("file permissions: %v %v", info, err)
	}
	info, err = os.Stat(filepath.Dir(staged.Path))
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("stage permissions: %v %v", info, err)
	}
	if _, err = stageFile(root, "empty", 0, strings.NewReader("")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(root, "files", "victim"), staged.Path + "/..", outgoing + "/../victim"} {
		if err = removeStaged(root, path); err == nil {
			t.Fatalf("accepted delete %q", path)
		}
	}
	if err = removeStaged(root, staged.Path); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(staged.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stage not deleted", err)
	}
	payload := bytes.Repeat([]byte("raw\x00bytes"), (9<<20)/9)
	inbox := filepath.Join(root, "files")
	if err = os.WriteFile(filepath.Join(inbox, "large.bin"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err = readInbox(root, "large.bin", &output); err != nil || !bytes.Equal(payload, output.Bytes()) {
		t.Fatal("raw read corrupted/truncated bytes", err)
	}
	if err = os.Symlink(filepath.Join(inbox, "large.bin"), filepath.Join(inbox, "linked")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../files/large.bin", ".outgoing", ".taildrop", "linked"} {
		output.Reset()
		if err = readInbox(root, name, &output); err == nil || output.Len() != 0 {
			t.Fatalf("accepted inbox boundary %q", name)
		}
	}
}

func TestSendSourceRejectsMissingSymlinkAndMutation(t *testing.T) {
	root, shared := t.TempDir(), t.TempDir()
	outside := filepath.Join(t.TempDir(), "private")
	if err := os.WriteFile(outside, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(shared, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(shared, "dir")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{outside, shared + "/missing", shared + "/linked", shared + "/dir/private", shared + "/../private", shared + "//missing"} {
		if source, err := openSendSource(root, shared, path); err == nil {
			source.Close()
			t.Fatalf("accepted %q", path)
		}
	}
	path := filepath.Join(shared, "regular")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	source, err := openSendSource(root, shared, path)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = source.unchanged(); err == nil {
		t.Fatal("missed source identity replacement")
	}
}

func TestStageExpirationPreservesActiveAndCurrentWrites(t *testing.T) {
	root := t.TempDir()
	staged, err := stageFile(root, "retry", 3, strings.NewReader("abc"))
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-25 * time.Hour)
	if err = os.Chtimes(filepath.Dir(staged.Path), old, old); err != nil {
		t.Fatal(err)
	}
	store, err := openTransferStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	lock, err := store.activeLock()
	if err != nil {
		t.Fatal(err)
	}
	record := testTransferRecord(t, root, t.TempDir(), "", []string{staged.Path})
	if err = store.save(record); err != nil {
		t.Fatal(err)
	}
	guard, err := store.guard()
	if err != nil {
		t.Fatal(err)
	}
	if err = store.maintain(); err != nil {
		t.Fatal(err)
	}
	guard.Close()
	if _, err = os.Stat(staged.Path); err != nil {
		t.Fatal("active stage expired", err)
	}
	lock.Close()
	guard, err = store.guard()
	if err != nil {
		t.Fatal(err)
	}
	if err = store.maintain(); err != nil {
		t.Fatal(err)
	}
	guard.Close()
	if _, err = os.Stat(staged.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("orphan stage retained", err)
	}
	loaded, err := store.load(record.ID)
	if err != nil || loaded.Status != "interrupted" || loaded.Files[0].Status != "failed" {
		t.Fatalf("interrupted recovery: %+v %v", loaded, err)
	}
}

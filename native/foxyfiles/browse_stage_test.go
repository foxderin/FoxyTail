package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
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

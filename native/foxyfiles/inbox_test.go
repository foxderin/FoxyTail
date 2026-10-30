package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestInboxListNamesMetadataAndOrdering(t *testing.T) {
	root := t.TempDir()
	inbox := filepath.Join(root, "files")
	if err := os.Mkdir(inbox, 0700); err != nil {
		t.Fatal(err)
	}
	valid := []string{".env", "..hidden", "你好.txt", "meeting ' * [1].txt"}
	invalid := []string{"back\\slash", "bidi\u202Ename", "zero\u200Bwidth"}
	for character := rune(1); character <= 0x9f; character++ {
		if character <= 0x1f || character >= 0x7f {
			invalid = append(invalid, "bad"+string(character)+"name")
		}
	}
	// In-flight tailscaled names (*.partial, *.deleted) must never surface.
	for _, name := range append(append(append([]string{}, valid...), invalid...), "unfinished.partial", "old.deleted") {
		path := filepath.Join(inbox, name)
		if err := os.WriteFile(path, []byte("payload"), 0600); err != nil {
			t.Fatal(err)
		}
		stamp := time.Unix(1700000000, 0)
		if name == "你好.txt" {
			stamp = stamp.Add(time.Hour)
		}
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{".taildrop", ".outgoing", "directory", "bad\tdirectory"} {
		if err := os.Mkdir(filepath.Join(inbox, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"linked", "bad\tlink"} {
		if err := os.Symlink(filepath.Join(inbox, ".env"), filepath.Join(inbox, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := syscall.Mkfifo(filepath.Join(inbox, "fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := listInbox(inbox)
	if err != nil || !result.OK || len(result.Files) != len(valid) || result.Ignored != len(invalid) {
		t.Fatalf("listing: %+v %v", result, err)
	}
	if result.Files[0].Name != "你好.txt" || result.Files[0].Mtime != 1700003600 {
		t.Fatalf("newest metadata/order: %+v", result.Files)
	}
	seen := map[string]bool{}
	for i, entry := range result.Files {
		if entry.Size != 7 || (i > 0 && entry.Mtime != 1700000000) || seen[entry.Name] {
			t.Fatalf("incorrect metadata: %+v", entry)
		}
		if i > 1 && result.Files[i-1].Name > entry.Name {
			t.Fatal("equal timestamps are not deterministically ordered")
		}
		seen[entry.Name] = true
	}
	for _, name := range valid {
		if !seen[name] {
			t.Fatalf("lost supported name %q", name)
		}
	}
	for _, name := range invalid {
		if data, err := os.ReadFile(filepath.Join(inbox, name)); err != nil || string(data) != "payload" {
			t.Fatalf("listing changed invalid entry %q: %v", name, err)
		}
	}
}

func TestInboxListInvalidUTF8IsIgnored(t *testing.T) {
	root := t.TempDir()
	inbox := filepath.Join(root, "files")
	if err := os.Mkdir(inbox, 0700); err != nil {
		t.Fatal(err)
	}
	name := "invalid\xff"
	if plainName(name) {
		t.Fatal("invalid UTF-8 passed filename validation")
	}
	if err := os.WriteFile(filepath.Join(inbox, name), []byte("keep"), 0600); err != nil {
		if errors.Is(err, syscall.EILSEQ) {
			t.Skip("filesystem cannot create invalid UTF-8 filenames")
		}
		t.Fatal(err)
	}
	result, err := listInbox(inbox)
	if err != nil || !result.OK || len(result.Files) != 0 || result.Ignored != 1 {
		t.Fatalf("invalid UTF-8 listing: %+v %v", result, err)
	}
	if body, err := os.ReadFile(filepath.Join(inbox, name)); err != nil || string(body) != "keep" {
		t.Fatalf("invalid UTF-8 file changed: %v", err)
	}
}

func TestInboxListEmptyReservedAndRootBoundaries(t *testing.T) {
	root := t.TempDir()
	inboxPath := filepath.Join(root, "files")
	result, err := listInbox(inboxPath)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(result)
	if err != nil || string(body) != `{"ok":true,"files":[]}` {
		t.Fatalf("empty listing shape: %s %v", body, err)
	}
	if _, err := os.Lstat(inboxPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("read-only listing created inbox", err)
	}
	outside := t.TempDir()
	for _, name := range []string{".taildrop", ".outgoing"} {
		if err := os.WriteFile(filepath.Join(outside, name), []byte("private"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, inboxPath); err != nil {
		t.Fatal(err)
	}
	if result, err = listInbox(inboxPath); err == nil || result.OK {
		t.Fatal("accepted symlink inbox")
	}
	if err := os.Remove(inboxPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "absent"), inboxPath); err != nil {
		t.Fatal(err)
	}
	if result, err = listInbox(inboxPath); err == nil || result.OK {
		t.Fatal("dangling symlink reported empty inbox")
	}
	if err := os.Remove(inboxPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(outside, inboxPath); err != nil {
		t.Fatal(err)
	}
	result, err = listInbox(inboxPath)
	if err != nil || !result.OK || len(result.Files) != 0 || result.Ignored != 0 {
		t.Fatalf("reserved regular files exposed or counted: %+v %v", result, err)
	}
	linkedRoot := filepath.Join(t.TempDir(), "module")
	if err := os.Symlink(inboxPath, linkedRoot); err != nil {
		t.Fatal(err)
	}
	if result, err = listInbox(linkedRoot); err == nil || result.OK {
		t.Fatal("accepted symlink module root")
	}
}

func TestInboxEntryRacesAndMetadataFailure(t *testing.T) {
	for _, replacement := range []string{"removed", "symlink", "fifo", "closed-root"} {
		t.Run(replacement, func(t *testing.T) {
			path := t.TempDir()
			file := filepath.Join(path, "item")
			if err := os.WriteFile(file, []byte("old"), 0600); err != nil {
				t.Fatal(err)
			}
			entries, err := os.ReadDir(path)
			if err != nil {
				t.Fatal(err)
			}
			root, err := openRealRoot(path)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			if err := os.Remove(file); err != nil {
				t.Fatal(err)
			}
			switch replacement {
			case "symlink":
				secret := filepath.Join(t.TempDir(), "secret")
				if err := os.WriteFile(secret, []byte("do not follow"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(secret, file); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := syscall.Mkfifo(file, 0600); err != nil {
					t.Fatal(err)
				}
			case "closed-root":
				root.Close()
			}
			result := inboxResult{Files: []inboxEntry{}}
			err = result.appendEntry(root, entries[0])
			if (err != nil) != (replacement == "closed-root") || len(result.Files) != 0 || result.Ignored != 0 {
				t.Fatalf("race fabricated metadata or count: %+v %v", result, err)
			}
		})
	}
}

func TestInboxListBoundsOnlyReturnedFiles(t *testing.T) {
	root := t.TempDir()
	inbox := filepath.Join(root, "files")
	if err := os.Mkdir(inbox, 0700); err != nil {
		t.Fatal(err)
	}
	for i := range maxInboxFiles {
		if err := os.WriteFile(filepath.Join(inbox, fmt.Sprintf("%05d", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{".taildrop", ".outgoing", "directory"} {
		if err := os.Mkdir(filepath.Join(inbox, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 129 {
		if err := os.WriteFile(filepath.Join(inbox, fmt.Sprintf("bad\t%03d", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := listInbox(inbox)
	if err != nil || !result.OK || len(result.Files) != maxInboxFiles || result.Ignored != 129 {
		t.Fatalf("non-files consumed valid capacity: %d ignored=%d %v", len(result.Files), result.Ignored, err)
	}
	if err := os.WriteFile(filepath.Join(inbox, "one-too-many"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if result, err = listInbox(inbox); err == nil || result.OK || !strings.Contains(err.Error(), "10000") {
		t.Fatalf("overflow reported a complete listing: %d %v", len(result.Files), err)
	}
}

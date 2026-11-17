package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

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

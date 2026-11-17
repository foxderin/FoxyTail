package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func artifactFixture(t *testing.T, root, kind string, data []byte) artifactResult {
	t.Helper()
	result, err := createArtifact(root, kind, int64(len(data)), bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK || !validArtifactID(result.ID) || result.Size != int64(len(data)) {
		t.Fatalf("invalid artifact result: %+v", result)
	}
	return result
}

func TestArtifactRejectsSymlinksWithoutTouchingOriginals(t *testing.T) {
	for _, target := range []string{"store", "token", "data"} {
		t.Run(target, func(t *testing.T) {
			root := t.TempDir()
			outside := t.TempDir()
			original := filepath.Join(outside, "secret")
			if err := os.WriteFile(original, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			if target == "store" {
				if err := os.Symlink(outside, filepath.Join(root, ".artifacts")); err != nil {
					t.Fatal(err)
				}
				if _, err := createArtifact(root, "import", 1, strings.NewReader("x")); err == nil {
					t.Fatal("accepted symlink store")
				}
			} else {
				result := artifactFixture(t, root, "import", []byte("archive"))
				path := filepath.Join(root, ".artifacts", result.ID)
				link := outside
				if target == "data" {
					path = filepath.Join(path, "import.tar.gz")
					link = original
				}
				if err := os.RemoveAll(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(link, path); err != nil {
					t.Fatal(err)
				}
				for _, action := range []string{"read", "delete", "extract"} {
					if err := useArtifact(root, result.ID, action, filepath.Join(root, "unpack"), io.Discard); err == nil {
						t.Fatal("accepted symlink", target, action)
					}
				}
			}
			data, err := os.ReadFile(original)
			if err != nil || string(data) != "original" {
				t.Fatal("modified original", err)
			}
		})
	}
}

func TestArtifactExpiryAndDeleteSkipLiveRestoreLease(t *testing.T) {
	root := t.TempDir()
	result := artifactFixture(t, root, "import", []byte("source"))
	store, guard, err := openArtifacts(root)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := openChildRoot(store, result.ID)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := artifactLease(stage)
	stage.Close()
	guard.Close()
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	defer store.Close()
	old := time.Now().Add(-2 * artifactLifetime)
	if err = os.Chtimes(filepath.Join(root, ".artifacts", result.ID), old, old); err != nil {
		t.Fatal(err)
	}
	if err = useArtifact(root, result.ID, "delete", "", io.Discard); err == nil {
		t.Fatal("deleted live restore source")
	}
	if _, err = os.Stat(filepath.Join(root, ".artifacts", result.ID, "import.tar.gz")); err != nil {
		t.Fatal("expired live restore source", err)
	}
	lease.Close()
	if _, err = expireArtifacts(store, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(root, ".artifacts", result.ID)); !os.IsNotExist(err) {
		t.Fatal("expired artifact survived", err)
	}
}

// An import owns only its reserved stage while waiting for the provider. Closing
// stdin with an error models cancellation before the declared bytes arrive.
func TestStalledArtifactDoesNotLockStoreAndCancellationRemovesStage(t *testing.T) {
	root := t.TempDir()
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	done := make(chan error, 1)
	go func() {
		defer reader.Close()
		_, err := createArtifact(root, "import", 2, reader)
		done <- err
	}()
	// Pipe writes complete only after createArtifact reaches its streaming copy.
	if _, err := writer.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(root, ".artifacts"))
	if err != nil {
		t.Fatal(err)
	}
	var pending string
	for _, entry := range entries {
		if validArtifactID(entry.Name()) {
			pending = entry.Name()
		}
	}
	if pending == "" {
		t.Fatal("missing reserved stage")
	}
	store, guard, err := openArtifacts(root)
	if err != nil {
		t.Fatalf("stalled provider retained global store lock: %v", err)
	}
	// Even an artificially old active stage must not be collected.
	count, expireErr := expireArtifacts(store, time.Now().Add(2*artifactLifetime))
	guard.Close()
	store.Close()
	if expireErr != nil || count != 1 {
		t.Fatalf("live stage expired: count=%d error=%v", count, expireErr)
	}
	other := artifactFixture(t, root, "import", []byte("other"))
	if err := useArtifact(root, other.ID, "delete", "", io.Discard); err != nil {
		t.Fatal(err)
	}
	writer.CloseWithError(io.ErrClosedPipe)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled partial import succeeded")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled import did not finish")
	}
	if _, err := os.Stat(filepath.Join(root, ".artifacts", pending)); !os.IsNotExist(err) {
		t.Fatalf("cancelled stage remains: %v", err)
	}
	artifactFixture(t, root, "import", []byte("after cancellation"))
}

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
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

func TestArtifactBinaryRoundTripAndDelete(t *testing.T) {
	root := t.TempDir()
	data := []byte{0, 255, 128, '\n', '\r', 0, 1}
	result := artifactFixture(t, root, "import", data)
	var output bytes.Buffer
	if err := useArtifact(root, result.ID, "read", "", &output); err != nil || !bytes.Equal(output.Bytes(), data) {
		t.Fatalf("binary export mismatch: %x %v", output.Bytes(), err)
	}
	for _, path := range []string{filepath.Join(root, ".artifacts"), filepath.Join(root, ".artifacts", result.ID)} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0700 {
			t.Fatalf("non-private directory: %s %v", path, err)
		}
	}
	file := filepath.Join(root, ".artifacts", result.ID, "import.tar.gz")
	info, err := os.Stat(file)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("non-private data: %v", err)
	}
	if err = useArtifact(root, result.ID, "delete", "", io.Discard); err != nil {
		t.Fatal(err)
	}
	if err = useArtifact(root, result.ID, "read", "", io.Discard); err == nil {
		t.Fatal("deleted token still readable")
	}
}

func TestArtifactRejectsLimitsAndInvalidTokens(t *testing.T) {
	root := t.TempDir()
	for _, item := range []struct {
		size int64
		data []byte
	}{
		{-2, []byte("x")}, {maxCompressed + 1, []byte("x")},
		{0, nil}, {2, []byte("x")}, {1, []byte("xy")},
		{-1, bytes.Repeat([]byte("x"), maxCompressed+1)},
	} {
		if _, err := createArtifact(root, "import", item.size, bytes.NewReader(item.data)); err == nil {
			t.Fatalf("accepted invalid declared size %d / bytes %d", item.size, len(item.data))
		}
	}
	for _, token := range []string{"", "../x", "/etc/passwd", strings.Repeat("a", 32), "art-" + strings.Repeat("A", 32), "art-" + strings.Repeat("a", 32) + "/x"} {
		if err := useArtifact(root, token, "read", "", io.Discard); err == nil {
			t.Fatalf("accepted invalid token %q", token)
		}
	}
	entries, err := os.ReadDir(filepath.Join(root, ".artifacts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != ".lock" {
			t.Fatal("failed stage leaked data", entry.Name())
		}
	}
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

func TestArtifactExtractionPreservesDigestAndSource(t *testing.T) {
	root := t.TempDir()
	data := compressArchive(t, archiveBytes(t, []archiveMember{{"conf/foxytail.conf", "SOCKS_PORT=1200\n", 0}}))
	result := artifactFixture(t, root, "import", data)
	var digest bytes.Buffer
	dest := filepath.Join(root, "unpack")
	if err := useArtifact(root, result.ID, "extract", dest, &digest); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	if strings.TrimSpace(digest.String()) != hex.EncodeToString(sum[:]) {
		t.Fatal("archive SHA differs")
	}
	original, err := os.ReadFile(filepath.Join(root, ".artifacts", result.ID, "import.tar.gz"))
	if err != nil || !bytes.Equal(data, original) {
		t.Fatal("restore extraction altered original", err)
	}
	bad := artifactFixture(t, root, "import", []byte("not a tar gzip"))
	if err = useArtifact(root, bad.ID, "extract", filepath.Join(root, "bad"), io.Discard); err == nil {
		t.Fatal("invalid archive restored")
	}
	diag := artifactFixture(t, root, "diagnostic", data)
	if err = useArtifact(root, diag.ID, "extract", filepath.Join(root, "diag"), io.Discard); err == nil {
		t.Fatal("diagnostic accepted as restore source")
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

func TestArtifactStoreQuotaAndIncompleteExpiry(t *testing.T) {
	root := t.TempDir()
	store, guard, err := openArtifacts(root)
	if err != nil {
		t.Fatal(err)
	}
	for range maxArtifacts {
		random, err := randomID()
		if err != nil {
			t.Fatal(err)
		}
		if err = store.Mkdir("art-"+random, 0700); err != nil {
			t.Fatal(err)
		}
	}
	guard.Close()
	defer store.Close()
	if _, err = createArtifact(root, "import", 1, strings.NewReader("x")); err == nil {
		t.Fatal("artifact quota not enforced")
	}
	if count, err := expireArtifacts(store, time.Now().Add(2*artifactLifetime)); err != nil || count != 0 {
		t.Fatalf("orphaned partial artifacts not expired: %d %v", count, err)
	}
	artifactFixture(t, root, "import", []byte("after expiry"))
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

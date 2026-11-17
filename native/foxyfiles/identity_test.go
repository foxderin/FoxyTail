package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func syntheticIdentity(t *testing.T, nickname string) []byte {
	t.Helper()
	key := "privkey:" + strings.Repeat("1", 64)
	profiles, _ := json.Marshal(map[string]any{"abcd": map[string]any{"ID": "abcd", "Key": "profile-abcd", "Name": nickname}})
	prefs, _ := json.Marshal(map[string]any{"ProfileName": nickname, "Config": map[string]any{"PrivateNodeKey": key, "OldPrivateNodeKey": "privkey:" + strings.Repeat("0", 64)}})
	result, _ := json.Marshal(map[string][]byte{"_machinekey": []byte(key), "_profiles": profiles, "_current-profile": []byte("profile-abcd"), "profile-abcd": prefs})
	return result
}
func identityFixture(t *testing.T) (string, []byte) {
	t.Helper()
	path := t.TempDir()
	if err := os.Mkdir(filepath.Join(path, "state"), 0700); err != nil {
		t.Fatal(err)
	}
	old := syntheticIdentity(t, "old")
	if err := os.WriteFile(filepath.Join(path, "state/tailscaled.state"), old, 0600); err != nil {
		t.Fatal(err)
	}
	return path, old
}
func TestIdentityValidationAndSecretFreeSummary(t *testing.T) {
	data := syntheticIdentity(t, "sensitive fixture nickname")
	summary, err := validateIdentity(data)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(summary)
	if bytes.Contains(encoded, []byte("privkey")) || bytes.Contains(encoded, []byte("sensitive")) {
		t.Fatal("summary exposed secret data")
	}
	if summary.ProfileCount != 1 || summary.CurrentProfileID != "abcd" || summary.SHA256 != identityHash(data) {
		t.Fatal(summary)
	}
	for _, bad := range [][]byte{nil, []byte(`{}`), []byte(`{"x":"YQ==","x":"Yg=="}`), append(append([]byte{}, data...), []byte(`{}`)...), bytes.Repeat([]byte("x"), int(maxIdentity)+1)} {
		if _, err = validateIdentity(bad); err == nil {
			t.Fatal("accepted malformed state")
		}
	}
	var state map[string][]byte
	json.Unmarshal(data, &state)
	for _, field := range []string{"_machinekey", "_profiles", "_current-profile", "profile-abcd"} {
		copy := map[string][]byte{}
		for k, v := range state {
			copy[k] = v
		}
		delete(copy, field)
		bad, _ := json.Marshal(copy)
		if _, err = validateIdentity(bad); err == nil {
			t.Fatal("accepted missing", field)
		}
	}
	state["profile-deleted"] = nil
	tombstones, _ := json.Marshal(state)
	if _, err = validateIdentity(tombstones); err != nil {
		t.Fatal("valid FileStore deletion tombstone rejected", err)
	}
	state["_current-profile"] = []byte("profile-missing")
	bad, _ := json.Marshal(state)
	if _, err = validateIdentity(bad); err == nil {
		t.Fatal("dangling current profile accepted")
	}
}
func TestIdentityRestoreFencesAndPrivateArtifacts(t *testing.T) {
	path, old := identityFixture(t)
	candidate := syntheticIdentity(t, "new")
	artifact, err := createArtifact(path, "identity", int64(len(candidate)), bytes.NewReader(candidate))
	if err != nil {
		t.Fatal(err)
	}
	for _, hashes := range [][2]string{{strings.Repeat("0", 64), identityHash(old)}, {identityHash(candidate), strings.Repeat("0", 64)}} {
		if _, err = restoreIdentity(path, artifact.ID, hashes[0], hashes[1]); err == nil {
			t.Fatal("stale digest accepted")
		}
		actual, _ := os.ReadFile(filepath.Join(path, "state/tailscaled.state"))
		if !bytes.Equal(actual, old) {
			t.Fatal("stale restore changed state")
		}
	}
	result, err := restoreIdentity(path, artifact.ID, identityHash(candidate), identityHash(old))
	if err != nil {
		t.Fatal(err)
	}
	actual, _ := os.ReadFile(filepath.Join(path, "state/tailscaled.state"))
	if !bytes.Equal(actual, candidate) {
		t.Fatal("wrong restored bytes")
	}
	info, _ := os.Stat(filepath.Join(path, "state/tailscaled.state"))
	if info.Mode().Perm() != 0600 {
		t.Fatal("state permissions")
	}
	rollback, err := readIdentityArtifact(path, result["rollbackArtifactId"].(string))
	if err != nil || !bytes.Equal(rollback, old) {
		t.Fatal("private rollback not preserved", err)
	}
	var out bytes.Buffer
	if err = useArtifact(path, artifact.ID, "share", "", &out); err == nil || out.Len() != 0 {
		t.Fatal("identity shared")
	}
	if err = useArtifact(path, artifact.ID, "read", "", &out); err != nil || !bytes.Equal(out.Bytes(), candidate) {
		t.Fatal("native save changed bytes", err)
	}
	if err = useArtifact(path, artifact.ID, "extract", t.TempDir(), &out); err == nil {
		t.Fatal("identity used as config backup")
	}
}
func TestIdentityInterruptedPublicationRecovery(t *testing.T) {
	for _, phase := range []string{"prepared", "committed", ""} {
		t.Run(phase, func(t *testing.T) {
			path, old := identityFixture(t)
			root, err := identityStateRoot(path)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			root.Mkdir(identityJournal, 0700)
			journal, _ := openChildRoot(root, identityJournal)
			defer journal.Close()
			writeIdentity(journal, "original", old)
			candidate := syntheticIdentity(t, "new")
			if phase != "" {
				writeIdentity(journal, "phase", []byte(phase))
				writeIdentity(root, "tailscaled.state", candidate)
			}
			if err = recoverIdentity(root); err != nil {
				t.Fatal(err)
			}
			actual, _ := readIdentity(root, "tailscaled.state")
			expected := old
			if phase == "committed" {
				expected = candidate
			}
			if !bytes.Equal(actual, expected) {
				t.Fatal("wrong recovery bytes")
			}
			if _, err = root.Lstat(identityJournal); !os.IsNotExist(err) {
				t.Fatal("journal not cleaned")
			}
		})
	}
}
func TestIdentityRejectsSymlinksAndInvalidJournal(t *testing.T) {
	path, _ := identityFixture(t)
	outside := filepath.Join(t.TempDir(), "outside")
	os.WriteFile(outside, []byte("not touched"), 0600)
	statePath := filepath.Join(path, "state/tailscaled.state")
	os.Remove(statePath)
	os.Symlink(outside, statePath)
	root, _ := identityStateRoot(path)
	defer root.Close()
	if _, err := readIdentity(root, "tailscaled.state"); err == nil {
		t.Fatal("followed state symlink")
	}
	os.Symlink(t.TempDir(), filepath.Join(path, "state", identityJournal))
	if err := recoverIdentity(root); err == nil {
		t.Fatal("followed journal symlink")
	}
	data, _ := os.ReadFile(outside)
	if string(data) != "not touched" {
		t.Fatal("modified external target")
	}
}

func TestIdentityFreshInstallAndAbsentRollback(t *testing.T) {
	path := t.TempDir()
	root, err := identityStateRoot(path)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	old, exists, err := currentIdentity(root)
	if err != nil || exists {
		t.Fatal("fresh baseline", err)
	}
	candidate := syntheticIdentity(t, "new")
	a, err := createArtifact(path, "identity", int64(len(candidate)), bytes.NewReader(candidate))
	if err != nil {
		t.Fatal(err)
	}
	result, err := restoreIdentity(path, a.ID, identityHash(candidate), baselineIdentity(old, exists))
	if err != nil {
		t.Fatal(err)
	}
	if result["rollbackArtifactId"] != "" {
		t.Fatal("invented rollback artifact for absence")
	}
	actual, _ := readIdentity(root, "tailscaled.state")
	if !bytes.Equal(actual, candidate) {
		t.Fatal("fresh restore mismatch")
	}
	root.Mkdir(identityJournal, 0700)
	journal, _ := openChildRoot(root, identityJournal)
	defer journal.Close()
	writeIdentity(journal, "phase", []byte("prepared-absent"))
	if err = recoverIdentity(root); err != nil {
		t.Fatal(err)
	}
	if _, exists, err = currentIdentity(root); exists || err != nil {
		t.Fatal("absence rollback failed", err)
	}
}

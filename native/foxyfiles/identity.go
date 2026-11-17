package main

// Offline FileStore transport, never a live Tailscale preference editor. Errors
// deliberately omit JSON values, keys and paths: these inputs contain secrets.
import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"regexp"
	"strings"
)

const maxIdentity int64 = 4 << 20
const identityJournal = ".identity-transaction"

var identityError = errors.New("invalid or unsupported identity state; original state unchanged")
var identityProfile = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var identityDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

type identitySummary struct {
	OK               bool   `json:"ok"`
	ArtifactID       string `json:"artifactId,omitempty"`
	SHA256           string `json:"sha256"`
	BaselineSHA256   string `json:"baselineSha256,omitempty"`
	BaselineExists   bool   `json:"baselineExists"`
	Size             int    `json:"size"`
	ProfileCount     int    `json:"profileCount"`
	CurrentProfileID string `json:"currentProfileId"`
	Format           string `json:"format"`
	Filename         string `json:"filename,omitempty"`
}

func identityHash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

// Reject duplicate object members at every depth, including encoded prefs. A
// UI/parser disagreement must not select a different identity than was reviewed.
func identityJSON(data []byte) bool {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var value func(int) bool
	value = func(depth int) bool {
		if depth > 32 {
			return false
		}
		tok, err := d.Token()
		if err != nil {
			return false
		}
		delim, ok := tok.(json.Delim)
		if !ok {
			return true
		}
		if delim == '{' {
			seen := map[string]bool{}
			for d.More() {
				k, e := d.Token()
				name, ok := k.(string)
				if e != nil || !ok || seen[name] {
					return false
				}
				seen[name] = true
				if !value(depth + 1) {
					return false
				}
			}
		} else if delim == '[' {
			for d.More() {
				if !value(depth + 1) {
					return false
				}
			}
		} else {
			return false
		}
		end, e := d.Token()
		return e == nil && (delim == '{' && end == json.Delim('}') || delim == '[' && end == json.Delim(']'))
	}
	if !value(0) {
		return false
	}
	_, err := d.Token()
	return err == io.EOF
}
func validIdentityKey(value string) bool {
	if !strings.HasPrefix(value, "privkey:") || len(value) != 72 {
		return false
	}
	_, err := hex.DecodeString(value[8:])
	return err == nil
}
func validateIdentity(data []byte) (identitySummary, error) {
	s := identitySummary{}
	if len(data) == 0 || int64(len(data)) > maxIdentity || !identityJSON(data) {
		return s, identityError
	}
	var state map[string][]byte
	if json.Unmarshal(data, &state) != nil || len(state) == 0 || len(state) > 512 {
		return s, identityError
	}
	for k := range state {
		if len(k) == 0 || len(k) > 256 {
			return s, identityError
		}
	}
	if !validIdentityKey(string(state["_machinekey"])) || string(state["_machinekey"]) == "privkey:"+strings.Repeat("0", 64) {
		return s, identityError
	}
	var profiles map[string]json.RawMessage
	if !identityJSON(state["_profiles"]) || json.Unmarshal(state["_profiles"], &profiles) != nil || len(profiles) == 0 || len(profiles) > 128 {
		return s, identityError
	}
	for id, profile := range profiles {
		if !identityProfile.MatchString(id) || !identityJSON(profile) || len(profile) == 0 || profile[0] != '{' {
			return s, identityError
		}
		prefs := state["profile-"+id]
		if !validateIdentityProfile(id, profile, prefs) {
			return s, identityError
		}
	}
	current := string(state["_current-profile"])
	if !strings.HasPrefix(current, "profile-") || profiles[strings.TrimPrefix(current, "profile-")] == nil {
		return s, identityError
	}
	for k := range state {
		if strings.HasPrefix(k, "profile-") && state[k] != nil && profiles[strings.TrimPrefix(k, "profile-")] == nil {
			return s, identityError
		}
	}
	return identitySummary{OK: true, SHA256: identityHash(data), Size: len(data), ProfileCount: len(profiles), CurrentProfileID: strings.TrimPrefix(current, "profile-"), Format: "tailscale-file-store-v1"}, nil
}
func readIdentity(root *os.Root, name string) ([]byte, error) {
	f, err := root.OpenFile(name, taildropReadFlags(), 0)
	if err != nil {
		return nil, errors.New("identity state unavailable or unsafe")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxIdentity {
		return nil, identityError
	}
	data, err := io.ReadAll(io.LimitReader(f, maxIdentity+1))
	if err != nil || int64(len(data)) > maxIdentity {
		return nil, identityError
	}
	return data, nil
}
func writeIdentity(root *os.Root, name string, data []byte) error {
	id, err := randomID()
	if err != nil {
		return err
	}
	tmp := ".identity-" + id
	f, err := root.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("cannot stage private identity state")
	}
	defer root.Remove(tmp)
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = root.Rename(tmp, name)
	}
	if err == nil {
		err = syncRoot(root)
	}
	if err != nil {
		return errors.New("identity state publication failed")
	}
	return nil
}
func identityStateRoot(path string) (*os.Root, error) {
	module, err := moduleRoot(path)
	if err != nil {
		return nil, err
	}
	defer module.Close()
	return privateChild(module, "state")
}
func currentIdentity(root *os.Root) ([]byte, bool, error) {
	if _, err := root.Lstat("tailscaled.state"); errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	data, err := readIdentity(root, "tailscaled.state")
	return data, true, err
}
func baselineIdentity(data []byte, exists bool) string {
	if !exists {
		return identityHash([]byte("FoxyTail identity absent v1"))
	}
	return identityHash(data)
}
func readIdentityArtifact(path, id string) ([]byte, error) {
	root, guard, err := openArtifacts(path)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	defer guard.Close()
	stage, f, kind, err := openArtifact(root, id)
	if err != nil {
		return nil, errors.New("identity artifact unavailable")
	}
	defer stage.Close()
	defer f.Close()
	if kind != "identity" {
		return nil, errors.New("not an identity artifact")
	}
	data, err := io.ReadAll(io.LimitReader(f, maxIdentity+1))
	if err != nil || int64(len(data)) > maxIdentity {
		return nil, identityError
	}
	return data, nil
}

// Recovery runs under the service lifecycle lock, before any daemon starts.
// An interrupted uncommitted publication restores the exact original bytes.
func recoverIdentity(root *os.Root) error {
	if _, err := root.Lstat(identityJournal); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	journal, err := openChildRoot(root, identityJournal)
	if err != nil {
		return errors.New("identity recovery journal unsafe; service remains stopped")
	}
	defer journal.Close()
	marker, err := journal.ReadFile("phase")
	if errors.Is(err, os.ErrNotExist) {
		// Publication cannot begin before the durable prepared marker.
		if err = root.RemoveAll(identityJournal); err != nil {
			return err
		}
		return syncRoot(root)
	}
	if err != nil {
		return errors.New("identity recovery incomplete; service remains stopped")
	}
	switch string(marker) {
	case "prepared-absent":
		if err = root.Remove("tailscaled.state"); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err = syncRoot(root); err != nil {
			return err
		}
	case "prepared":
		old, err := readIdentity(journal, "original")
		if err != nil {
			return err
		}
		if err = writeIdentity(root, "tailscaled.state", old); err != nil {
			return err
		}
	case "committed":
	default:
		return errors.New("identity recovery phase invalid; service remains stopped")
	}
	if err = root.RemoveAll(identityJournal); err != nil {
		return err
	}
	return syncRoot(root)
}
func restoreIdentity(path, id, expected, baseline string) (map[string]any, error) {
	if !identityDigest.MatchString(expected) || !identityDigest.MatchString(baseline) {
		return nil, identityError
	}
	candidate, err := readIdentityArtifact(path, id)
	if err != nil {
		return nil, err
	}
	if _, err = validateIdentity(candidate); err != nil {
		return nil, err
	}
	if identityHash(candidate) != expected {
		return nil, errors.New("import changed; preview it again")
	}
	root, err := identityStateRoot(path)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if err = recoverIdentity(root); err != nil {
		return nil, err
	}
	old, existed, err := currentIdentity(root)
	if err != nil {
		return nil, err
	}
	if baselineIdentity(old, existed) != baseline {
		return nil, errors.New("current identity changed; preview it again")
	}
	rollback := artifactResult{}
	if len(old) > 0 {
		rollback, err = createArtifact(path, "identity", int64(len(old)), bytes.NewReader(old))
		if err != nil {
			return nil, err
		}
	}
	if err = root.Mkdir(identityJournal, 0700); err != nil {
		return nil, err
	}
	journal, err := openChildRoot(root, identityJournal)
	if err != nil {
		return nil, err
	}
	defer journal.Close()
	// Before prepared is durable, the original state has not been touched. On an
	// incomplete journal fail closed rather than guessing which bytes to start.
	if err = writeIdentity(journal, "original", old); err != nil {
		return nil, err
	}
	phase := "prepared"
	if !existed {
		phase = "prepared-absent"
	}
	if err = writeIdentity(journal, "phase", []byte(phase)); err != nil {
		return nil, err
	}
	if err = syncRoot(root); err != nil {
		return nil, err
	}
	if err = writeIdentity(root, "tailscaled.state", candidate); err == nil {
		var actual []byte
		actual, err = readIdentity(root, "tailscaled.state")
		if err == nil && identityHash(actual) != expected {
			err = identityError
		}
	}
	if err != nil {
		if rollbackErr := recoverIdentity(root); rollbackErr != nil {
			return nil, errors.New("identity restore failed and rollback needs recovery; keep service stopped")
		}
		return nil, errors.New("identity restore failed; original state restored")
	}
	if err = writeIdentity(journal, "phase", []byte("committed")); err != nil {
		return nil, errors.New("identity commit unconfirmed; keep service stopped and recover before retry")
	}
	if err = recoverIdentity(root); err != nil {
		return nil, errors.New("identity committed but cleanup incomplete; keep service stopped")
	}
	return map[string]any{"ok": true, "restored": true, "restartRequired": true, "rollbackArtifactId": rollback.ID}, nil
}
func runIdentity(action string, args []string) error {
	f := flag.NewFlagSet("identity-"+action, flag.ContinueOnError)
	f.SetOutput(io.Discard)
	path := f.String("root", "", "module root")
	id := f.String("id", "", "artifact")
	name := f.String("name", "", "filename")
	size := f.Int64("size", -1, "size")
	hash := f.String("sha256", "", "hash")
	baseline := f.String("baseline", "", "baseline")
	if f.Parse(args) != nil || f.NArg() != 0 {
		return identityError
	}
	var result any
	switch action {
	case "stage":
		if !plainName(*name) || !(strings.HasSuffix(*name, ".state") || strings.HasSuffix(*name, ".json")) || *size < 0 || *size > maxIdentity {
			return identityError
		}
		data, err := io.ReadAll(io.LimitReader(os.Stdin, maxIdentity+1))
		if err != nil || int64(len(data)) != *size {
			return identityError
		}
		if _, err = validateIdentity(data); err != nil {
			return err
		}
		result, err = createArtifact(*path, "identity", *size, bytes.NewReader(data))
		if err != nil {
			return err
		}
	case "restore":
		var err error
		result, err = restoreIdentity(*path, *id, *hash, *baseline)
		if err != nil {
			return err
		}
	case "preview", "export", "recover":
		root, err := identityStateRoot(*path)
		if err != nil {
			return errors.New("identity state unavailable")
		}
		defer root.Close()
		if action == "preview" {
			if _, err = root.Lstat(identityJournal); !errors.Is(err, os.ErrNotExist) {
				return errors.New("identity recovery pending; start recovery before preview")
			}
		} else if err = recoverIdentity(root); err != nil {
			return err
		}
		if action == "recover" {
			return nil
		}
		current, existed, err := currentIdentity(root)
		if err != nil {
			return err
		}
		data := current
		if action == "preview" {
			data, err = readIdentityArtifact(*path, *id)
			if err != nil {
				return err
			}
		}
		summary, err := validateIdentity(data)
		if err != nil {
			return err
		}
		summary.BaselineSHA256 = baselineIdentity(current, existed)
		summary.BaselineExists = existed
		if action == "export" {
			artifact, err := createArtifact(*path, "identity", int64(len(data)), bytes.NewReader(data))
			if err != nil {
				return err
			}
			summary.ArtifactID = artifact.ID
			summary.Filename = "foxytail-identity.state"
		} else {
			summary.ArtifactID = *id
		}
		result = summary
	default:
		return identityError
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const maxDiagnosticArtifact int64 = 16 << 20
const maxArtifacts = 128
const artifactLifetime = 24 * time.Hour

func validArtifactID(id string) bool {
	return strings.HasPrefix(id, "art-") && validID(strings.TrimPrefix(id, "art-"))
}

// A separate store keeps imported archives out of the Taildrop inbox and workers.
func openArtifacts(path string) (*os.Root, *os.File, error) {
	module, err := moduleRoot(path)
	if err != nil {
		return nil, nil, err
	}
	defer module.Close()
	root, err := privateChild(module, ".artifacts")
	if err != nil {
		return nil, nil, err
	}
	guard, err := openTransferLock(root, ".lock")
	if err == nil {
		err = taildropLock(guard)
	}
	if err != nil {
		if guard != nil {
			guard.Close()
		}
		root.Close()
		return nil, nil, errors.New("artifact store is busy or unsafe")
	}
	return root, guard, nil
}

func artifactEntries(root *os.Root) ([]os.DirEntry, error) {
	dir, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(maxArtifacts + 2)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if len(entries) > maxArtifacts+1 {
		return nil, errors.New("artifact store contains too many entries")
	}
	return entries, nil
}

// Locking the directory also protects the original throughout a shell restore:
// its inherited descriptor keeps the lease alive until exit, including SIGKILL.
func expireArtifacts(root *os.Root, now time.Time) (int, error) {
	entries, err := artifactEntries(root)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, entry := range entries {
		if !validArtifactID(entry.Name()) {
			continue
		}
		count++
		info, err := root.Lstat(entry.Name())
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if now.Sub(info.ModTime()) > artifactLifetime {
			stage, openErr := openChildRoot(root, entry.Name())
			if openErr != nil {
				continue
			}
			lease, lockErr := artifactLease(stage)
			stage.Close()
			if lockErr != nil {
				continue
			}
			err = root.RemoveAll(entry.Name())
			lease.Close()
			if err != nil {
				return count, err
			}
			count--
		}
	}
	return count, nil
}

type artifactResult struct {
	OK   bool   `json:"ok"`
	ID   string `json:"id"`
	Size int64  `json:"size"`
}

func artifactLimit(kind string) int64 {
	if kind == "diagnostic" {
		return maxDiagnosticArtifact
	}
	return maxCompressed
}

func createArtifact(path, kind string, expected int64, input io.Reader) (artifactResult, error) {
	result := artifactResult{}
	if kind != "import" && kind != "backup" && kind != "diagnostic" {
		return result, errors.New("unknown artifact kind")
	}
	limit := artifactLimit(kind)
	if expected < -1 || expected > limit {
		return result, errors.New("artifact size exceeds limit")
	}
	root, guard, err := openArtifacts(path)
	if err != nil {
		return result, err
	}
	defer root.Close()
	defer guard.Close()
	count, err := expireArtifacts(root, time.Now())
	if err != nil {
		return result, err
	}
	if count >= maxArtifacts {
		return result, errors.New("artifact store is full; delete unused artifacts")
	}
	random, err := randomID()
	if err != nil {
		return result, err
	}
	id := "art-" + random
	if err = root.Mkdir(id, 0700); err != nil {
		return result, err
	}
	keep := false
	defer func() {
		if !keep {
			root.RemoveAll(id)
		}
	}()
	stage, err := openChildRoot(root, id)
	if err != nil {
		return result, err
	}
	defer stage.Close()
	// Reserve the slot under the store lock, then protect only this stage.
	// A document provider can stall indefinitely while supplying stdin; it must
	// not prevent reads, deletes or other imports in the artifact store.
	lease, err := artifactLease(stage)
	if err != nil {
		return result, err
	}
	defer lease.Close()
	guard.Close()
	out, err := stage.OpenFile(".pending", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return result, err
	}
	if expected >= 0 {
		limit = expected
	}
	n, copyErr := io.Copy(out, io.LimitReader(input, limit+1))
	if copyErr == nil && (n == 0 || n > limit || expected >= 0 && n != expected) {
		copyErr = errors.New("artifact is empty, oversized or does not match declared length")
	}
	if copyErr == nil {
		copyErr = out.Sync()
	}
	closeErr := out.Close()
	if copyErr != nil {
		return result, copyErr
	}
	if closeErr != nil {
		return result, closeErr
	}
	if err = stage.Rename(".pending", kind+".tar.gz"); err != nil {
		return result, err
	}
	if err = syncRoot(stage); err != nil {
		return result, err
	}
	if err = syncRoot(root); err != nil {
		return result, err
	}
	keep = true
	return artifactResult{true, id, n}, nil
}

func openArtifact(root *os.Root, id string) (*os.Root, *os.File, string, error) {
	if !validArtifactID(id) {
		return nil, nil, "", errors.New("invalid artifact token")
	}
	stage, err := openChildRoot(root, id)
	if err != nil {
		return nil, nil, "", err
	}
	for _, kind := range []string{"import", "backup", "diagnostic"} {
		file, err := stage.OpenFile(kind+".tar.gz", taildropReadFlags(), 0)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			stage.Close()
			return nil, nil, "", err
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > artifactLimit(kind) {
			file.Close()
			stage.Close()
			return nil, nil, "", errors.New("artifact must be a bounded regular file")
		}
		return stage, file, kind, nil
	}
	stage.Close()
	return nil, nil, "", errors.New("artifact is incomplete or unknown")
}

func artifactLease(stage *os.Root) (*os.File, error) {
	file, err := stage.Open(".")
	if err == nil {
		err = taildropLock(file)
	}
	if err != nil {
		if file != nil {
			file.Close()
		}
		return nil, errors.New("artifact is in use")
	}
	return file, nil
}

func useArtifact(path, id, action, destination string, output io.Writer) error {
	if !validArtifactID(id) {
		return errors.New("invalid artifact token")
	}
	root, guard, err := openArtifacts(path)
	if err != nil {
		return err
	}
	defer root.Close()
	defer guard.Close()
	if _, err = expireArtifacts(root, time.Now()); err != nil {
		return err
	}
	stage, file, kind, err := openArtifact(root, id)
	if err != nil {
		return err
	}
	defer stage.Close()
	defer file.Close()
	switch action {
	case "read":
		_, err = io.Copy(output, &boundedReader{r: file, left: artifactLimit(kind)})
		return err
	case "delete":
		lease, err := artifactLease(stage)
		if err != nil {
			return err
		}
		defer lease.Close()
		return root.RemoveAll(id)
	case "pin":
		// Descriptor 8 is inherited from the restoring shell, never a path
		// supplied by the app. Closing this duplicate leaves its lock alive.
		lease := os.NewFile(8, "artifact-restore-lease")
		if lease == nil {
			return errors.New("missing inherited restore descriptor")
		}
		defer lease.Close()
		opened, statErr := lease.Stat()
		expected, expectedErr := stage.Stat(".")
		if statErr != nil || expectedErr != nil || !os.SameFile(opened, expected) || !opened.IsDir() {
			return errors.New("restore lease does not match artifact")
		}
		return taildropLock(lease)
	case "extract":
		if kind == "diagnostic" {
			return errors.New("diagnostic artifacts cannot be restored")
		}
		sum, err := extract(filepath.Join(path, ".artifacts", id, kind+".tar.gz"), destination)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(output, sum)
		return err
	default:
		return errors.New("unknown artifact action")
	}
}

func runArtifact(action string, args []string) error {
	flags := flag.NewFlagSet("artifact-"+action, flag.ContinueOnError)
	root := flags.String("root", "", "module root")
	id := flags.String("id", "", "artifact token")
	name := flags.String("name", "", "import display name")
	size := flags.Int64("size", -1, "declared stdin size")
	kind := flags.String("kind", "import", "artifact kind")
	source := flags.String("source", "", "internally generated archive")
	destination := flags.String("destination", "", "new private extraction directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected artifact arguments")
	}
	if action == "stage" || action == "create" {
		input := os.Stdin
		if action == "stage" {
			if !plainName(*name) || !strings.HasSuffix(*name, ".tar.gz") || *kind != "import" || *source != "" {
				return errors.New("expected a plain .tar.gz import filename")
			}
		} else {
			if *kind != "backup" && *kind != "diagnostic" {
				return errors.New("only generated backups and diagnostics can be registered")
			}
			if !filepath.IsAbs(*source) || filepath.Clean(*source) != *source {
				return errors.New("invalid generated archive path")
			}
			parent, err := archiveSourceRoot(filepath.Dir(*source))
			if err != nil {
				return err
			}
			defer parent.Close()
			input, err = parent.OpenFile(filepath.Base(*source), taildropReadFlags(), 0)
			if err != nil {
				return err
			}
			defer input.Close()
			info, err := input.Stat()
			if err != nil || !info.Mode().IsRegular() {
				return errors.New("generated archive must be a regular file")
			}
			*size = info.Size()
		}
		result, err := createArtifact(*root, *kind, *size, input)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(result)
	}
	if err := useArtifact(*root, *id, action, *destination, os.Stdout); err != nil {
		return err
	}
	if action == "delete" {
		return json.NewEncoder(os.Stdout).Encode(map[string]bool{"ok": true})
	}
	return nil
}

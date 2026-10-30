package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

const maxSendSize int64 = 2 << 30

// Format characters (bidi overrides, zero-width spaces, BOM) reorder or hide
// filename text in every UI and shell consumer, so they fail like controls.
func unsafeNameRune(r rune) bool {
	return unicode.IsControl(r) || unicode.Is(unicode.Cf, r)
}

func plainName(name string) bool {
	return name != "" && name != "." && name != ".." && len(name) <= 255 && utf8.ValidString(name) && !strings.ContainsAny(name, "/\\") && strings.IndexFunc(name, unsafeNameRune) < 0
}

func relativeParts(path string) ([]string, error) {
	if path == "" {
		return nil, nil
	}
	parts := strings.Split(path, "/")
	for _, part := range parts {
		if !plainName(part) {
			return nil, errors.New("path must contain only real, plain components")
		}
	}
	return parts, nil
}

func randomID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func validID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func privateChild(parent *os.Root, name string) (*os.Root, error) {
	if err := parent.Mkdir(name, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	root, err := openChildRoot(parent, name)
	if err != nil {
		return nil, err
	}
	dir, err := root.Open(".")
	if err == nil {
		err = dir.Chmod(0700)
		dir.Close()
	}
	if err != nil {
		root.Close()
		return nil, err
	}
	return root, nil
}

func moduleRoot(path string) (*os.Root, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("module root must be an absolute clean path")
	}
	return openRealRoot(path)
}

func outgoingRoot(path string) (*os.Root, error) {
	module, err := moduleRoot(path)
	if err != nil {
		return nil, err
	}
	defer module.Close()
	files, err := privateChild(module, "files")
	if err != nil {
		return nil, err
	}
	defer files.Close()
	return privateChild(files, ".outgoing")
}

type browseEntry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Directory bool   `json:"directory"`
	Size      int64  `json:"size"`
	Mtime     int64  `json:"mtime"`
}

type browseResult struct {
	OK        bool          `json:"ok"`
	Path      string        `json:"path"`
	Entries   []browseEntry `json:"entries"`
	Truncated bool          `json:"truncated"`
}

func browseFiles(source, relative string) (browseResult, error) {
	result := browseResult{OK: true, Path: relative, Entries: []browseEntry{}}
	parts, err := relativeParts(relative)
	if err != nil {
		return result, err
	}
	if !filepath.IsAbs(source) || filepath.Clean(source) != source {
		return result, errors.New("source must be an absolute clean path")
	}
	root, err := archiveSourceRoot(source)
	if err != nil {
		return result, err
	}
	for _, part := range parts {
		next, e := openChildRoot(root, part)
		root.Close()
		if e != nil {
			return result, e
		}
		root = next
	}
	defer root.Close()
	dir, err := root.Open(".")
	if err != nil {
		return result, err
	}
	defer dir.Close()
	// Bound both response size and scanning work, including hostile special entries.
	entries, err := dir.ReadDir(1001)
	if err != nil && !errors.Is(err, io.EOF) {
		return result, err
	}
	result.Truncated = len(entries) > 1000
	if result.Truncated {
		entries = entries[:1000]
	}
	for _, entry := range entries {
		if !plainName(entry.Name()) {
			continue
		}
		info, e := root.Lstat(entry.Name())
		if e != nil || info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
			continue
		}
		result.Entries = append(result.Entries, browseEntry{entry.Name(), filepath.Join(source, relative, entry.Name()), info.IsDir(), info.Size(), info.ModTime().Unix()})
	}
	sort.Slice(result.Entries, func(i, j int) bool {
		a, b := result.Entries[i], result.Entries[j]
		if a.Directory != b.Directory {
			return a.Directory
		}
		return a.Name < b.Name
	})
	return result, nil
}

func runBrowse(args []string) error {
	flags := flag.NewFlagSet("browse", flag.ContinueOnError)
	source := flags.String("source", "", "shared storage root")
	path := flags.String("path", "", "relative directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected browse arguments")
	}
	result, err := browseFiles(*source, *path)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

type stageResult struct {
	OK   bool   `json:"ok"`
	Path string `json:"path"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// Names tailscaled only produces for a finished transfer: in-flight
// *.partial/*.deleted files and internal directories never complete.
func taildropCompletedName(name string) bool {
	return plainName(name) && name != ".taildrop" && name != ".outgoing" &&
		!strings.HasSuffix(name, ".partial") && !strings.HasSuffix(name, ".deleted")
}

func stageFile(rootPath, name string, expected int64, input io.Reader) (stageResult, error) {
	result := stageResult{}
	if expected < -1 || expected > maxSendSize {
		return result, errors.New("invalid stage size (maximum 2 GiB)")
	}
	if !taildropCompletedName(name) || name == ".lease" || name == ".data" {
		return result, errors.New("invalid stage name; receivers drop .taildrop, .outgoing, *.partial and *.deleted")
	}
	store, err := openTransferStore(rootPath)
	if err != nil {
		return result, err
	}
	defer store.Close()
	guard, err := store.guard()
	if err != nil {
		return result, err
	}
	if err = store.maintain(); err != nil {
		guard.Close()
		return result, err
	}
	outgoing, err := outgoingRoot(rootPath)
	if err != nil {
		guard.Close()
		return result, err
	}
	defer outgoing.Close()
	dir, err := outgoing.Open(".")
	if err != nil {
		guard.Close()
		return result, err
	}
	entries, err := dir.ReadDir(257)
	dir.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		guard.Close()
		return result, err
	}
	if len(entries) >= 256 {
		guard.Close()
		return result, errors.New("private staging is full; remove unused selections or retry after expiration")
	}
	token, err := randomID()
	if err != nil {
		guard.Close()
		return result, err
	}
	if err = outgoing.Mkdir(token, 0700); err != nil {
		guard.Close()
		return result, err
	}
	stage, err := openChildRoot(outgoing, token)
	if err != nil {
		outgoing.Remove(token)
		guard.Close()
		return result, err
	}
	defer stage.Close()
	keep := false
	defer func() {
		if !keep {
			stage.Remove(".data")
			stage.Remove(name)
			stage.Remove(".lease")
			outgoing.Remove(token)
		}
	}()
	lease, err := openTransferLock(stage, ".lease")
	if err == nil {
		err = taildropLock(lease)
	}
	guard.Close()
	if lease != nil {
		defer lease.Close()
	}
	if err != nil {
		return result, err
	}
	output, err := stage.OpenFile(".data", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return result, err
	}
	limit := maxSendSize
	if expected >= 0 {
		limit = expected
	}
	n, copyErr := io.Copy(output, io.LimitReader(input, limit+1))
	if copyErr == nil && (n > maxSendSize || expected >= 0 && n != expected) {
		copyErr = errors.New("staged bytes do not match expected size or exceed 2 GiB")
	}
	if copyErr == nil {
		copyErr = output.Sync()
	}
	closeErr := output.Close()
	if copyErr != nil {
		return result, copyErr
	}
	if closeErr != nil {
		return result, closeErr
	}
	if err = stage.Rename(".data", name); err != nil {
		return result, err
	}
	if err = syncRoot(stage); err != nil {
		return result, err
	}
	if err = syncRoot(outgoing); err != nil {
		return result, err
	}
	keep = true
	return stageResult{true, filepath.Join(rootPath, "files", ".outgoing", token, name), name, n}, nil
}

func stagedParts(rootPath, path string) (string, string, bool) {
	prefix := filepath.Join(rootPath, "files", ".outgoing") + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
	if len(parts) != 2 || !validID(parts[0]) || !taildropCompletedName(parts[1]) || parts[1] == ".lease" || parts[1] == ".data" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func removeStaged(rootPath, path string) error {
	token, name, ok := stagedParts(rootPath, path)
	if !ok {
		return errors.New("not a private staged file")
	}
	outgoing, err := outgoingRoot(rootPath)
	if err != nil {
		return err
	}
	defer outgoing.Close()
	stage, err := openChildRoot(outgoing, token)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer stage.Close()
	lease, err := openTransferLock(stage, ".lease")
	if err != nil {
		return err
	}
	defer lease.Close()
	if err = taildropLock(lease); err != nil {
		return errors.New("staged file is still being written")
	}
	info, err := stage.Lstat(name)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		if !info.Mode().IsRegular() {
			return errors.New("staged source must be a regular file")
		}
		if err = stage.Remove(name); err != nil {
			return err
		}
	}
	if err = stage.Remove(".lease"); err != nil {
		return err
	}
	if err = outgoing.Remove(token); err != nil {
		return err
	}
	return syncRoot(outgoing)
}

func runStage(args []string) error {
	flags := flag.NewFlagSet("stage", flag.ContinueOnError)
	root := flags.String("root", "", "module root")
	name := flags.String("name", "", "display name")
	size := flags.Int64("size", -1, "expected length, or -1")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected stage arguments")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer stop()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			os.Stdin.Close()
		case <-finished:
		}
	}()
	result, err := stageFile(*root, *name, *size, os.Stdin)
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return errors.Join(ctx.Err(), removeStaged(*root, result.Path))
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

func runStageDelete(args []string) error {
	flags := flag.NewFlagSet("stage-delete", flag.ContinueOnError)
	root := flags.String("root", "", "module root")
	path := flags.String("path", "", "private staged file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected stage-delete arguments")
	}
	if _, _, ok := stagedParts(*root, *path); !ok {
		return errors.New("not a private staged file")
	}
	store, err := openTransferStore(*root)
	if err != nil {
		return err
	}
	defer store.Close()
	guard, err := store.guard()
	if err != nil {
		return err
	}
	defer guard.Close()
	if err = store.recoverInterrupted(); err != nil {
		return err
	}
	records, err := store.records()
	if err != nil {
		return err
	}
	for _, record := range records {
		if !activeTransfer(record.Status) {
			continue
		}
		for _, file := range record.Files {
			if file.Path == *path {
				return errors.New("staged file belongs to an active transfer")
			}
		}
	}
	if err = removeStaged(*root, *path); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]bool{"ok": true})
}

func readInbox(rootPath, name string, output io.Writer) error {
	if !plainName(name) || name == ".taildrop" || name == ".outgoing" || strings.HasSuffix(name, ".partial") || strings.HasSuffix(name, ".deleted") {
		return errors.New("invalid inbox filename")
	}
	inbox, err := archiveSourceRoot(rootPath)
	if err != nil {
		return err
	}
	defer inbox.Close()
	file, err := inbox.OpenFile(name, taildropReadFlags(), 0)
	if err != nil {
		return err
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() {
		return errors.New("inbox item is not a regular file")
	}
	if _, err = io.CopyN(output, file, before.Size()); err != nil {
		return err
	}
	after, err := file.Stat()
	current, pathErr := inbox.Lstat(name)
	if err != nil || pathErr != nil || !os.SameFile(before, current) || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return errors.New("inbox file changed during read")
	}
	return nil
}

func runInboxRead(args []string) error {
	flags := flag.NewFlagSet("inbox-read", flag.ContinueOnError)
	root := flags.String("root", "", "inbox directory")
	name := flags.String("name", "", "inbox filename")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected inbox-read arguments")
	}
	return readInbox(*root, *name, os.Stdout)
}

func olderThanDay(info os.FileInfo) bool { return time.Since(info.ModTime()) > 24*time.Hour }

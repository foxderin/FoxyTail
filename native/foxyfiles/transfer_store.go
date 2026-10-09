package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

type transferFile struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Path           string `json:"path"`
	Size           int64  `json:"size"`
	SentBytes      int64  `json:"sentBytes"`
	ProgressKnown  bool   `json:"progressKnown"`
	BytesPerSecond int64  `json:"bytesPerSecond"`
	Status         string `json:"status"`
	Error          string `json:"error,omitempty"`
}

type transfer struct {
	ID        string         `json:"id"`
	PeerID    string         `json:"peerId"`
	PeerName  string         `json:"peerName"`
	PeerIP    string         `json:"peerIp"`
	SelfID    string         `json:"selfId"`
	Status    string         `json:"status"`
	StartedAt int64          `json:"startedAt"`
	UpdatedAt int64          `json:"updatedAt"`
	Files     []transferFile `json:"files"`
	Error     string         `json:"error,omitempty"`
}

type fileIdentity struct {
	Device   uint64 `json:"device"`
	Inode    uint64 `json:"inode"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
}

func identity(info os.FileInfo) fileIdentity {
	stat := info.Sys().(*syscall.Stat_t)
	return fileIdentity{uint64(stat.Dev), uint64(stat.Ino), info.Size(), info.ModTime().UnixNano()}
}

type transferRecord struct {
	transfer
	Socket     string         `json:"socket"`
	Source     string         `json:"source"`
	Identities []fileIdentity `json:"identities"`
}

type transferStore struct {
	root *os.Root
	path string
}

func openTransferStore(path string) (*transferStore, error) {
	module, err := moduleRoot(path)
	if err != nil {
		return nil, err
	}
	defer module.Close()
	state, err := privateChild(module, "state")
	if err != nil {
		return nil, err
	}
	defer state.Close()
	root, err := privateChild(state, "taildrop")
	if err != nil {
		return nil, err
	}
	return &transferStore{root, path}, nil
}

func (s *transferStore) Close() { s.root.Close() }

func openTransferLock(root *os.Root, name string) (*os.File, error) {
	file, err := root.OpenFile(name, taildropReadWriteFlags(), 0600)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, errors.New("invalid transfer lock file")
	}
	if err = file.Chmod(0600); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func lockBusy(err error) bool {
	return errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN)
}

func (s *transferStore) guard() (*os.File, error) {
	file, err := openTransferLock(s.root, "state.lock")
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		err = taildropLock(file)
		if err == nil {
			return file, nil
		}
		if !lockBusy(err) || time.Now().After(deadline) {
			file.Close()
			return nil, fmt.Errorf("transfer state is busy: %w", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (s *transferStore) activeLock() (*os.File, error) {
	file, err := openTransferLock(s.root, "active.lock")
	if err != nil {
		return nil, err
	}
	if err = taildropLock(file); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func activeTransfer(status string) bool { return status == "queued" || status == "sending" }

func (s *transferStore) save(record *transferRecord) error {
	if !validID(record.ID) {
		return errors.New("invalid transfer ID")
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if len(data) > 128<<10 {
		return errors.New("transfer record exceeds limit")
	}
	token, err := randomID()
	if err != nil {
		return err
	}
	name := ".write-" + token
	file, err := s.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer s.root.Remove(name)
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = s.root.Rename(name, record.ID+".json"); err != nil {
		return err
	}
	return syncRoot(s.root)
}

func (s *transferStore) load(id string) (*transferRecord, error) {
	if !validID(id) {
		return nil, errors.New("invalid transfer ID")
	}
	file, err := s.root.OpenFile(id+".json", taildropReadFlags(), 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 128<<10 {
		return nil, errors.New("invalid transfer record")
	}
	var record transferRecord
	if err = decodeBoundedJSON(file, 128<<10, &record); err != nil {
		return nil, err
	}
	if record.ID != id || len(record.Files) == 0 || len(record.Files) > 32 || len(record.Identities) != len(record.Files) {
		return nil, errors.New("invalid transfer record contents")
	}
	return &record, nil
}

func (s *transferStore) records() ([]*transferRecord, error) {
	dir, err := s.root.Open(".")
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(1025)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if len(entries) > 1024 {
		return nil, errors.New("too many private transfer records")
	}
	records := []*transferRecord{}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") || !validID(strings.TrimSuffix(name, ".json")) {
			continue
		}
		record, err := s.load(strings.TrimSuffix(name, ".json"))
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].StartedAt == records[j].StartedAt {
			return records[i].ID > records[j].ID
		}
		return records[i].StartedAt > records[j].StartedAt
	})
	return records, nil
}

func (s *transferStore) recoverInterrupted() error {
	lock, err := s.activeLock()
	if lockBusy(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer lock.Close()
	records, err := s.records()
	if err != nil {
		return err
	}
	for _, record := range records {
		if !activeTransfer(record.Status) {
			continue
		}
		record.Status = "interrupted"
		record.Error = "Transfer worker stopped before a final result; retry only unfinished files"
		record.UpdatedAt = time.Now().Unix()
		for i := range record.Files {
			if activeTransfer(record.Files[i].Status) {
				record.Files[i].Status = "failed"
				record.Files[i].Error = record.Error
				record.Files[i].BytesPerSecond = 0
			}
		}
		if err = s.save(record); err != nil {
			return err
		}
		if err = s.root.Remove(record.ID + ".cancel"); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (s *transferStore) requestCancel(id string) error {
	if !validID(id) {
		return errors.New("invalid transfer ID")
	}
	file, err := s.root.OpenFile(id+".cancel", os.O_WRONLY|os.O_CREATE|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return errors.New("invalid cancellation marker")
	}
	err = file.Sync()
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return syncRoot(s.root)
}

func (s *transferStore) cancelled(id string) (bool, error) {
	info, err := s.root.Lstat(id + ".cancel")
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, errors.New("invalid cancellation marker")
	}
	return true, nil
}

// Called under state.lock; active.lock protects every worker source, not PIDs.
func (s *transferStore) maintain() error {
	if err := s.recoverInterrupted(); err != nil {
		return err
	}
	records, err := s.records()
	if err != nil {
		return err
	}
	activePaths := map[string]bool{}
	kept := 0
	for _, record := range records {
		if activeTransfer(record.Status) {
			for _, file := range record.Files {
				activePaths[file.Path] = true
				if token, _, ok := stagedParts(s.path, file.Path); ok {
					activePaths[filepath.Join(s.path, "files", ".outgoing", token)] = true
				}
			}
			continue
		}
		kept++
		if kept > 99 {
			if err = s.root.Remove(record.ID + ".json"); err != nil {
				return err
			}
			if err = s.root.Remove(record.ID + ".cancel"); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	outgoing, err := outgoingRoot(s.path)
	if err != nil {
		return err
	}
	defer outgoing.Close()
	dir, err := outgoing.Open(".")
	if err != nil {
		return err
	}
	entries, err := dir.ReadDir(257)
	dir.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	for _, entry := range entries {
		if !validID(entry.Name()) {
			continue
		}
		info, err := outgoing.Lstat(entry.Name())
		if err != nil || !info.IsDir() || !olderThanDay(info) || activePaths[filepath.Join(s.path, "files", ".outgoing", entry.Name())] {
			continue
		}
		stage, err := openChildRoot(outgoing, entry.Name())
		if err != nil {
			continue
		}
		lease, err := openTransferLock(stage, ".lease")
		if err != nil {
			stage.Close()
			continue
		}
		if err = taildropLock(lease); err != nil {
			lease.Close()
			stage.Close()
			continue
		}
		childDir, err := stage.Open(".")
		if err != nil {
			lease.Close()
			stage.Close()
			continue
		}
		children, readErr := childDir.ReadDir(5)
		childDir.Close()
		canDelete := readErr == nil || errors.Is(readErr, io.EOF)
		if len(children) > 3 {
			canDelete = false
		}
		for _, child := range children {
			if !child.Type().IsRegular() || activePaths[filepath.Join(s.path, "files", ".outgoing", entry.Name(), child.Name())] {
				canDelete = false
			}
		}
		if canDelete {
			for _, child := range children {
				if err = stage.Remove(child.Name()); err != nil {
					break
				}
			}
			if err == nil {
				err = outgoing.Remove(entry.Name())
			}
		}
		lease.Close()
		stage.Close()
		if canDelete && err != nil {
			return err
		}
	}
	stateDir, err := s.root.Open(".")
	if err != nil {
		return err
	}
	stateEntries, err := stateDir.ReadDir(1025)
	stateDir.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	for _, entry := range stateEntries {
		if !strings.HasPrefix(entry.Name(), ".write-") {
			continue
		}
		info, err := s.root.Lstat(entry.Name())
		if err == nil && info.Mode().IsRegular() && olderThanDay(info) {
			if err = s.root.Remove(entry.Name()); err != nil {
				return err
			}
		}
	}
	return nil
}

type sendSource struct {
	root       *os.Root
	file       *os.File
	name       string
	before     os.FileInfo
	modulePath string
	sourcePath string
	fullPath   string
}

func (s *sendSource) Close() { s.file.Close(); s.root.Close() }

func openSendSource(rootPath, source, path string) (*sendSource, error) {
	var root *os.Root
	var relative string
	var err error
	if _, _, staged := stagedParts(rootPath, path); staged {
		root, err = outgoingRoot(rootPath)
		relative = strings.TrimPrefix(path, filepath.Join(rootPath, "files", ".outgoing")+"/")
	} else {
		if !filepath.IsAbs(source) || filepath.Clean(source) != source || !strings.HasPrefix(path, source+"/") {
			return nil, errors.New("send source must be shared storage or a private staged file")
		}
		root, err = archiveSourceRoot(source)
		relative = strings.TrimPrefix(path, source+"/")
	}
	if err != nil {
		return nil, err
	}
	parts, err := relativeParts(relative)
	if err != nil || len(parts) == 0 || len(path) > 4096 {
		root.Close()
		return nil, errors.New("invalid source path")
	}
	for _, part := range parts[:len(parts)-1] {
		next, err := openChildRoot(root, part)
		root.Close()
		if err != nil {
			return nil, err
		}
		root = next
	}
	name := parts[len(parts)-1]
	file, err := root.OpenFile(name, taildropReadFlags(), 0)
	if err != nil {
		root.Close()
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > maxSendSize {
		file.Close()
		root.Close()
		return nil, errors.New("source must be a regular file no larger than 2 GiB")
	}
	current, err := root.Lstat(name)
	if err != nil || !current.Mode().IsRegular() || !os.SameFile(info, current) {
		file.Close()
		root.Close()
		return nil, errors.New("source changed during open")
	}
	return &sendSource{root: root, file: file, name: name, before: info, modulePath: rootPath, sourcePath: source, fullPath: path}, nil
}

func (s *sendSource) unchanged() error {
	after, err := s.file.Stat()
	if err != nil {
		return err
	}
	current, err := s.root.Lstat(s.name)
	if err != nil || !current.Mode().IsRegular() || !os.SameFile(s.before, current) || identity(after) != identity(s.before) {
		return errors.New("source changed during upload; recipient may have received earlier bytes")
	}
	reopened, err := openSendSource(s.modulePath, s.sourcePath, s.fullPath)
	if err != nil {
		return errors.New("source path changed during upload")
	}
	defer reopened.Close()
	if !os.SameFile(s.before, reopened.before) || identity(s.before) != identity(reopened.before) {
		return errors.New("source path changed during upload")
	}
	return nil
}

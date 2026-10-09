package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/netip"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

var errTransferCancelled = errors.New("Transfer cancelled by user")
var errTransferInterrupted = errors.New("Transfer worker interrupted")

func runTargets(args []string) error {
	flags := flag.NewFlagSet("taildrop-targets", flag.ContinueOnError)
	socket := flags.String("socket", "", "tailscaled LocalAPI socket")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected taildrop-targets arguments")
	}
	api, err := newLocalAPI(*socket)
	if err != nil {
		return err
	}
	defer api.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err = api.self(ctx); err != nil {
		return err
	}
	peers, err := api.targets(ctx)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		OK    bool           `json:"ok"`
		Peers []taildropPeer `json:"peers"`
	}{true, peers})
}

func transferResponse(record *transferRecord) error {
	return json.NewEncoder(os.Stdout).Encode(struct {
		OK       bool     `json:"ok"`
		Transfer transfer `json:"transfer"`
	}{true, record.transfer})
}

func runSendStart(args []string) error {
	flags := flag.NewFlagSet("send-start", flag.ContinueOnError)
	root := flags.String("root", "", "module root")
	socket := flags.String("socket", "", "tailscaled LocalAPI socket")
	source := flags.String("source", "", "shared storage root")
	peerID := flags.String("peer", "", "stable peer identity")
	address := flags.String("address", "", "current peer IP")
	paths := flags.String("paths", "", "JSON source paths")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected send-start arguments")
	}
	record, err := startTransfer(*root, *socket, *source, *peerID, *address, *paths)
	if err != nil {
		return err
	}
	return transferResponse(record)
}

func startTransfer(rootPath, socket, source, peerID, address, pathsJSON string) (*transferRecord, error) {
	if len(pathsJSON) > 16<<10 || !filepath.IsAbs(source) || filepath.Clean(source) != source {
		return nil, errors.New("invalid shared source or source list exceeds 16 KiB")
	}
	var paths []string
	if err := json.Unmarshal([]byte(pathsJSON), &paths); err != nil || len(paths) == 0 || len(paths) > 32 {
		return nil, errors.New("select between 1 and 32 files")
	}
	api, err := newLocalAPI(socket)
	if err != nil {
		return nil, err
	}
	defer api.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	self, peer, err := api.validatePeer(ctx, peerID, address, "")
	if err != nil {
		return nil, err
	}
	store, err := openTransferStore(rootPath)
	if err != nil {
		return nil, err
	}
	defer store.Close()
	guard, err := store.guard()
	if err != nil {
		return nil, err
	}
	defer guard.Close()
	module, err := moduleRoot(rootPath)
	if err != nil {
		return nil, err
	}
	_, installingErr := module.Lstat(".installing")
	module.Close()
	if installingErr == nil {
		return nil, errors.New("module upgrade is in progress; retry after installation")
	}
	if !errors.Is(installingErr, os.ErrNotExist) {
		return nil, installingErr
	}
	if err = store.maintain(); err != nil {
		return nil, err
	}
	active, err := store.activeLock()
	if lockBusy(err) {
		return nil, errors.New("another Taildrop send is already active")
	}
	if err != nil {
		return nil, err
	}
	defer active.Close()
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	ip, _ := netip.ParseAddr(address)
	record := &transferRecord{transfer: transfer{ID: id, PeerID: peerID, PeerName: peer.Hostname, PeerIP: ip.Unmap().String(), SelfID: self, Status: "queued", StartedAt: now, UpdatedAt: now, Files: []transferFile{}}, Socket: socket, Source: source, Identities: []fileIdentity{}}
	seen := map[string]bool{}
	for _, path := range paths {
		if seen[path] {
			return nil, errors.New("duplicate source selection")
		}
		seen[path] = true
		opened, err := openSendSource(rootPath, source, path)
		if err != nil {
			return nil, fmt.Errorf("cannot send %q: %w", path, err)
		}
		fileID, err := randomID()
		if err != nil {
			opened.Close()
			return nil, err
		}
		record.Files = append(record.Files, transferFile{ID: fileID, Name: opened.name, Path: path, Size: opened.before.Size(), Status: "queued"})
		record.Identities = append(record.Identities, identity(opened.before))
		opened.Close()
	}
	if err = store.save(record); err != nil {
		return nil, err
	}
	if err = spawnTransferWorker(rootPath, id, active); err != nil {
		record.Status = "failed"
		record.Error = "Could not start transfer worker: " + err.Error()
		for i := range record.Files {
			record.Files[i].Status = "failed"
			record.Files[i].Error = record.Error
		}
		record.UpdatedAt = time.Now().Unix()
		if saveErr := store.save(record); saveErr != nil {
			return nil, errors.Join(err, saveErr)
		}
	}
	return record, nil
}

func spawnTransferWorker(root, id string, active *os.File) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer null.Close()
	command := exec.Command(executable, "send-worker", "--root", root, "--id", id)
	command.Stdin, command.Stdout, command.Stderr = null, null, null
	command.ExtraFiles = []*os.File{active}
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err = command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

func runSendQuery(command string, args []string) error {
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	root := flags.String("root", "", "module root")
	id := flags.String("id", "", "transfer ID")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected send query arguments")
	}
	if command != "send-history" && command != "send-stop" && !validID(*id) {
		return errors.New("invalid transfer ID")
	}
	store, err := openTransferStore(*root)
	if err != nil {
		return err
	}
	defer store.Close()
	if command == "send-stop" {
		return stopTransfers(store)
	}
	guard, err := store.guard()
	if err != nil {
		return err
	}
	defer guard.Close()
	if err = store.maintain(); err != nil {
		return err
	}
	if command == "send-history" {
		records, err := store.records()
		if err != nil {
			return err
		}
		transfers := []transfer{}
		for _, record := range records {
			transfers = append(transfers, record.transfer)
		}
		return json.NewEncoder(os.Stdout).Encode(struct {
			OK        bool       `json:"ok"`
			Transfers []transfer `json:"transfers"`
		}{true, transfers})
	}
	record, err := store.load(*id)
	if err != nil {
		return err
	}
	if command == "send-cancel" && activeTransfer(record.Status) {
		if err = store.requestCancel(record.ID); err != nil {
			return err
		}
	}
	return transferResponse(record)
}

func stopTransfers(store *transferStore) error {
	guard, err := store.guard()
	if err != nil {
		return err
	}
	if err = store.recoverInterrupted(); err != nil {
		guard.Close()
		return err
	}
	records, err := store.records()
	if err != nil {
		guard.Close()
		return err
	}
	for _, record := range records {
		if activeTransfer(record.Status) {
			if err = store.requestCancel(record.ID); err != nil {
				guard.Close()
				return err
			}
		}
	}
	guard.Close()
	deadline := time.Now().Add(8 * time.Second)
	for {
		guard, err = store.guard()
		if err != nil {
			return err
		}
		active, lockErr := store.activeLock()
		if lockErr == nil {
			active.Close()
			err = store.recoverInterrupted()
			guard.Close()
			if err != nil {
				return err
			}
			return json.NewEncoder(os.Stdout).Encode(map[string]bool{"ok": true})
		}
		guard.Close()
		if !lockBusy(lockErr) {
			return lockErr
		}
		if time.Now().After(deadline) {
			return errors.New("Taildrop worker has not acknowledged cancellation; do not replace or delete its files")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func runSendWorker(args []string) error {
	flags := flag.NewFlagSet("send-worker", flag.ContinueOnError)
	root := flags.String("root", "", "module root")
	id := flags.String("id", "", "transfer ID")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || !validID(*id) {
		return errors.New("invalid worker arguments")
	}
	inherited := os.NewFile(3, "active.lock")
	if inherited == nil {
		return errors.New("worker requires inherited transfer ownership")
	}
	defer inherited.Close()
	store, err := openTransferStore(*root)
	if err != nil {
		return err
	}
	defer store.Close()
	opened, err := inherited.Stat()
	entry, pathErr := store.root.Lstat("active.lock")
	if err != nil || pathErr != nil || !entry.Mode().IsRegular() || !os.SameFile(opened, entry) {
		return errors.New("invalid inherited transfer ownership")
	}
	if err = taildropLock(inherited); err != nil {
		return err
	}
	guard, err := store.guard()
	if err != nil {
		return err
	}
	record, err := store.load(*id)
	guard.Close()
	if err != nil {
		return err
	}
	if !activeTransfer(record.Status) {
		return errors.New("transfer is already final")
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer signal.Stop(signals)
	monitorDone := make(chan struct{})
	defer func() { cancel(nil); <-monitorDone }()
	go func() {
		defer close(monitorDone)
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			cancelled, err := store.cancelled(record.ID)
			if err != nil {
				cancel(err)
				return
			}
			if cancelled {
				cancel(errTransferCancelled)
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-signals:
				cancel(errTransferInterrupted)
				return
			case <-ticker.C:
			}
		}
	}()
	return executeTransfer(ctx, store, record)
}

type transferProgress struct {
	mu       sync.Mutex
	store    *transferStore
	record   *transferRecord
	current  int
	observed time.Time
	lastSave time.Time
	failure  error
	cancel   context.CancelCauseFunc
}

func (p *transferProgress) persist() error {
	p.record.UpdatedAt = time.Now().Unix()
	guard, err := p.store.guard()
	if err == nil {
		err = p.store.save(p.record)
		guard.Close()
	}
	if err != nil {
		p.failure = err
		p.cancel(fmt.Errorf("cannot persist transfer state: %w", err))
	}
	p.lastSave = time.Now()
	return err
}

func (p *transferProgress) update(event outgoingEvent) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.current < 0 || p.failure != nil {
		return
	}
	file := &p.record.Files[p.current]
	if file.Status != "sending" || event.ID != file.ID || event.PeerID != p.record.PeerID || event.DeclaredSize != file.Size {
		return
	}
	now := time.Now()
	sent := min(max(event.Sent, int64(0)), file.Size)
	if sent < file.SentBytes {
		return
	}
	if !p.observed.IsZero() {
		seconds := now.Sub(p.observed).Seconds()
		if seconds > 0 {
			file.BytesPerSecond = int64(float64(sent-file.SentBytes) / seconds)
		}
	}
	file.SentBytes, file.ProgressKnown, p.observed = sent, true, now
	if now.Sub(p.lastSave) >= 250*time.Millisecond {
		p.persist()
	}
}

func (p *transferProgress) unavailable() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.current >= 0 && p.record.Files[p.current].Status == "sending" {
		p.record.Files[p.current].ProgressKnown = false
		p.record.Files[p.current].BytesPerSecond = 0
		if p.failure == nil {
			p.persist()
		}
	}
}

func executeTransfer(parent context.Context, store *transferStore, record *transferRecord) error {
	ctx, cancel := context.WithCancelCause(parent)
	defer cancel(nil)
	progress := &transferProgress{store: store, record: record, current: -1, cancel: cancel}
	api, setupErr := newLocalAPI(record.Socket)
	if setupErr == nil {
		defer api.Close()
	}
	fatal := setupErr
	for index := range record.Files {
		if ctx.Err() != nil || fatal != nil {
			break
		}
		checkCtx, checkCancel := context.WithTimeout(ctx, 15*time.Second)
		_, _, err := api.validatePeer(checkCtx, record.PeerID, record.PeerIP, record.SelfID)
		checkCancel()
		if err != nil {
			fatal = err
			break
		}
		file := &record.Files[index]
		opened, err := openSendSource(store.path, record.Source, file.Path)
		if err == nil && identity(opened.before) != record.Identities[index] {
			opened.Close()
			opened = nil
			err = errors.New("selected source changed before upload; choose it again")
		}
		if err != nil {
			file.Status, file.Error = "failed", err.Error()
			if err = progress.persist(); err != nil {
				break
			}
			continue
		}
		progress.mu.Lock()
		progress.current, progress.observed = index, time.Time{}
		record.Status, file.Status = "sending", "sending"
		err = progress.persist()
		uploadFile := *file
		progress.mu.Unlock()
		if err != nil {
			opened.Close()
			break
		}
		fileCtx, fileCancel := context.WithTimeout(ctx, 30*time.Minute)
		stopWatch, watchErr := api.watch(fileCtx, progress.update, progress.unavailable)
		if watchErr != nil {
			progress.unavailable()
		}
		err = api.upload(fileCtx, record.PeerID, uploadFile, opened.file)
		if stopWatch != nil {
			stopWatch()
		}
		fileCancel()
		if err == nil {
			err = opened.unchanged()
		}
		opened.Close()
		progress.mu.Lock()
		file.BytesPerSecond = 0
		if err == nil {
			file.Status, file.SentBytes, file.ProgressKnown = "completed", file.Size, true
		} else if ctx.Err() != nil {
			file.Status, file.Error = "failed", context.Cause(ctx).Error()
			if errors.Is(context.Cause(ctx), errTransferCancelled) {
				file.Status = "cancelled"
			}
		} else {
			file.Status, file.Error = "failed", err.Error()
		}
		progress.current = -1
		saveErr := progress.persist()
		progress.mu.Unlock()
		if err == nil && saveErr == nil {
			if _, _, staged := stagedParts(store.path, file.Path); staged {
				guard, lockErr := store.guard()
				if lockErr != nil {
					fatal = lockErr
					break
				}
				removeErr := removeStaged(store.path, file.Path)
				guard.Close()
				if removeErr != nil {
					fatal = fmt.Errorf("file sent but private stage cleanup failed: %w", removeErr)
					break
				}
			}
		}
		if saveErr != nil {
			break
		}
	}
	progress.mu.Lock()
	defer progress.mu.Unlock()
	record.Status, record.Error = "completed", ""
	if cause := context.Cause(ctx); cause != nil {
		if errors.Is(cause, errTransferCancelled) {
			record.Status = "cancelled"
		} else if errors.Is(cause, errTransferInterrupted) {
			record.Status = "interrupted"
		} else {
			record.Status = "failed"
		}
		record.Error = cause.Error()
	} else if fatal != nil {
		record.Status, record.Error = "failed", fatal.Error()
	}
	for i := range record.Files {
		file := &record.Files[i]
		if activeTransfer(file.Status) {
			file.Status = "failed"
			if record.Status == "cancelled" {
				file.Status = "cancelled"
			}
			file.Error = record.Error
			if file.Error == "" {
				file.Error = "Transfer stopped before this file completed"
			}
		}
		file.BytesPerSecond = 0
		if file.Status != "completed" && record.Status == "completed" {
			record.Status, record.Error = "failed", "One or more files failed; retry only unfinished files"
		}
	}
	if progress.failure != nil {
		record.Status, record.Error = "failed", progress.failure.Error()
	}
	if err := progress.persist(); err != nil {
		return err
	}
	guard, err := store.guard()
	if err != nil {
		return err
	}
	defer guard.Close()
	if err = store.root.Remove(record.ID + ".cancel"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return store.maintain()
}

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Per-call receive caps keep attacker-controlled drops from exhausting the
// private volume. They are variables only so tests can exercise small files.
var (
	maxReceiveSize  int64 = 2 << 30
	maxReceiveBytes int64 = 4 << 30
)

const maxTaildropIssues = 256

var errReceiveTooLarge = errors.New("file exceeds the 2 GiB receive limit")

type taildropIssue struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

type taildropResult struct {
	OK           bool            `json:"ok"`
	Received     int             `json:"received"`
	Files        []string        `json:"files"`
	Ignored      int             `json:"ignored,omitempty"`
	Skipped      []taildropIssue `json:"skipped,omitempty"`
	SkippedCount int             `json:"skippedCount,omitempty"`
	Failed       []taildropIssue `json:"failed,omitempty"`
	FailedCount  int             `json:"failedCount,omitempty"`
	Warnings     []string        `json:"warnings,omitempty"`
}

func (result *taildropResult) skip(name, reason string) {
	result.SkippedCount++
	if len(result.Skipped) < maxTaildropIssues {
		result.Skipped = append(result.Skipped, taildropIssue{name, reason})
	}
}

func (result *taildropResult) fail(name, reason string) {
	result.FailedCount++
	if len(result.Failed) < maxTaildropIssues {
		result.Failed = append(result.Failed, taildropIssue{name, reason})
	}
}

func (result *taildropResult) warn(message string) {
	if len(result.Warnings) < maxTaildropIssues {
		result.Warnings = append(result.Warnings, message)
	}
}

func runTaildrop(args []string) error {
	flags := flag.NewFlagSet("receive", flag.ContinueOnError)
	source := flags.String("source", "", "shared storage root")
	destination := flags.String("destination", "", "private inbox")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || !filepath.IsAbs(*source) || filepath.Clean(*source) != *source || !filepath.IsAbs(*destination) || filepath.Clean(*destination) != *destination {
		return errors.New("receive requires absolute clean source and destination directories")
	}
	result, err := importTaildrop(*source, *destination)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

// The shared storage root is trusted; every path below it is untrusted.
// Root confinement and no-follow leaf opens prevent shared-storage symlinks
// from turning this root helper into a private-file reader.
func importTaildrop(source, destination string) (taildropResult, error) {
	result := taildropResult{OK: true, Files: []string{}}
	shared, err := os.OpenRoot(source)
	if err != nil {
		return result, fmt.Errorf("Taildrop shared storage unavailable: %w", err)
	}
	defer shared.Close()
	download, err := openChildRoot(shared, "Download")
	if err != nil {
		return result, fmt.Errorf("Taildrop Download directory unavailable: %w", err)
	}
	defer download.Close()
	incoming, err := openChildRoot(download, "Taildrop")
	if err != nil {
		return result, fmt.Errorf("Taildrop incoming directory unavailable: %w", err)
	}
	defer incoming.Close()
	if err = os.MkdirAll(destination, 0700); err != nil {
		return result, err
	}
	info, err := os.Lstat(destination)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return result, errors.New("private inbox must be a real directory")
	}
	inbox, err := openRealRoot(destination)
	if err != nil {
		return result, err
	}
	defer inbox.Close()
	if err = inbox.Mkdir(".taildrop", 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return result, err
	}
	info, err = inbox.Lstat(".taildrop")
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return result, errors.New("invalid private Taildrop receipt directory")
	}
	receipts, err := openChildRoot(inbox, ".taildrop")
	if err != nil {
		return result, err
	}
	defer receipts.Close()
	lock, err := receipts.OpenFile("lock", taildropReadWriteFlags(), 0600)
	if err != nil {
		return result, err
	}
	defer lock.Close()
	lockInfo, err := lock.Stat()
	if err != nil || !lockInfo.Mode().IsRegular() {
		return result, errors.New("invalid Taildrop lock file")
	}
	if err = taildropLock(lock); err != nil {
		if lockBusy(err) {
			return result, errors.New("another Taildrop receive is already in progress")
		}
		return result, err
	}
	// The private inbox cap mirrors listInbox: only names it could return
	// consume capacity, and existing entries count before any new import.
	slots := maxInboxFiles
	existing, err := inboxFileCount(inbox)
	if err != nil {
		return result, err
	}
	slots -= existing
	var importedBytes int64
	directory, err := incoming.Open(".")
	if err != nil {
		return result, err
	}
	defer directory.Close()
	for {
		entries, readErr := directory.ReadDir(128)
		for _, entry := range entries {
			name := entry.Name()
			if !entry.Type().IsRegular() || strings.HasSuffix(name, ".partial") || strings.HasSuffix(name, ".deleted") {
				continue
			}
			if !taildropCompletedName(name) {
				result.Ignored++
				continue
			}
			if slots <= 0 {
				result.skip(name, "private inbox is full")
				continue
			}
			if importedBytes >= maxReceiveBytes {
				result.skip(name, "per-call receive byte limit reached")
				continue
			}
			published, before, err := importTaildropFile(incoming, inbox, receipts, name)
			if err != nil {
				// One unreadable or mutating drop never blocks the rest.
				if errors.Is(err, errReceiveTooLarge) {
					result.skip(name, err.Error())
				} else {
					result.fail(name, err.Error())
				}
				continue
			}
			if published != "" {
				result.Files = append(result.Files, published)
				result.Received++
				importedBytes += before.Size()
				slots--
			}
			// The receipt, not the shared copy, is the dedupe record: once
			// publication is durable the source only costs shared space.
			if err := removeTaildropSource(incoming, name, before); err != nil {
				result.warn(fmt.Sprintf("imported %q but could not remove the shared source: %v", name, err))
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return result, readErr
		}
	}
	return result, nil
}

// Only names the inbox listing could return consume its capacity; reserved
// and invalid entries are skipped exactly as appendEntry treats them.
func inboxFileCount(inbox *os.Root) (int, error) {
	directory, err := inbox.Open(".")
	if err != nil {
		return 0, err
	}
	defer directory.Close()
	count := 0
	for {
		entries, readErr := directory.ReadDir(128)
		for _, entry := range entries {
			name := entry.Name()
			if name == ".taildrop" || name == ".outgoing" || !entry.Type().IsRegular() || !plainName(name) {
				continue
			}
			count++
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return 0, readErr
		}
	}
	return count, nil
}

// A replaced or changed copy is somebody else's new drop; only the exact file
// whose receipt became durable may be removed, and removal never fails a call.
func removeTaildropSource(incoming *os.Root, name string, before os.FileInfo) error {
	current, err := incoming.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !current.Mode().IsRegular() || !os.SameFile(before, current) || current.Size() != before.Size() || !current.ModTime().Equal(before.ModTime()) {
		return nil
	}
	return incoming.Remove(name)
}

func taildropCompletedName(name string) bool {
	return plainName(name) && name != ".taildrop" && name != ".outgoing" &&
		!strings.HasSuffix(name, ".partial") && !strings.HasSuffix(name, ".deleted")
}

func importTaildropFile(incoming, inbox, receipts *os.Root, name string) (string, os.FileInfo, error) {
	if !taildropCompletedName(name) {
		return "", nil, errors.New("invalid completed filename")
	}
	input, err := incoming.OpenFile(name, taildropReadFlags(), 0)
	if err != nil {
		return "", nil, err
	}
	defer input.Close()
	before, err := input.Stat()
	if err != nil {
		return "", nil, err
	}
	if !before.Mode().IsRegular() {
		return "", nil, errors.New("not a completed regular file")
	}
	if before.Size() < 0 || before.Size() > maxReceiveSize {
		return "", nil, errReceiveTooLarge
	}
	// A fixed stage is safe under the private inbox lock and is never listed.
	stage := "stage"
	if err = receipts.Remove(stage); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", nil, err
	}
	output, err := receipts.OpenFile(stage, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", nil, err
	}
	defer receipts.Remove(stage)
	hash := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(output, hash), input)
	if copyErr == nil {
		copyErr = output.Sync()
	}
	closeErr := output.Close()
	if copyErr != nil {
		return "", nil, copyErr
	}
	if closeErr != nil {
		return "", nil, closeErr
	}
	after, err := input.Stat()
	if err != nil {
		return "", nil, err
	}
	current, pathErr := incoming.Lstat(name)
	if pathErr != nil || !os.SameFile(before, current) || n != before.Size() || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return "", nil, errors.New("shared file changed while importing; retry after transfer completes")
	}
	sum := hash.Sum(nil)
	receiptHash := sha256.New()
	receiptHash.Write([]byte(name))
	receiptHash.Write([]byte{0})
	receiptHash.Write(sum)
	receipt := hex.EncodeToString(receiptHash.Sum(nil))
	if info, statErr := receipts.Lstat(receipt); statErr == nil {
		if !info.Mode().IsRegular() {
			return "", nil, errors.New("invalid Taildrop receipt")
		}
		return "", before, nil
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return "", nil, statErr
	}
	for index := 0; index < 10000; index++ {
		candidate := name
		if index > 0 {
			ext := filepath.Ext(name)
			candidate = fmt.Sprintf("%s-%d%s", strings.TrimSuffix(name, ext), index, ext)
		}
		created := false
		if err = inbox.Link(".taildrop/"+stage, candidate); err == nil {
			created = true
		} else if errors.Is(err, os.ErrExist) {
			// Also repairs a crash between publication and recording the receipt.
			existing, openErr := inbox.OpenFile(candidate, taildropReadFlags(), 0)
			if openErr != nil {
				continue
			}
			info, statErr := existing.Stat()
			same := false
			if statErr == nil && info.Mode().IsRegular() && info.Size() == n {
				h := sha256.New()
				_, readErr := io.Copy(h, existing)
				same = readErr == nil && string(h.Sum(nil)) == string(sum)
			}
			existing.Close()
			if !same {
				continue
			}
		} else {
			return "", nil, err
		}
		if err = syncRoot(inbox); err != nil {
			return "", nil, err
		}
		r, err := receipts.OpenFile(receipt, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return "", nil, err
		}
		err = r.Sync()
		closeErr := r.Close()
		if err != nil {
			return "", nil, err
		}
		if closeErr != nil {
			return "", nil, closeErr
		}
		if err = syncRoot(receipts); err != nil {
			return "", nil, err
		}
		if created {
			return candidate, before, nil
		}
		return "", before, nil
	}
	return "", nil, errors.New("cannot create an unused private inbox filename")
}

func syncRoot(root *os.Root) error {
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

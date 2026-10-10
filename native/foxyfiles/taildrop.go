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

type taildropResult struct {
	OK       bool     `json:"ok"`
	Received int      `json:"received"`
	Files    []string `json:"files"`
	Ignored  int      `json:"ignored,omitempty"`
}

func runTaildrop(args []string) error {
	flags := flag.NewFlagSet("receive", flag.ContinueOnError)
	source := flags.String("source", "", "shared storage root")
	destination := flags.String("destination", "", "private inbox")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || !filepath.IsAbs(*source) || !filepath.IsAbs(*destination) {
		return errors.New("receive requires absolute source and destination directories")
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
		return result, err
	}
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
			published, err := importTaildropFile(incoming, inbox, receipts, name)
			if err != nil {
				return result, fmt.Errorf("import %q: %w", name, err)
			}
			if published != "" {
				result.Files = append(result.Files, published)
				result.Received++
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

func taildropCompletedName(name string) bool {
	return plainName(name) && name != ".taildrop" && name != ".outgoing" &&
		!strings.HasSuffix(name, ".partial") && !strings.HasSuffix(name, ".deleted")
}

func importTaildropFile(incoming, inbox, receipts *os.Root, name string) (string, error) {
	if !taildropCompletedName(name) {
		return "", errors.New("invalid completed filename")
	}
	input, err := incoming.OpenFile(name, taildropReadFlags(), 0)
	if err != nil {
		return "", err
	}
	defer input.Close()
	before, err := input.Stat()
	if err != nil {
		return "", err
	}
	if !before.Mode().IsRegular() {
		return "", errors.New("not a completed regular file")
	}
	// A fixed stage is safe under the private inbox lock and is never listed.
	stage := "stage"
	if err = receipts.Remove(stage); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	output, err := receipts.OpenFile(stage, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	defer receipts.Remove(stage)
	hash := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(output, hash), input)
	if copyErr == nil {
		copyErr = output.Sync()
	}
	closeErr := output.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	after, err := input.Stat()
	if err != nil {
		return "", err
	}
	current, pathErr := incoming.Lstat(name)
	if pathErr != nil || !os.SameFile(before, current) || n != before.Size() || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return "", errors.New("shared file changed while importing; retry after transfer completes")
	}
	sum := hash.Sum(nil)
	receiptHash := sha256.New()
	receiptHash.Write([]byte(name))
	receiptHash.Write([]byte{0})
	receiptHash.Write(sum)
	receipt := hex.EncodeToString(receiptHash.Sum(nil))
	if info, statErr := receipts.Lstat(receipt); statErr == nil {
		if !info.Mode().IsRegular() {
			return "", errors.New("invalid Taildrop receipt")
		}
		return "", nil
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return "", statErr
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
			return "", err
		}
		if err = syncRoot(inbox); err != nil {
			return "", err
		}
		r, err := receipts.OpenFile(receipt, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return "", err
		}
		err = r.Sync()
		closeErr := r.Close()
		if err != nil {
			return "", err
		}
		if closeErr != nil {
			return "", closeErr
		}
		if err = syncRoot(receipts); err != nil {
			return "", err
		}
		if created {
			return candidate, nil
		}
		return "", nil
	}
	return "", errors.New("cannot create an unused private inbox filename")
}

func syncRoot(root *os.Root) error {
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

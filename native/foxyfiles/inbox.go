package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

// The private inbox cap is a variable only so tests can exercise it small.
var maxInboxFiles = 10000

type inboxEntry struct {
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

type inboxResult struct {
	OK      bool         `json:"ok"`
	Files   []inboxEntry `json:"files"`
	Ignored int          `json:"ignored,omitempty"`
}

func (result *inboxResult) appendEntry(inbox *os.Root, entry os.DirEntry) error {
	name := entry.Name()
	if name == ".taildrop" || name == ".outgoing" || strings.HasSuffix(name, ".partial") || strings.HasSuffix(name, ".deleted") || !entry.Type().IsRegular() {
		return nil
	}
	info, err := inbox.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inbox metadata %q: %w", name, err)
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	if !plainName(name) {
		result.Ignored++
		return nil
	}
	if len(result.Files) == maxInboxFiles {
		return errors.New("private inbox exceeds 10000 files")
	}
	result.Files = append(result.Files, inboxEntry{name, info.Size(), info.ModTime().Unix()})
	return nil
}

// rootPath is the shared Taildrop directory itself (…/Download/Taildrop):
// receivers drop files there, so it doubles as the inbox with no import step.
func listInbox(rootPath string) (inboxResult, error) {
	result := inboxResult{Files: []inboxEntry{}}
	inbox, err := archiveSourceRoot(rootPath)
	if errors.Is(err, os.ErrNotExist) {
		// A missing inbox reports empty, but a dangling symlink must not.
		if entry, statErr := os.Lstat(rootPath); statErr == nil && entry.Mode()&os.ModeSymlink != 0 {
			return result, errors.New("inbox directory must not be a symlink")
		}
		result.OK = true
		return result, nil
	}
	if err != nil {
		return result, err
	}
	defer inbox.Close()
	dir, err := inbox.Open(".")
	if err != nil {
		return result, err
	}
	defer dir.Close()
	for {
		entries, readErr := dir.ReadDir(128)
		for _, entry := range entries {
			if err := result.appendEntry(inbox, entry); err != nil {
				return result, err
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return result, readErr
		}
	}
	sort.Slice(result.Files, func(i, j int) bool {
		a, b := result.Files[i], result.Files[j]
		if a.Mtime == b.Mtime {
			return a.Name < b.Name
		}
		return a.Mtime > b.Mtime
	})
	result.OK = true
	return result, nil
}

func runInboxList(args []string) error {
	flags := flag.NewFlagSet("inbox-list", flag.ContinueOnError)
	root := flags.String("root", "", "inbox directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected inbox-list arguments")
	}
	result, err := listInbox(*root)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Open first, then compare the directory entry: neither a symlink nor a
// replaced directory may become the authority for subsequent rooted access.
func openRealRoot(path string) (*os.Root, error) {
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	entry, err := os.Lstat(path)
	opened, statErr := root.Stat(".")
	if err != nil || statErr != nil || !entry.IsDir() || entry.Mode()&os.ModeSymlink != 0 || !os.SameFile(entry, opened) {
		root.Close()
		return nil, errors.New("directory must be a stable real directory")
	}
	return root, nil
}

func openChildRoot(parent *os.Root, name string) (*os.Root, error) {
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name {
		return nil, errors.New("expected one directory component")
	}
	root, err := parent.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	entry, err := parent.Lstat(name)
	opened, statErr := root.Stat(".")
	if err != nil || statErr != nil || !entry.IsDir() || entry.Mode()&os.ModeSymlink != 0 || !os.SameFile(entry, opened) {
		root.Close()
		return nil, errors.New("directory must not be a symlink or change during open")
	}
	return root, nil
}

// /sdcard itself is Android's trusted storage alias; all child components
// must be real directories, so swapping a shared path cannot escape it.
func archiveSourceRoot(path string) (*os.Root, error) {
	if path != "/sdcard" && !strings.HasPrefix(path, "/sdcard/") {
		return openRealRoot(path)
	}
	root, err := os.OpenRoot("/sdcard")
	if err != nil {
		return nil, err
	}
	if path == "/sdcard" {
		return root, nil
	}
	for _, component := range strings.Split(strings.TrimPrefix(path, "/sdcard/"), "/") {
		next, nextErr := openChildRoot(root, component)
		root.Close()
		if nextErr != nil {
			return nil, nextErr
		}
		root = next
	}
	return root, nil
}

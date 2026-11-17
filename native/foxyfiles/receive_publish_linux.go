//go:build linux

package main

import (
	"errors"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

// Android shared storage need not support hard links. RENAME_NOREPLACE gives
// atomic completion without overwriting a concurrently received/local file.
// Unsupported kernels/filesystems fail closed, leaving the daemon copy intact.
func publishReceive(root *os.Root, temporary, name string) error {
	var number uintptr
	switch runtime.GOARCH {
	case "amd64":
		number = 316
	case "arm":
		number = 382
	case "arm64":
		number = 276
	default:
		return errors.New("atomic no-replace receive is unsupported on this architecture")
	}
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	from, err := syscall.BytePtrFromString(temporary)
	if err != nil {
		return err
	}
	to, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall6(number, directory.Fd(), uintptr(unsafe.Pointer(from)), directory.Fd(), uintptr(unsafe.Pointer(to)), 1, 0)
	runtime.KeepAlive(from)
	runtime.KeepAlive(to)
	if errno != 0 {
		return &os.LinkError{Op: "rename-noreplace", Old: temporary, New: name, Err: errno}
	}
	return nil
}

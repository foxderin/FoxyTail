//go:build darwin

package main

import "os"

// Host test support; Android uses renameat2 rather than unsupported FUSE links.
func publishReceive(root *os.Root, temporary, name string) error {
	return root.Link(temporary, name)
}

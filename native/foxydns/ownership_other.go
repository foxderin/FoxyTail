//go:build !linux

package main

type flowJournal struct{}

func openFlowJournal(string, uint16) (*flowJournal, error) { return nil, ErrUnsupported }
func (*flowJournal) close() error                          { return nil }
func cleanupOwnedFlows(string) error                       { return ErrUnsupported }
func legacyOwnership(string, uint16, bool) error           { return ErrUnsupported }

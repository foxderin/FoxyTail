//go:build !linux

package main

import "net/netip"

type Selector struct{}

func NewSelector(uint16, *recordStore) (*Selector, error) { return nil, ErrUnsupported }
func (*Selector) Close() error                            { return nil }
func (*Selector) Health() error                           { return ErrUnsupported }
func (*Selector) Stats() (uint64, uint64, uint64)         { return 0, 0, 0 }

func injectUDP(netip.AddrPort, netip.AddrPort, []byte) error { return ErrUnsupported }
func ProbeHijackCapabilities(uint16) error                   { return ErrUnsupported }

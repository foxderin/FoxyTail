package main

import (
	"path/filepath"
	"testing"
)

// Run on the same filesystem and toolchain when comparing changes. This
// measures the complete health-snapshot write, not device power consumption.
func BenchmarkServiceHealthSnapshot(b *testing.B) {
	s := &service{
		cfg:      Config{Mode: "local", IPv6: true, StateFile: filepath.Join(b.TempDir(), "state.json")},
		port:     1053,
		resolver: &resolver{},
	}
	s.resolver.local.Store(100)
	s.resolver.forwarded.Store(20)
	s.resolver.failed.Store(2)
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if err := s.writeState(true); err != nil {
			b.Fatal(err)
		}
	}
}

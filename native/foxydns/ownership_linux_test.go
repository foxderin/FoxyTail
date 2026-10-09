//go:build linux

package main

import (
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"testing"

	"github.com/florianl/go-nfqueue/v2"
	"github.com/ti-mo/conntrack"
	"golang.org/x/sys/unix"
)

func ownedFixture() (ownedFlow, conntrack.Flow) {
	owned := ownedFlow{netip.MustParseAddrPort("192.0.2.1:42000"), netip.MustParseAddrPort("192.0.2.53:53"), 17, 123}
	flow := conntrack.Flow{ID: 123, Status: conntrack.Status(1 << 5),
		TupleOrig:  conntrack.Tuple{IP: conntrack.IPTuple{SourceAddress: owned.Source.Addr(), DestinationAddress: owned.Destination.Addr()}, Proto: conntrack.ProtoTuple{Protocol: 17, SourcePort: 42000, DestinationPort: 53}},
		TupleReply: conntrack.Tuple{IP: conntrack.IPTuple{SourceAddress: netip.MustParseAddr("127.0.0.1"), DestinationAddress: owned.Source.Addr()}, Proto: conntrack.ProtoTuple{Protocol: 17, SourcePort: 1053, DestinationPort: 42000}}}
	return owned, flow
}

func TestCleanupOnlyExactOwnedDNAT(t *testing.T) {
	owned, flow := ownedFixture()
	for _, test := range []struct {
		name   string
		edit   func(*conntrack.Flow)
		remove bool
	}{
		{"owned", func(*conntrack.Flow) {}, true},
		{"reused-source", func(f *conntrack.Flow) { f.ID++ }, false},
		{"foreign-zone", func(f *conntrack.Flow) { f.Zone = 1 }, false},
		{"reply-zone", func(f *conntrack.Flow) { f.TupleReply.Zone = 1 }, false},
		{"other-port", func(f *conntrack.Flow) { f.TupleReply.Proto.SourcePort++ }, false},
		{"other-destination", func(f *conntrack.Flow) { f.TupleOrig.IP.DestinationAddress = netip.MustParseAddr("192.0.2.54") }, false},
		{"not-dnat", func(f *conntrack.Flow) { f.Status = 0 }, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			candidate := flow
			test.edit(&candidate)
			removed := false
			err := cleanupJournalFlows(ownershipHeader{Port: 1053}, []ownedFlow{owned}, func(flowTuple) (*conntrack.Flow, error) { return &candidate, nil }, func(*conntrack.Flow) error { removed = true; return nil })
			if err != nil || removed != test.remove {
				t.Fatalf("removed=%v err=%v", removed, err)
			}
		})
	}
}

func TestJournalPersistsBeforeVerdictAndRetainsFailure(t *testing.T) {
	i, attr, tuple := observation(t)
	path := filepath.Join(t.TempDir(), "flows")
	journal, err := openFlowJournal(path, 1053)
	if err != nil {
		t.Fatal(err)
	}
	i.ownership = journal
	_, _, changed := i.captureDecision(attr)
	if !changed {
		t.Fatal("valid capture was not accepted")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 || !journal.contains(tuple, 1234) {
		t.Fatal("verdict preceded ownership")
	}
	journal.close()
	attr.Ct = ptr(capturedCT(t, tuple, 999))
	verdict, _, changed := i.captureDecision(attr)
	if verdict != nfqueue.NfDrop || changed || i.Health() == nil {
		t.Fatal("closed journal accepted unowned DNAT")
	}
	owned, flow := ownedFixture()
	err = cleanupJournalFlows(ownershipHeader{Port: 1053}, []ownedFlow{owned}, func(flowTuple) (*conntrack.Flow, error) { return &flow, nil }, func(*conntrack.Flow) error { return unix.EPERM })
	if !errors.Is(err, unix.EPERM) {
		t.Fatal("cleanup failure disappeared")
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(data) {
		t.Fatal("cleanup failure discarded ownership")
	}
	if _, err = openFlowJournal(path, 1054); err == nil {
		t.Fatal("new listener discarded pending old ownership")
	}
}

func TestLegacyClaimNeverDeletesUnmarkedOrForeignFlows(t *testing.T) {
	_, flow := ownedFixture()
	deleted := 0
	remove := func(*conntrack.Flow) error { deleted++; return nil }
	if err := legacyFlows([]conntrack.Flow{flow}, 1053, false, true, remove); err == nil || deleted != 0 {
		t.Fatal("unmarked upgrade flow must drain")
	}
	flow.Mark = legacyConnmark | 0x1234
	if err := legacyFlows([]conntrack.Flow{flow}, 1053, false, true, remove); err == nil || deleted != 0 {
		t.Fatal("unclaimed bit became ownership")
	}
	foreign := flow
	foreign.Mark = 0
	foreign.TupleReply.Proto.SourcePort = 8053
	if err := legacyFlows([]conntrack.Flow{flow, foreign}, 1053, true, true, remove); err != nil || deleted != 1 {
		t.Fatalf("selective legacy cleanup failed: %d %v", deleted, err)
	}
	if legacyClaimValid(ownershipHeader{"old", 1053}, "new", 1053) || legacyClaimValid(ownershipHeader{"boot", 1053}, "boot", 1054) {
		t.Fatal("claim survived boot or port change")
	}
}

func TestMalformedCleanupRetainsDurableJournal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "flows")
	data := []byte("{\"boot\":\"incomplete")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := cleanupOwnedFlows(path); err == nil {
		t.Fatal("malformed journal was silently retired")
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(data) {
		t.Fatal("failed cleanup discarded recoverable journal")
	}
}

func TestLegacyCleanupFailurePropagatesWithoutDeletingOtherFlow(t *testing.T) {
	_, flow := ownedFixture()
	flow.Mark = legacyConnmark
	unrelated := flow
	unrelated.Mark = 0
	unrelated.TupleOrig.Proto.DestinationPort = 443
	calls := 0
	err := legacyFlows([]conntrack.Flow{flow, unrelated}, 1053, true, true, func(f *conntrack.Flow) error {
		calls++
		if f.TupleOrig.Proto.DestinationPort != 53 {
			t.Fatal("foreign flow deleted")
		}
		return unix.EPERM
	})
	if !errors.Is(err, unix.EPERM) || calls != 1 {
		t.Fatalf("lost cleanup failure: calls=%d err=%v", calls, err)
	}
}

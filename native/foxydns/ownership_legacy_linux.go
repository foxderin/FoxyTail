//go:build linux

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/ti-mo/conntrack"
	"golang.org/x/sys/unix"
)

const legacyConnmark uint32 = 0x20000000

func legacyEndpoint(flow *conntrack.Flow, port uint16) bool {
	original := fromCTTuple(flow.TupleOrig)
	return ownedDNAT(flow, ownedFlow{original.source, original.destination, original.protocol, flow.ID}, port)
}

func legacyClaimValid(header ownershipHeader, boot string, port uint16) bool {
	return header.Boot == boot && header.Port == port
}

func legacyFlows(flows []conntrack.Flow, port uint16, claimed, cleanup bool, remove func(*conntrack.Flow) error) error {
	pending := false
	for idx := range flows {
		// Missing identity still proves a drain dependency, never delete authority.
		if flows[idx].ID == 0 && flows[idx].Status.DstNAT() &&
			flows[idx].TupleOrig.Proto.DestinationPort == 53 && flows[idx].TupleReply.Proto.SourcePort == port {
			return errors.New("reconnect-needed: DNS conntrack identity unavailable")
		}
		flow := &flows[idx]
		marked := flow.Mark&legacyConnmark != 0
		exact := legacyEndpoint(flow, port)
		if marked && (!claimed || !exact) {
			return errors.New("legacy connmark is foreign or ambiguous; ownership retained")
		}
		if exact && !marked {
			pending = true
			continue
		}
	}
	if pending {
		return errors.New("reconnect-needed: unowned old DNS connections must expire before listener retirement")
	}
	if cleanup {
		deadline := time.Now().Add(8 * time.Second)
		for idx := range flows {
			if time.Now().After(deadline) {
				return errors.New("legacy cleanup deadline reached; claim retained")
			}
			flow := &flows[idx]
			if claimed && flow.Mark&legacyConnmark != 0 && legacyEndpoint(flow, port) {
				if err := remove(flow); err != nil && !errors.Is(err, unix.ENOENT) {
					return err
				}
			}
		}
	}
	return nil
}

func legacyOwnership(path string, port uint16, cleanup bool) error {
	if port == 0 {
		return errors.New("legacy ownership requires the old listener port")
	}
	f, err := lockOwnership(path, true)
	if err != nil {
		return err
	}
	defer f.Close()
	boot, err := ownershipBoot()
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		return err
	}
	claimed := false
	if st.Size() != 0 {
		header, flows, err := readFlowJournal(f)
		if err != nil || len(flows) != 0 {
			return errors.New("invalid legacy claim")
		}
		if header.Boot == boot && header.Port != port {
			return errors.New("old legacy listener requires cleanup")
		}
		claimed = legacyClaimValid(header, boot, port)
	}
	ct, err := conntrack.Dial(nil)
	if err != nil {
		return err
	}
	defer ct.Close()
	timer := time.AfterFunc(8*time.Second, func() { ct.Close() })
	defer timer.Stop()
	flows, err := ct.Dump(nil)
	if err != nil {
		return err
	}
	var remove func(*conntrack.Flow) error
	if cleanup {
		lookup, err := newCleanupLookup()
		if err != nil {
			return err
		}
		defer lookup.ct.Close()
		remove = func(flow *conntrack.Flow) error { return deleteOwnedConntrack(lookup.ct, flow) }
	}
	if err = legacyFlows(flows, port, claimed, cleanup, remove); err != nil {
		return fmt.Errorf("legacy DNS ownership: %w", err)
	}
	if cleanup || !claimed {
		if err = f.Truncate(0); err != nil {
			return err
		}
		if _, err = f.Seek(0, 0); err != nil {
			return err
		}
		if !cleanup {
			if err = json.NewEncoder(f).Encode(ownershipHeader{boot, port}); err != nil {
				return err
			}
		}
		if err = f.Sync(); err != nil {
			return err
		}
		return syncOwnershipDirectory(path)
	}
	return nil
}

func syncOwnershipDirectory(path string) error {
	// The journal's directory entry must survive power loss before capture.
	f, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

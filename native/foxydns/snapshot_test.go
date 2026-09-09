package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testSnapshot struct {
	Generation int    `json:"generation"`
	Payload    string `json:"payload"`
}

func snapshotPayload(generation int) string {
	return strings.Repeat(fmt.Sprintf("%04d", generation), 8192)
}

func TestSnapshotPublicationIsAtomicAndPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte("old public state"), 0644); err != nil {
		t.Fatal(err)
	}
	old, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = writeSnapshotJSON(path, testSnapshot{Payload: snapshotPayload(0)}); err != nil {
		t.Fatal(err)
	}
	current, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(old, current) || current.Mode().Perm() != 0600 {
		t.Fatalf("snapshot did not privately replace the old file: %v", current.Mode())
	}

	// Read throughout repeated replacement. A reader must see a whole old or
	// new generation, with no missing file or partially published JSON.
	started, stop := make(chan struct{}), make(chan struct{})
	result := make(chan error, 1)
	go func() {
		first := true
		for {
			data, err := os.ReadFile(path)
			var state testSnapshot
			if err == nil {
				err = json.Unmarshal(data, &state)
			}
			if err == nil && state.Payload != snapshotPayload(state.Generation) {
				err = fmt.Errorf("incomplete generation %d", state.Generation)
			}
			if first {
				close(started)
				first = false
			}
			if err != nil {
				result <- err
				return
			}
			select {
			case <-stop:
				result <- nil
				return
			default:
			}
		}
	}()
	defer func() {
		close(stop)
		if err := <-result; err != nil {
			t.Error(err)
		}
	}()
	<-started
	for generation := 1; generation <= 64; generation++ {
		if err = writeSnapshotJSON(path, testSnapshot{generation, snapshotPayload(generation)}); err != nil {
			t.Fatal(err)
		}
	}
	assertNoSnapshotTemps(t, filepath.Dir(path))
}

func assertNoSnapshotTemps(t *testing.T, dir string) {
	t.Helper()
	temps, err := filepath.Glob(filepath.Join(dir, ".foxydns-state-*"))
	if err != nil || len(temps) != 0 {
		t.Fatalf("temporary snapshots remain: %v (error: %v)", temps, err)
	}
}

func TestSnapshotWriteFailuresLeavePublishedStateIntact(t *testing.T) {
	t.Run("encode failure", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "state.json")
		const previous = "previous snapshot\n"
		if err := os.WriteFile(path, []byte(previous), 0600); err != nil {
			t.Fatal(err)
		}
		if err := writeSnapshotJSON(path, make(chan struct{})); err == nil {
			t.Fatal("unsupported JSON value was accepted")
		}
		data, err := os.ReadFile(path)
		if err != nil || string(data) != previous {
			t.Fatalf("failed encoding changed published state: %q, %v", data, err)
		}
		assertNoSnapshotTemps(t, filepath.Dir(path))
	})
	t.Run("missing parent", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "removed", "state.json")
		if err := writeSnapshotJSON(path, map[string]bool{"ready": true}); !os.IsNotExist(err) {
			t.Fatalf("missing parent not reported: %v", err)
		}
	})
	t.Run("replacement failure", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "state.json")
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err := writeSnapshotJSON(path, map[string]bool{"ready": true}); err == nil {
			t.Fatal("replacing a directory reported success")
		}
		stat, err := os.Stat(path)
		if err != nil || !stat.IsDir() {
			t.Fatalf("failed replacement changed destination: %v", err)
		}
		assertNoSnapshotTemps(t, dir)
	})
}

func TestServiceRejectsFailedInitialSnapshotAndClosesListeners(t *testing.T) {
	cfg := contextFixture(t)
	reserved, err := net.Listen("tcp4", cfg.Listen)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Listen = reserved.Addr().String()
	if err = reserved.Close(); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(cfg.StateFile, 0700); err != nil {
		t.Fatal(err)
	}
	if s, err := startService(cfg); err == nil {
		s.Close()
		t.Fatal("listener became ready without publishing its initial snapshot")
	}
	assertNoSnapshotTemps(t, filepath.Dir(cfg.StateFile))
	if err = os.Remove(cfg.StateFile); err != nil {
		t.Fatal(err)
	}
	s, err := startService(cfg)
	if err != nil {
		t.Fatalf("startup failure leaked listeners: %v", err)
	}
	s.Close()
}

func TestServiceHeartbeatPublishesCountersAndReportsWriteFailure(t *testing.T) {
	cfg := contextFixture(t)
	s, err := startService(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.resolver.local.Store(7)
	before := time.Now().Unix()
	deadline := time.NewTimer(4 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(20 * time.Millisecond)
	defer poll.Stop()
	for {
		select {
		case <-deadline.C:
			t.Fatal("two-second heartbeat did not publish current counters")
		case <-poll.C:
			var state struct {
				Ready        bool  `json:"ready"`
				LocalAnswers int   `json:"localAnswers"`
				UpdatedAt    int64 `json:"updatedAt"`
			}
			data, err := os.ReadFile(cfg.StateFile)
			if err != nil {
				t.Fatal(err)
			}
			if err = json.Unmarshal(data, &state); err != nil {
				t.Fatal(err)
			}
			if state.LocalAnswers != 7 {
				continue
			}
			if !state.Ready || state.UpdatedAt < before || state.UpdatedAt > time.Now().Unix() {
				t.Fatalf("invalid heartbeat: %s", data)
			}
		}
		break
	}

	// Simulate the runtime directory becoming unwritable at publication time.
	// The running service must notify main's existing failure/exit path.
	if err = os.Remove(cfg.StateFile); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(cfg.StateFile, 0700); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-s.errors:
		if err == nil {
			t.Fatal("heartbeat failure sent no error")
		}
	case <-time.After(4 * time.Second):
		t.Fatal("heartbeat write failure did not reach the service error channel")
	}
	assertNoSnapshotTemps(t, filepath.Dir(cfg.StateFile))
	if err = os.Remove(cfg.StateFile); err != nil {
		t.Fatal(err)
	}
	s.Close()
	data, err := os.ReadFile(cfg.StateFile)
	if err != nil {
		t.Fatal(err)
	}
	var stopped struct {
		Ready      bool `json:"ready"`
		QueueReady bool `json:"queueReady"`
	}
	if err = json.Unmarshal(data, &stopped); err != nil || stopped.Ready || stopped.QueueReady {
		t.Fatalf("shutdown left a ready snapshot: %s, %v", data, err)
	}
}

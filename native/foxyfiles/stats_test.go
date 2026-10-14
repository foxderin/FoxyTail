package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
)

func orderedStats(ctx context.Context, input io.Reader, output io.Writer, temp string) error {
	return visitOrderedStats(ctx, input, temp, func(body []byte) error {
		if _, err := output.Write(body); err != nil {
			return err
		}
		_, err := output.Write([]byte{'\n'})
		return err
	})
}

func TestStatsOrderingAcrossChunksAndClockChanges(t *testing.T) {
	var input bytes.Buffer
	for i := range 7000 {
		fmt.Fprintf(&input, "{\"ts\":%d,\"id\":%d,\"padding\":%q}\n", 9-i%10, i, strings.Repeat("x", 320))
	}
	input.WriteString("not-json\nnull\n{\"ts\":null}\n{\"ts\":0,\"error\":\"unreachable\"}\n")
	var output bytes.Buffer
	directory := t.TempDir()
	if err := orderedStats(context.Background(), &input, &output, directory); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&output)
	previousTimestamp, previousID := -1, -1
	for range 7000 {
		var row struct {
			Timestamp int `json:"ts"`
			ID        int `json:"id"`
		}
		if err := decoder.Decode(&row); err != nil {
			t.Fatal(err)
		}
		if row.Timestamp < previousTimestamp || (row.Timestamp == previousTimestamp && row.ID <= previousID) {
			t.Fatalf("unstable chronological ordering: (%d,%d) after (%d,%d)", row.Timestamp, row.ID, previousTimestamp, previousID)
		}
		previousTimestamp, previousID = row.Timestamp, row.ID
	}
	if decoder.More() {
		t.Fatal("malformed/error records became samples")
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("ordering leaked temporary data: %v %v", entries, err)
	}
}

func TestStatsOrderingRejectsOversizedRowsWithoutOutput(t *testing.T) {
	var output bytes.Buffer
	directory := t.TempDir()
	input := "{\"ts\":0}\n" + strings.Repeat("x", statsMaxRowBytes+1)
	if err := orderedStats(context.Background(), strings.NewReader(input), &output, directory); err == nil {
		t.Fatal("oversized row accepted")
	}
	if output.Len() != 0 {
		t.Fatal("failed ordering emitted partial history")
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed ordering leaked temporary data: %v %v", entries, err)
	}
}

func TestStatsOrderingHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	directory := t.TempDir()
	var output bytes.Buffer
	err := orderedStats(ctx, strings.NewReader("{\"ts\":0}\n"), &output, directory)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("cancelled ordering leaked temporary data: %v %v", entries, err)
	}
}

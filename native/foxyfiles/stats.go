package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
)

const statsChunkBytes = 1 << 20
const statsMaxRowBytes = 512 << 10

type statsRow struct {
	timestamp float64
	body      []byte
}

func writeStatsRow(w io.Writer, row statsRow) error {
	var header [12]byte
	binary.LittleEndian.PutUint64(header[:8], math.Float64bits(row.timestamp))
	binary.LittleEndian.PutUint32(header[8:], uint32(len(row.body)))
	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	_, err := w.Write(row.body)
	return err
}

func readStatsRow(r io.Reader, row *statsRow) error {
	var header [12]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return err
	}
	length := int(binary.LittleEndian.Uint32(header[8:]))
	if length > statsMaxRowBytes {
		return errors.New("invalid sorted statistics row")
	}
	row.timestamp = math.Float64frombits(binary.LittleEndian.Uint64(header[:8]))
	if cap(row.body) < length {
		row.body = make([]byte, length)
	} else {
		row.body = row.body[:length]
	}
	_, err := io.ReadFull(r, row.body)
	return err
}

func mergeStats(ctx context.Context, left, right, destination string) (err error) {
	a, err := os.Open(left)
	if err != nil {
		return err
	}
	defer a.Close()
	b, err := os.Open(right)
	if err != nil {
		return err
	}
	defer b.Close()
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, out.Close()) }()
	readers := [2]*bufio.Reader{bufio.NewReader(a), bufio.NewReader(b)}
	var rows [2]statsRow
	results := [2]error{readStatsRow(readers[0], &rows[0]), readStatsRow(readers[1], &rows[1])}
	writer := bufio.NewWriter(out)
	for results[0] != io.EOF || results[1] != io.EOF {
		if err := ctx.Err(); err != nil {
			return err
		}
		for _, result := range results {
			if result != nil && result != io.EOF {
				return result
			}
		}
		index := 0
		if results[0] == io.EOF || (results[1] == nil && rows[1].timestamp < rows[0].timestamp) {
			index = 1
		}
		if err := writeStatsRow(writer, rows[index]); err != nil {
			return err
		}
		results[index] = readStatsRow(readers[index], &rows[index])
	}
	return writer.Flush()
}

// Preserve chronological counter semantics across clock changes without a slurp.
func visitOrderedStats(ctx context.Context, input io.Reader, temp string, visit func([]byte) error) error {
	directory, err := os.MkdirTemp(temp, ".stats-order-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	var chunks []string
	var rows []statsRow
	bytes := 0
	flush := func() error {
		if len(rows) == 0 {
			return nil
		}
		sort.SliceStable(rows, func(i, j int) bool { return rows[i].timestamp < rows[j].timestamp })
		path := fmt.Sprintf("%s/chunk-%d", directory, len(chunks))
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		writer := bufio.NewWriter(file)
		for _, row := range rows {
			if err = writeStatsRow(writer, row); err != nil {
				file.Close()
				return err
			}
		}
		err = errors.Join(writer.Flush(), file.Close())
		if err != nil {
			return err
		}
		chunks = append(chunks, path)
		clear(rows)
		rows = rows[:0]
		bytes = 0
		return nil
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64<<10), statsMaxRowBytes+1)
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		var sample struct {
			Timestamp *float64        `json:"ts"`
			Error     json.RawMessage `json:"error"`
		}
		body := scanner.Bytes()
		if err := json.Unmarshal(body, &sample); err != nil || sample.Timestamp == nil ||
			(len(sample.Error) != 0 && string(sample.Error) != "null") {
			continue
		}
		if bytes+len(body) > statsChunkBytes || len(rows) >= 16384 {
			if err := flush(); err != nil {
				return err
			}
		}
		rows = append(rows, statsRow{*sample.Timestamp, append([]byte(nil), body...)})
		bytes += len(body)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("statistics sample exceeds %d bytes or input failed: %w", statsMaxRowBytes, err)
	}
	if err := flush(); err != nil {
		return err
	}
	for pass := 0; len(chunks) > 1; pass++ {
		var next []string
		for index := 0; index < len(chunks); index += 2 {
			if index+1 == len(chunks) {
				next = append(next, chunks[index])
				continue
			}
			path := fmt.Sprintf("%s/merge-%d-%d", directory, pass, index)
			if err := mergeStats(ctx, chunks[index], chunks[index+1], path); err != nil {
				return err
			}
			if err := os.Remove(chunks[index]); err != nil {
				return err
			}
			if err := os.Remove(chunks[index+1]); err != nil {
				return err
			}
			next = append(next, path)
		}
		chunks = next
	}
	if len(chunks) == 0 {
		return nil
	}
	file, err := os.Open(chunks[0])
	if err != nil {
		return err
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	var row statsRow
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := readStatsRow(reader, &row); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		if err := visit(row.body); err != nil {
			return err
		}
	}
}

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata"
)

const statsCacheName = ".stats-summary-cache"
const statsCacheBytes = 8 << 20

type statsInput struct {
	Path     string       `json:"path"`
	Identity fileIdentity `json:"identity"`
}

type statsCacheKey struct {
	Version   int          `json:"version"`
	Date      string       `json:"date"`
	Today     string       `json:"today"`
	Timezone  string       `json:"timezone"`
	Offset    int          `json:"offset"`
	Retention string       `json:"retention"`
	Inputs    []statsInput `json:"inputs"`
}

type statsCache struct {
	Key     statsCacheKey `json:"key"`
	Summary statsSummary  `json:"summary"`
}

func sameStatsKey(a, b statsCacheKey) bool {
	if a.Version != b.Version || a.Date != b.Date || a.Today != b.Today || a.Timezone != b.Timezone || a.Offset != b.Offset || a.Retention != b.Retention || len(a.Inputs) != len(b.Inputs) {
		return false
	}
	for index := range a.Inputs {
		if a.Inputs[index] != b.Inputs[index] {
			return false
		}
	}
	return true
}

func statStatsInputs(paths []string) ([]statsInput, error) {
	inputs := make([]statsInput, 0, len(paths))
	for _, path := range paths {
		path, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() {
			return nil, errors.New("statistics input must be a regular file")
		}
		inputs = append(inputs, statsInput{path, identity(info)})
	}
	return inputs, nil
}

func statsInputsUnchanged(inputs []statsInput) bool {
	for _, input := range inputs {
		info, err := os.Lstat(input.Path)
		if err != nil || !info.Mode().IsRegular() || identity(info) != input.Identity {
			return false
		}
	}
	return true
}

type statsInputReader struct {
	ctx       context.Context
	inputs    []statsInput
	file      *os.File
	remaining int64
}

func (r *statsInputReader) Close() error {
	if r.file != nil {
		err := r.file.Close()
		r.file = nil
		return err
	}
	return nil
}

func (r *statsInputReader) Read(body []byte) (int, error) {
	for {
		if err := r.ctx.Err(); err != nil {
			return 0, err
		}
		if r.file == nil {
			if len(r.inputs) == 0 {
				return 0, io.EOF
			}
			input := r.inputs[0]
			file, err := os.OpenFile(input.Path, taildropReadFlags(), 0)
			if err != nil {
				return 0, err
			}
			info, err := file.Stat()
			if err != nil || !info.Mode().IsRegular() || identity(info) != input.Identity {
				file.Close()
				return 0, errors.New("statistics input changed before read")
			}
			r.file, r.remaining, r.inputs = file, input.Identity.Size, r.inputs[1:]
		}
		if r.remaining == 0 {
			if err := r.Close(); err != nil {
				return 0, err
			}
			continue
		}
		if int64(len(body)) > r.remaining {
			body = body[:r.remaining]
		}
		n, err := r.file.Read(body)
		r.remaining -= int64(n)
		if err == io.EOF && r.remaining > 0 {
			err = io.ErrUnexpectedEOF
		}
		return n, err
	}
}

func loadStatsCache(root *os.Root, key statsCacheKey) (statsSummary, bool) {
	file, err := root.OpenFile(statsCacheName, taildropReadFlags(), 0)
	if err != nil {
		return statsSummary{}, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > statsCacheBytes || info.Mode().Perm()&0077 != 0 {
		return statsSummary{}, false
	}
	var cache statsCache
	decoder := json.NewDecoder(io.LimitReader(file, statsCacheBytes+1))
	if decoder.Decode(&cache) != nil || !sameStatsKey(cache.Key, key) {
		return statsSummary{}, false
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF || !statsInputsUnchanged(key.Inputs) {
		return statsSummary{}, false
	}
	return cache.Summary, true
}

type statsCacheWriter struct {
	io.Writer
	remaining int
}

func (w *statsCacheWriter) Write(body []byte) (int, error) {
	if len(body) > w.remaining {
		return 0, errors.New("statistics cache exceeds size limit")
	}
	n, err := w.Writer.Write(body)
	w.remaining -= n
	return n, err
}

func saveStatsCache(ctx context.Context, root *os.Root, key statsCacheKey, result statsSummary) {
	// One fixed cache entry; failed/cancelled writes never replace a complete entry.
	name := fmt.Sprintf(".stats-cache-%d-%d", os.Getpid(), time.Now().UnixNano())
	file, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return
	}
	defer root.Remove(name)
	err = json.NewEncoder(&statsCacheWriter{file, statsCacheBytes}).Encode(statsCache{key, result})
	err = errors.Join(err, file.Close())
	if err == nil && ctx.Err() == nil && statsInputsUnchanged(key.Inputs) {
		_ = root.Rename(name, statsCacheName)
	}
}

// Killed queries leave external-merge and cache temporaries behind; sweep them
// by age like .write-* transfer leftovers. Best-effort: never fails a query.
func sweepStatsTemp(root *os.Root) {
	dir, err := root.Open(".")
	if err != nil {
		return
	}
	defer dir.Close()
	for scanned := 0; scanned < 1024; {
		entries, readErr := dir.ReadDir(256)
		scanned += len(entries)
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasPrefix(name, ".stats-order-") && !strings.HasPrefix(name, ".stats-cache-") {
				continue
			}
			info, err := root.Lstat(name)
			if err != nil || !olderThanDay(info) {
				continue
			}
			if info.IsDir() {
				root.RemoveAll(name)
			} else {
				root.Remove(name)
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			break
		}
	}
}

func statsLocation(zone string) (*time.Location, error) {
	zone = strings.TrimPrefix(zone, ":")
	if zone == "" {
		return time.Local, nil
	}
	if zone == "UTC0" || zone == "GMT0" {
		return time.UTC, nil
	}
	return time.LoadLocation(zone)
}

func queryStats(ctx context.Context, temp, date, timezone, retention string, paths []string) (statsSummary, error) {
	location, err := statsLocation(timezone)
	if err != nil {
		return statsSummary{}, err
	}
	now := time.Now().In(location)
	if date == "" {
		date = now.Format("2006-01-02")
	}
	inputs, err := statStatsInputs(paths)
	if err != nil {
		return statsSummary{}, err
	}
	_, offset := now.Zone()
	key := statsCacheKey{1, date, now.Format("2006-01-02"), timezone + "|" + location.String(), offset, retention, inputs}
	root, err := openRealRoot(temp)
	if err != nil {
		return statsSummary{}, err
	}
	defer root.Close()
	if err := ctx.Err(); err != nil {
		return statsSummary{}, err
	}
	sweepStatsTemp(root)
	if result, ok := loadStatsCache(root, key); ok {
		return result, ctx.Err()
	}
	reader := &statsInputReader{ctx: ctx, inputs: inputs}
	defer reader.Close()
	accumulator := newStatsAccumulator(date, location)
	if err := visitOrderedStats(ctx, reader, temp, accumulator.consume); err != nil {
		return statsSummary{}, err
	}
	result, err := accumulator.finish(ctx)
	if err != nil {
		return statsSummary{}, err
	}
	saveStatsCache(ctx, root, key, result)
	return result, ctx.Err()
}

func runStatsSummary(args []string) error {
	flags := flag.NewFlagSet("stats-summary", flag.ContinueOnError)
	temp := flags.String("temp", "", "private temporary/cache directory")
	date := flags.String("date", "", "local date for hourly buckets")
	mode := flags.String("mode", "summary", "summary, hourly, daily, topn or uids")
	limit := flags.String("limit", "10", "maximum ranked rows")
	retention := flags.String("retention", "", "configured retention identity")
	timezone := flags.String("timezone", os.Getenv("TZ"), "local IANA time zone")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *temp == "" {
		return errors.New("stats-summary requires --temp")
	}
	switch *mode {
	case "summary", "hourly", "daily", "topn", "uids":
	default:
		return errors.New("invalid statistics query mode")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	result, err := queryStats(ctx, *temp, *date, *timezone, *retention, flags.Args())
	if err != nil {
		return err
	}
	n, err := strconv.ParseUint(*limit, 10, 64)
	if err != nil {
		n = ^uint64(0)
	}
	var output any = result
	switch *mode {
	case "hourly":
		output = struct {
			Date        string      `json:"date"`
			Attribution string      `json:"attribution"`
			Hours       []statsHour `json:"hours"`
		}{result.Date, result.Attribution, result.Hours}
	case "daily":
		output = struct {
			Attribution string     `json:"attribution"`
			Days        []statsDay `json:"days"`
		}{result.Attribution, result.Days}
	case "topn":
		if n < uint64(len(result.TopN)) {
			result.TopN = result.TopN[:int(n)]
		}
		output = struct {
			TopN []statsPeerTotal `json:"topn"`
		}{result.TopN}
	case "uids":
		if n < uint64(len(result.UIDs)) {
			result.UIDs = result.UIDs[:int(n)]
		}
		output = struct {
			UIDs      []statsUIDTotal `json:"uids"`
			Direction string          `json:"direction"`
		}{result.UIDs, result.Direction}
	}
	return json.NewEncoder(os.Stdout).Encode(output)
}

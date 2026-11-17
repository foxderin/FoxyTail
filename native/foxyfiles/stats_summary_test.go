package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func statsTestFile(t *testing.T, directory, body string) string {
	t.Helper()
	path := filepath.Join(directory, "samples.jsonl")
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestStatsSummaryPreservesPartialRowsAndDuplicateIDs(t *testing.T) {
	directory := t.TempDir()
	path := statsTestFile(t, directory, `{"ts":0,"iface":{"rx":100},"peers":[{"id":"z","rx":100,"tx":0},{"id":"a","rx":100,"tx":0}],"uids":"ignored legacy value"}
not json
{"ts":30,"error":"offline"}
{"ts":60,"iface":{"rx":150,"tx":40},"peers":[{"id":"z","rx":130,"tx":0},{"id":"z","rx":140,"tx":0},{"id":"a","rx":170,"tx":0}],"uidDirection":"tx","uids":[{"uid":123,"tx":100}]}
{"ts":120,"iface":null,"peers":[{"id":"z","rx":150,"tx":0}],"uidDirection":"tx","uids":[{"uid":123,"tx":130}]}
{"ts":180,"iface":{"tx":70}}
{"ts":240,"iface":{"rx":300,"tx":90},"generation":{"iface":"new"}}
{"ts":300,"iface":{"rx":350,"tx":100},"generation":{"iface":"new"}}
`)
	result, err := queryStats(context.Background(), directory, "1970-01-01", "UTC", "7", []string{path})
	if err != nil {
		t.Fatal(err)
	}
	if got := result.Days; !reflect.DeepEqual(got, []statsDay{{Date: "1970-01-01", Samples: 5, statsPair: statsPair{100, 130}}}) {
		t.Fatalf("missing/reset counters lost: %+v", got)
	}
	if got := result.Hours[0].Peers; !reflect.DeepEqual(got, []statsPeerTotal{{"z", statsPair{80, 0}}, {"a", statsPair{70, 0}}}) {
		t.Fatalf("duplicate IDs or insertion order changed: %+v", got)
	}
	if !reflect.DeepEqual(result.UIDs, []statsUIDTotal{{"123", statsPair{0, 30}}}) {
		t.Fatal(result.UIDs)
	}
	for _, hour := range result.Hours[1:] {
		if hour.Samples != 0 || hour.Peers == nil || len(hour.Peers) != 0 {
			t.Fatal(hour)
		}
	}
}

func TestStatsSummaryLocalTimezoneAcrossDST(t *testing.T) {
	directory := t.TempDir()
	path := statsTestFile(t, directory, `{"ts":1730610000,"iface":{"rx":100,"tx":0}}
{"ts":1730613600,"iface":{"rx":150,"tx":0}}
{"ts":1730617200,"iface":{"rx":180,"tx":0}}
`)
	result, err := queryStats(context.Background(), directory, "2024-11-03", "America/New_York", "7", []string{path})
	if err != nil {
		t.Fatal(err)
	}
	if result.Hours[1].Samples != 2 || result.Hours[1].Iface.RX != 50 || result.Hours[2].Iface.RX != 30 {
		t.Fatalf("DST interval-end attribution changed: %+v", result.Hours[:3])
	}
}

func TestStatsSummaryCacheReuseAndInvalidation(t *testing.T) {
	directory := t.TempDir()
	path := statsTestFile(t, directory, "{\"ts\":0,\"iface\":{\"rx\":100}}\n{\"ts\":60,\"iface\":{\"rx\":200}}\n")
	query := func(date, zone, retention string, paths []string) statsSummary {
		t.Helper()
		result, err := queryStats(context.Background(), directory, date, zone, retention, paths)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	paths := []string{path}
	first := query("1970-01-01", "UTC", "7", paths)
	cachePath := filepath.Join(directory, statsCacheName)
	stamp := time.Unix(123, 456)
	if err := os.Chtimes(cachePath, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if got := query("1970-01-01", "UTC", "7", paths); !reflect.DeepEqual(got, first) {
		t.Fatal(got)
	}
	info, err := os.Stat(cachePath)
	if err != nil || !info.ModTime().Equal(stamp) {
		t.Fatalf("repeat query rewrote cache: %v %v", info, err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = file.WriteString("{\"ts\":30,\"iface\":{\"rx\":150}}\n{\"ts\":120,\"iface\":{\"rx\":300}}\n")
	if closeErr := file.Close(); err != nil || closeErr != nil {
		t.Fatal(err, closeErr)
	}
	if got := query("1970-01-01", "UTC", "7", paths); got.Days[0].RX != 200 || got.Days[0].Samples != 4 {
		t.Fatal(got.Days)
	}
	statsTestFile(t, directory, "{\"ts\":0,\"iface\":{\"rx\":100}}\n")
	if got := query("1970-01-01", "UTC", "7", paths); got.Days[0].RX != 0 || got.Days[0].Samples != 1 {
		t.Fatal(got.Days)
	}
	old, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(directory, "replacement")
	if err := os.WriteFile(replacement, []byte("{\"ts\":0,\"iface\":{\"rx\":999}}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(replacement, old.ModTime(), old.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	query("1970-01-01", "UTC", "7", paths)
	cacheBytes, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	var cache statsCache
	if err := json.Unmarshal(cacheBytes, &cache); err != nil {
		t.Fatal(err)
	}
	current, err := os.Stat(path)
	if err != nil || cache.Key.Inputs[0].Identity != identity(current) || identity(old) == identity(current) {
		t.Fatal("replacement retained stale identity", err)
	}
	statsTestFile(t, directory, "{\"ts\":1,\"iface\":{\"rx\":999}}\n")
	newTime := current.ModTime().Add(time.Nanosecond)
	if err := os.Chtimes(path, newTime, newTime); err != nil {
		t.Fatal(err)
	}
	query("1970-01-02", "Asia/Shanghai", "3", paths)
	cacheBytes, err = os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(cacheBytes, &cache); err != nil {
		t.Fatal(err)
	}
	if cache.Key.Date != "1970-01-02" || cache.Key.Retention != "3" || !strings.HasPrefix(cache.Key.Timezone, "Asia/Shanghai|") || cache.Key.Inputs[0].Identity.Modified != newTime.UnixNano() {
		t.Fatalf("date/timezone/retention/nanosecond invalidation failed: %+v", cache.Key)
	}
	if got := query("1970-01-01", "UTC", "7", nil); len(got.Days) != 0 {
		t.Fatal("pruned paths retained", got.Days)
	}
}

func TestStatsCacheNeverStoresChangingInputOrFollowsSymlinks(t *testing.T) {
	directory := t.TempDir()
	path := statsTestFile(t, directory, "{\"ts\":0}\n")
	inputs, err := statStatsInputs([]string{path})
	if err != nil {
		t.Fatal(err)
	}
	root, err := openRealRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	statsTestFile(t, directory, "{\"ts\":0}\n{\"ts\":1}\n")
	saveStatsCache(context.Background(), root, statsCacheKey{Inputs: inputs}, statsSummary{})
	if _, err := root.Stat(statsCacheName); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("changed input cached", err)
	}
	outside := filepath.Join(t.TempDir(), "untouched")
	if err := os.WriteFile(outside, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(directory, statsCacheName)); err != nil {
		t.Fatal(err)
	}
	if _, err := queryStats(context.Background(), directory, "1970-01-01", "UTC", "7", []string{path}); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(outside)
	if err != nil || string(body) != "private" {
		t.Fatal("cache followed symlink", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := queryStats(ctx, directory, "1970-01-01", "UTC", "7", []string{path}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".stats-order-") || strings.HasPrefix(entry.Name(), ".stats-cache-") {
			t.Fatal("temporary file leaked", entry.Name())
		}
	}
}

func BenchmarkStatsSummarySevenDays(b *testing.B) {
	directory := b.TempDir()
	path := filepath.Join(directory, "seven-days.jsonl")
	file, err := os.Create(path)
	if err != nil {
		b.Fatal(err)
	}
	for sample := range 10080 {
		fmt.Fprintf(file, "{\"ts\":%d,\"iface\":{\"rx\":%d,\"tx\":%d},\"peers\":[", sample*60, sample*100, sample*50)
		for peer := range 100 {
			if peer != 0 {
				fmt.Fprint(file, ",")
			}
			fmt.Fprintf(file, "{\"id\":\"p%03d\",\"rx\":%d,\"tx\":%d}", peer, sample*100, sample*50)
		}
		fmt.Fprintln(file, "]}")
	}
	if err := file.Close(); err != nil {
		b.Fatal(err)
	}
	for _, warm := range []bool{false, true} {
		name := "Cold"
		if warm {
			name = "Warm"
		}
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			if warm {
				if _, err := queryStats(context.Background(), directory, "1970-01-07", "UTC", "7", []string{path}); err != nil {
					b.Fatal(err)
				}
			}
			b.ResetTimer()
			for range b.N {
				if !warm {
					_ = os.Remove(filepath.Join(directory, statsCacheName))
				}
				result, err := queryStats(context.Background(), directory, "1970-01-07", "UTC", "7", []string{path})
				if err != nil {
					b.Fatal(err)
				}
				if len(result.TopN) != 100 || result.TopN[0].RX != 1007900 {
					b.Fatal("wrong benchmark aggregate")
				}
			}
		})
	}
}

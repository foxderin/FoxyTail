package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"testing"
)

type archiveMember struct {
	name string
	body string
	kind byte
}

func archiveBytes(t *testing.T, members []archiveMember) []byte {
	t.Helper()
	var b bytes.Buffer
	w := tar.NewWriter(&b)
	for _, member := range members {
		kind := member.kind
		if kind == 0 {
			kind = tar.TypeReg
		}
		h := &tar.Header{Name: member.name, Mode: 0777, Size: int64(len(member.body)), Typeflag: kind, Format: tar.FormatUSTAR}
		if kind == tar.TypeDir || kind == tar.TypeSymlink || kind == tar.TypeLink {
			h.Size = 0
		}
		if kind == tar.TypeSymlink || kind == tar.TypeLink {
			h.Linkname = "/tmp/escape"
		}
		if err := w.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Size != 0 {
			if _, err := io.WriteString(w, member.body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func compressArchive(t *testing.T, raw []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	if _, err := w.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func importArchive(t *testing.T, data []byte) (string, string, error) {
	t.Helper()
	root := t.TempDir()
	source := filepath.Join(root, "input.tar.gz")
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(root, "stage")
	sum, err := extract(source, dest)
	return dest, sum, err
}

func TestArchiveSupportedLayoutsAndDigest(t *testing.T) {
	for _, wrapper := range []string{"", "foxytail/", "./foxytail/"} {
		t.Run(wrapper, func(t *testing.T) {
			members := []archiveMember{
				{wrapper + "conf/", "", tar.TypeDir},
				{wrapper + "conf/foxytail.conf", "SOCKS_PORT=1234\n", 0},
				{wrapper + "conf/routes.conf", "ROUTE_SCOPE=all\n", 0},
				{wrapper + "conf/context.conf", "", 0},
				{wrapper + "foxytail.tun.up", "never-execute\n", 0},
				{wrapper + "foxytail.tun.down", "never-execute\n", 0},
			}
			data := compressArchive(t, archiveBytes(t, members))
			dest, sum, err := importArchive(t, data)
			if err != nil {
				t.Fatal(err)
			}
			expected := sha256.Sum256(data)
			if sum != hex.EncodeToString(expected[:]) {
				t.Fatal("digest differs from staged bytes")
			}
			for _, member := range members[1:] {
				name := member.name[len(wrapper):]
				path := filepath.Join(dest, "archive", name)
				body, err := os.ReadFile(path)
				if err != nil || string(body) != member.body {
					t.Fatalf("member mismatch: %s %v", name, err)
				}
				info, err := os.Stat(path)
				if err != nil || info.Mode().Perm() != 0600 {
					t.Fatalf("unsafe extracted mode: %s", name)
				}
			}
		})
	}
}

func TestArchiveRejectsUnneededUnsafeAndDuplicateMembers(t *testing.T) {
	good := archiveMember{"conf/foxytail.conf", "SOCKS_PORT=1234\n", 0}
	for name, bad := range map[string]archiveMember{
		"unneeded":             {"unrelated.bin", "unrelated", 0},
		"large-unneeded":       {"junk.bin", string(bytes.Repeat([]byte{'x'}, 2<<20)), 0},
		"oversized":            {"conf/routes.conf", string(bytes.Repeat([]byte{'x'}, maxFile+1)), 0},
		"symlink":              {"foxytail.tun.up", "", tar.TypeSymlink},
		"hardlink":             {"foxytail.tun.up", "", tar.TypeLink},
		"fifo":                 {"foxytail.tun.up", "", tar.TypeFifo},
		"traversal":            {"conf/../foxytail.tun.up", "bad", 0},
		"absolute":             {"/conf/routes.conf", "bad", 0},
		"duplicate":            good,
		"normalized-duplicate": {"./conf/foxytail.conf", "bad", 0},
		"unknown-wrapper":      {"other/conf/routes.conf", "bad", 0},
		"mixed-wrapper":        {"foxytail/conf/routes.conf", "bad", 0},
	} {
		t.Run(name, func(t *testing.T) {
			dest, _, err := importArchive(t, compressArchive(t, archiveBytes(t, []archiveMember{good, bad})))
			if err == nil {
				t.Fatal("accepted unsafe archive")
			}
			if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
				t.Fatal("failed import left staging data")
			}
		})
	}
}

func TestArchiveRawByteLimitsAndMalformedStreams(t *testing.T) {
	raw := archiveBytes(t, []archiveMember{{"conf/foxytail.conf", "SOCKS_PORT=1234\n", 0}})
	data := compressArchive(t, raw)
	pax := append([]byte(nil), raw...)
	pax[156] = tar.TypeXHeader // rejected before hidden metadata can be consumed
	for name, body := range map[string][]byte{
		"compressed-limit":         bytes.Repeat([]byte{'x'}, maxCompressed+1),
		"zero-padding-bomb":        compressArchive(t, append(append([]byte(nil), raw...), make([]byte, maxExpanded)...)),
		"forged-small-header-bomb": compressArchive(t, append(append([]byte(nil), raw[:1024]...), bytes.Repeat([]byte{'x'}, maxExpanded)...)),
		"extra-tar":                compressArchive(t, append(append([]byte(nil), raw...), raw...)),
		"extra-gzip":               append(append([]byte(nil), data...), data...),
		"trailing-garbage":         append(append([]byte(nil), data...), 1),
		"truncated":                data[:len(data)-4],
		"pax":                      compressArchive(t, pax),
	} {
		t.Run(name, func(t *testing.T) {
			dest, _, err := importArchive(t, body)
			if err == nil {
				t.Fatal("accepted malformed or oversized stream")
			}
			if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
				t.Fatal("failed import left data")
			}
		})
	}
}

func TestArchiveRejectsSymlinkSourceAndDestination(t *testing.T) {
	base := t.TempDir()
	source := filepath.Join(base, "real.tar.gz")
	data := compressArchive(t, archiveBytes(t, []archiveMember{{"conf/foxytail.conf", "SOCKS_PORT=1234\n", 0}}))
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link.tar.gz")
	if err := os.Symlink(source, link); err != nil {
		t.Fatal(err)
	}
	if _, err := extract(link, filepath.Join(base, "stage")); err == nil {
		t.Fatal("accepted source symlink")
	}
	dest := filepath.Join(base, "destination")
	if err := os.Symlink(t.TempDir(), dest); err != nil {
		t.Fatal(err)
	}
	if _, err := extract(source, dest); err == nil {
		t.Fatal("accepted destination symlink")
	}
	if _, err := extract(source, filepath.Join(dest, "child")); err == nil {
		t.Fatal("accepted destination parent symlink")
	}
	if _, err := extract(filepath.Join(base, "unused")+"/../real.tar.gz", filepath.Join(base, "traversal")); err == nil {
		t.Fatal("accepted source traversal")
	}
}

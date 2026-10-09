// Configuration backups have an exact allowlist and hard compressed/expanded limits.
package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	maxCompressed = 1 << 20
	maxExpanded   = 2 << 20
	maxFile       = 512 << 10
	maxMembers    = 16
)

// The limit covers raw decompressed bytes, not attacker-controlled tar sizes.
type boundedReader struct {
	r    io.Reader
	left int64
}

func (r *boundedReader) Read(p []byte) (int, error) {
	if int64(len(p)) > r.left+1 {
		p = p[:r.left+1]
	}
	n, err := r.r.Read(p)
	if int64(n) > r.left {
		return 0, errors.New("archive byte limit exceeded")
	}
	r.left -= int64(n)
	return n, err
}

func memberPath(name string, directory bool) (string, string, error) {
	name = strings.TrimPrefix(name, "./")
	if directory {
		name = strings.TrimSuffix(name, "/")
	}
	wrapper := ""
	if name == "foxytail" || strings.HasPrefix(name, "foxytail/") {
		wrapper = "foxytail"
		name = strings.TrimPrefix(name, "foxytail/")
		if name == "foxytail" && directory {
			return "", wrapper, nil
		}
	}
	if directory && (name == "conf" || name == "." || name == "") {
		if name == "" && wrapper == "" {
			return "", "", errors.New("empty member path")
		}
		return name, wrapper, nil
	}
	if !directory {
		switch name {
		case "conf/foxytail.conf", "conf/routes.conf", "conf/context.conf", "foxytail.tun.up", "foxytail.tun.down":
			return name, wrapper, nil
		}
	}
	return "", "", fmt.Errorf("unsupported member %q", name)
}

func extractTar(r io.Reader, root *os.Root) error {
	seen := make(map[string]bool)
	layout := ""
	layoutSet := false
	files := 0
	var block [512]byte
	var zero [512]byte
	for count := 0; ; count++ {
		if _, err := io.ReadFull(r, block[:]); err != nil {
			return fmt.Errorf("tar header: %w", err)
		}
		if bytes.Equal(block[:], zero[:]) {
			if _, err := io.ReadFull(r, block[:]); err != nil || !bytes.Equal(block[:], zero[:]) {
				return errors.New("missing tar end marker")
			}
			// Drain to verify gzip checksum and reject concatenated tar archives.
			for {
				n, err := r.Read(block[:])
				for _, b := range block[:n] {
					if b != 0 {
						return errors.New("nonzero trailing tar data")
					}
				}
				if err == io.EOF {
					if files == 0 {
						return errors.New("backup has no configuration files")
					}
					return nil
				}
				if err != nil {
					return err
				}
			}
		}
		if count >= maxMembers {
			return errors.New("too many archive members")
		}
		// Inspect physical headers before archive/tar can consume hidden PAX,
		// sparse or GNU extension headers outside our member accounting.
		switch block[156] {
		case tar.TypeReg, tar.TypeRegA, tar.TypeDir:
		default:
			return errors.New("only regular files and format directories are allowed")
		}
		h, err := tar.NewReader(bytes.NewReader(block[:])).Next()
		if err != nil {
			return fmt.Errorf("invalid tar header: %w", err)
		}
		dir := h.Typeflag == tar.TypeDir
		name, wrapper, err := memberPath(h.Name, dir)
		if err != nil {
			return err
		}
		if h.Linkname != "" || h.Size < 0 || h.Size > maxFile || (dir && h.Size != 0) {
			return errors.New("invalid member size or link")
		}
		key := wrapper + ":" + name
		if seen[key] {
			return errors.New("duplicate archive member")
		}
		seen[key] = true
		if name != "." {
			if layoutSet && layout != wrapper {
				return errors.New("mixed archive layouts")
			}
			layout, layoutSet = wrapper, true
		}
		if dir {
			continue
		}
		if strings.HasPrefix(name, "conf/") {
			files++
		}
		out, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		_, copyErr := io.CopyN(out, r, h.Size)
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if _, err = io.CopyN(io.Discard, r, (512-h.Size%512)%512); err != nil {
			return err
		}
	}
}

func extract(source, dest string) (sum string, err error) {
	for _, component := range strings.Split(source, string(filepath.Separator)) {
		if component == ".." {
			return "", errors.New("archive source must not traverse parent directories")
		}
	}
	parent, err := openRealRoot(filepath.Dir(dest))
	if err != nil {
		return "", err
	}
	defer parent.Close()
	leaf := filepath.Base(dest)
	if err = parent.Mkdir(leaf, 0700); err != nil {
		return "", err
	}
	defer func() {
		if err != nil {
			_ = parent.RemoveAll(leaf)
		}
	}()
	destination, err := parent.OpenRoot(leaf)
	if err != nil {
		return "", err
	}
	defer destination.Close()
	sourceRoot, err := archiveSourceRoot(filepath.Dir(source))
	if err != nil {
		return "", err
	}
	defer sourceRoot.Close()
	input, err := sourceRoot.OpenFile(filepath.Base(source), taildropReadFlags(), 0)
	if err != nil {
		return "", err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > maxCompressed {
		return "", errors.New("archive must be a regular file at most 1 MiB")
	}
	staged, err := destination.OpenFile("input.tar.gz", os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	defer staged.Close()
	hash := sha256.New()
	if _, err = io.Copy(io.MultiWriter(staged, hash), &boundedReader{r: input, left: maxCompressed}); err != nil {
		return "", err
	}
	if _, err = staged.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	compressed := bufio.NewReader(staged)
	gz, err := gzip.NewReader(compressed)
	if err != nil {
		return "", err
	}
	defer gz.Close()
	gz.Multistream(false)
	if err = destination.Mkdir("archive", 0700); err != nil {
		return "", err
	}
	if err = destination.Mkdir("archive/conf", 0700); err != nil {
		return "", err
	}
	root, err := destination.OpenRoot("archive")
	if err != nil {
		return "", err
	}
	defer root.Close()
	if err = extractTar(&boundedReader{r: gz, left: maxExpanded}, root); err != nil {
		return "", err
	}
	if _, err = compressed.ReadByte(); err != io.EOF {
		return "", errors.New("trailing compressed data")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func runArchive(args []string) error {
	if len(args) != 2 {
		return errors.New("usage: foxyfiles extract SOURCE NEW_PRIVATE_DIRECTORY")
	}
	sum, err := extract(args[0], args[1])
	if err != nil {
		return err
	}
	fmt.Println(sum)
	return nil
}

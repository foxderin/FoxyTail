package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
)

// Config is private module state. Listen is deliberately restricted to loopback.
type Config struct {
	Listen      string
	IPv6        bool
	Mode        string
	Queue       uint16
	ContextFile string
	StateFile   string
}

func readConfig(path string) (Config, error) {
	var cfg Config
	f, err := os.Open(path)
	if err != nil {
		return cfg, err
	}
	defer f.Close()
	d := json.NewDecoder(io.LimitReader(f, 65537))
	d.DisallowUnknownFields()
	if err = d.Decode(&cfg); err != nil {
		return cfg, err
	}
	var extra any
	if err = d.Decode(&extra); err != io.EOF {
		return cfg, errors.New("configuration must contain one JSON object")
	}
	return cfg, cfg.validate()
}

func (c Config) validate() error {
	host, port, err := net.SplitHostPort(c.Listen)
	if err != nil || host != "127.0.0.1" {
		return errors.New("listen must be an IPv4 loopback address with a port")
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 0 || p > 65535 {
		return errors.New("invalid listener port")
	}
	if c.Mode != "local" && c.Mode != "transparent" {
		return errors.New("mode must be local or transparent")
	}
	if c.Mode == "transparent" && c.Queue == 0 {
		return errors.New("transparent mode requires a queue number")
	}
	if !filepath.IsAbs(c.ContextFile) {
		return errors.New("contextFile must be absolute")
	}
	if c.StateFile != "" && !filepath.IsAbs(c.StateFile) {
		return errors.New("stateFile must be absolute")
	}
	return nil
}

// writeSnapshotJSON atomically publishes private, replaceable runtime state.
// It deliberately does not sync to storage: readers check the live process and
// snapshot freshness, and a restart reconstructs this data. Persistent account
// or configuration state must use its own durable write path instead.
func writeSnapshotJSON(path string, data any) error {
	if path == "" {
		return nil
	}
	bytes, err := json.Marshal(data)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".foxydns-state-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(append(bytes, '\n'))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("write DNS snapshot: %w", err)
	}
	return os.Rename(f.Name(), path)
}

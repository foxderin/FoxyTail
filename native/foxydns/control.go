package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func controlPath(cfg Config, instance string) string {
	return filepath.Join(filepath.Dir(cfg.StateFile), ".dns-"+instance+".sock")
}

func (s *service) startControl() error {
	if s.cfg.Mode != "transparent" {
		return nil
	}
	if s.cfg.StateFile == "" {
		return errors.New("transparent service requires a private state file")
	}
	path := controlPath(s.cfg, s.instance)
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return err
	}
	if err = os.Chmod(path, 0600); err != nil {
		listener.Close()
		return err
	}
	s.control = listener
	s.controlDone = make(chan struct{})
	go func() {
		defer close(s.controlDone)
		for {
			conn, err := listener.AcceptUnix()
			if err != nil {
				return
			}
			conn.SetDeadline(time.Now().Add(3 * time.Second))
			line, err := bufio.NewReaderSize(conn, 256).ReadSlice('\n')
			if err == nil && string(line) == "quiesce "+s.instance+"\n" {
				if err = s.quiesce(); err == nil {
					fmt.Fprintln(conn, "ok")
				} else {
					fmt.Fprintln(conn, "error")
				}
			}
			conn.Close()
		}
	}()
	return nil
}

func (s *service) quiesce() error {
	if s.interceptor == nil {
		return nil
	}
	return s.interceptor.Close()
}

func quiesceService(cfg Config) error {
	if cfg.Mode != "transparent" {
		return nil
	}
	data, err := os.ReadFile(cfg.StateFile)
	if err != nil {
		return err
	}
	var state healthState
	if err = json.Unmarshal(data, &state); err != nil {
		return err
	}
	if state.Instance == "" || strings.ContainsAny(state.Instance, "/\\\r\n ") {
		return errors.New("invalid listener identity")
	}
	conn, err := net.DialTimeout("unix", controlPath(cfg, state.Instance), 3*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err = fmt.Fprintf(conn, "quiesce %s\n", state.Instance); err != nil {
		return err
	}
	line, err := bufio.NewReaderSize(conn, 32).ReadSlice('\n')
	if err != nil {
		return err
	}
	if string(line) != "ok\n" {
		return errors.New("listener did not quiesce")
	}
	return nil
}

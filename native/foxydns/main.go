package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: foxydns serve|check|probe|health|watch [options]")
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	config := flags.String("config", "", "absolute JSON configuration path")
	state := flags.String("state", "", "absolute state file override")
	queue := flags.Uint("queue", 1053, "netfilter queue number")
	instance := flags.String("instance", "", "expected listener instance for watch")
	parent := flags.Int("parent", 0, "expected guard PID for watch")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional argument")
	}
	if args[0] == "probe" {
		if *queue == 0 || *queue > 65535 {
			return errors.New("queue must be between 1 and 65535")
		}
		if err := ProbeCapabilities(uint16(*queue)); err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "queue": true, "conntrack": true, "socketContext": true})
	}
	if args[0] != "check" && args[0] != "serve" && args[0] != "health" && args[0] != "watch" {
		return errors.New("unknown command")
	}
	cfg, err := readConfig(*config)
	if err != nil {
		return err
	}
	if *state != "" {
		cfg.StateFile = *state
	}
	if err = cfg.validate(); err != nil {
		return err
	}
	if args[0] == "health" || args[0] == "watch" {
		return monitorHealth(cfg, args[0] == "watch", *instance, *parent)
	}
	if _, err = loadRecords(cfg.ContextFile); err != nil {
		return err
	}
	if args[0] == "check" {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true})
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	s, err := startService(cfg)
	if err != nil {
		return err
	}
	defer s.Close()
	select {
	case <-signals:
		return nil
	case err := <-s.errors:
		return fmt.Errorf("DNS server stopped: %w", err)
	}
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": false, "error": err.Error()})
		os.Exit(1)
	}
}

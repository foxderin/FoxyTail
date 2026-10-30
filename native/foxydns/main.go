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
		return errors.New("usage: foxydns serve|check|probe|verify|socks-check|health|watch|quiesce|cleanup [options]")
	}
	if args[0] == "verify" {
		return runVerify(args[1:])
	}
	if args[0] == "socks-check" {
		return runSocksCheck(args[1:])
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	config := flags.String("config", "", "absolute JSON configuration path")
	state := flags.String("state", "", "absolute state file override")
	queue := flags.Uint("queue", 1053, "netfilter queue number")
	instance := flags.String("instance", "", "expected listener instance for watch")
	parent := flags.Int("parent", 0, "expected guard PID for watch")
	journal := flags.String("journal", "", "absolute captured-flow ownership journal")
	port := flags.Uint("port", 0, "legacy listener port")
	hijack := flags.Bool("hijack", false, "probe name-selective interception instead of transparent replay")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional argument")
	}
	if args[0] == "cleanup" {
		return cleanupOwnedFlows(*journal)
	}
	if args[0] == "legacy-claim" || args[0] == "legacy-cleanup" {
		if *port == 0 || *port > 65535 {
			return errors.New("invalid legacy listener port")
		}
		return legacyOwnership(*journal, uint16(*port), args[0] == "legacy-cleanup")
	}
	if args[0] == "probe" {
		if *queue == 0 || *queue > 65535 {
			return errors.New("queue must be between 1 and 65535")
		}
		if *hijack {
			if err := ProbeHijackCapabilities(uint16(*queue)); err != nil {
				return err
			}
			return json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "queue": true, "inject": true})
		}
		ipv6, err := ProbeCapabilities(uint16(*queue))
		if err != nil {
			return err
		}
		// ok means IPv4 interception works; ipv6 is additive information for
		// consumers that also install v6 rules.
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "queue": true, "conntrack": true, "socketContext": true, "ipv6": ipv6})
	}
	if args[0] != "check" && args[0] != "serve" && args[0] != "health" && args[0] != "watch" && args[0] != "quiesce" {
		return errors.New("unknown command")
	}
	cfg, err := readConfig(*config)
	if err != nil {
		return err
	}
	if *state != "" {
		cfg.StateFile = *state
	}
	// The config carries the queue number; an explicit --queue overrides it
	// for serve just like --state, rather than being silently ignored.
	queueOverride := false
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "queue" {
			queueOverride = true
		}
	})
	if queueOverride {
		if *queue == 0 || *queue > 65535 {
			return errors.New("queue must be between 1 and 65535")
		}
		cfg.Queue = uint16(*queue)
	}
	if err = cfg.validate(); err != nil {
		return err
	}
	if args[0] == "quiesce" {
		return quiesceService(cfg)
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
	for {
		select {
		case <-signals:
			if cfg.Mode == "transparent" {
				if err := s.shutdownCapture(); err != nil {
					return err
				}
			}
			return nil
		case err := <-s.errors:
			if cfg.Mode == "transparent" {
				// The deferred Close stops the queue but never drains owned
				// DNAT state; a crashed listener gets the same bounded
				// cleanup as the signal path before reporting its failure.
				if cleanupErr := s.shutdownCapture(); cleanupErr != nil {
					err = errors.Join(err, cleanupErr)
				}
			}
			return fmt.Errorf("DNS server stopped: %w", err)
		}
	}
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": false, "error": err.Error(), "unsupported": errors.Is(err, ErrUnsupported)})
		os.Exit(1)
	}
}

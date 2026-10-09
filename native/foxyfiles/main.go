package main

import (
	"fmt"
	"os"
)

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: foxyfiles extract|receive|ordered-stats|taildrop-targets|browse|stage|stage-delete|inbox-read|send-start|send-status|send-cancel|send-history|send-stop [arguments]")
	}
	switch args[0] {
	case "extract":
		return runArchive(args[1:])
	case "receive":
		return runTaildrop(args[1:])
	case "ordered-stats":
		return runOrderedStats(args[1:])
	case "taildrop-targets":
		return runTargets(args[1:])
	case "browse":
		return runBrowse(args[1:])
	case "stage":
		return runStage(args[1:])
	case "stage-delete":
		return runStageDelete(args[1:])
	case "inbox-read":
		return runInboxRead(args[1:])
	case "send-start":
		return runSendStart(args[1:])
	case "send-status", "send-cancel", "send-history", "send-stop":
		return runSendQuery(args[0], args[1:])
	case "send-worker":
		return runSendWorker(args[1:])
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

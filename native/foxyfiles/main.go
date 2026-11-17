package main

import (
	"fmt"
	"os"
)

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: foxyfiles extract|artifact-stage|artifact-create|artifact-read|artifact-delete|artifact-extract|receive|stats-summary|taildrop-targets|browse|stage|stage-delete|inbox-list|inbox-read|send-start|send-status|send-cancel|send-history|send-delete|send-clear|send-stop [arguments]")
	}
	switch args[0] {
	case "identity-stage", "identity-export", "identity-preview", "identity-restore", "identity-recover":
		return runIdentity(args[0][len("identity-"):], args[1:])
	case "artifact-stage", "artifact-create", "artifact-read", "artifact-delete", "artifact-extract", "artifact-pin":
		return runArtifact(args[0][len("artifact-"):], args[1:])
	case "extract":
		return runArchive(args[1:])
	case "receive":
		return runReceive(args[1:])
	case "stats-summary":
		return runStatsSummary(args[1:])
	case "taildrop-targets":
		return runTargets(args[1:])
	case "browse":
		return runBrowse(args[1:])
	case "stage":
		return runStage(args[1:])
	case "stage-delete":
		return runStageDelete(args[1:])
	case "inbox-list":
		return runInboxList(args[1:])
	case "inbox-read":
		return runInboxRead(args[1:])
	case "send-start":
		return runSendStart(args[1:])
	case "send-status", "send-cancel", "send-history", "send-delete", "send-clear", "send-stop":
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

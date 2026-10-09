package main

import (
	"fmt"
	"os"
)

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: foxyfiles extract|receive|ordered-stats [arguments]")
	}
	switch args[0] {
	case "extract":
		return runArchive(args[1:])
	case "receive":
		return runTaildrop(args[1:])
	case "ordered-stats":
		return runOrderedStats(args[1:])
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

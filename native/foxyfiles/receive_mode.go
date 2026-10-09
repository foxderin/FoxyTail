package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func (api *localAPI) directReceiveMode(ctx context.Context) error {
	id, err := randomID()
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"http://local-tailscaled.sock/localapi/v0/files/.foxytail-mode-probe-"+id, nil)
	if err != nil {
		return err
	}
	response, err := api.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	// The pinned daemon rejects every OpenFile before lookup when direct mode is active.
	body, err := io.ReadAll(io.LimitReader(response.Body, 257))
	if err != nil {
		return err
	}
	if response.StatusCode != http.StatusInternalServerError || strings.TrimSpace(string(body)) != "opens not allowed in direct mode" {
		return errors.New("daemon has not confirmed direct receive mode; unlock shared storage and restart FoxyTail")
	}
	return nil
}

func runReceiveMode(args []string) error {
	flags := flag.NewFlagSet("receive-mode", flag.ContinueOnError)
	socket := flags.String("socket", "", "tailscaled LocalAPI socket")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected receive-mode arguments")
	}
	api, err := newLocalAPI(*socket)
	if err != nil {
		return err
	}
	defer api.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = api.directReceiveMode(ctx); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "direct": true})
}

package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
)

func (api *localAPI) receiveDirect(ctx context.Context) (bool, error) {
	id, err := randomID()
	if err != nil {
		return false, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"http://local-tailscaled.sock/localapi/v0/files/.foxytail-mode-probe-"+id, nil)
	if err != nil {
		return false, err
	}
	response, err := api.client.Do(request)
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	// The pinned daemon rejects every OpenFile before lookup when direct mode is active.
	body, err := io.ReadAll(io.LimitReader(response.Body, 257))
	if err != nil {
		return false, err
	}
	if response.StatusCode == http.StatusInternalServerError {
		message := strings.TrimSpace(string(body))
		if message == "opens not allowed in direct mode" {
			return true, nil
		}
		if strings.Contains(message, "no such file or directory") {
			return false, nil
		}
	}
	return false, errors.New("daemon receive mode unavailable or unrecognized")
}

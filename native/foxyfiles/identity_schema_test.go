package main

import "testing"

func TestIdentityPinnedSchema(t *testing.T) {
	profile := []byte(`{"ID":"abcd","Key":"profile-abcd","UserProfile":{"ID":42,"Groups":["group"]}}`)
	for _, prefs := range []string{`{}`, `{"WantRunning":true,"Sync":null,"AutoUpdate":{"Apply":null},"AutoExitNode":"any"}`, `{"ExitNodeIP":"","AdvertiseRoutes":["10.0.0.0/8"],"RelayServerPort":65535,"NetfilterMode":2}`, `{"DriveShares":[{"name":"a","path":"/tmp","who":"user","bookmarkData":"YQ=="}],"FutureField":{"opaque":true}}`, `{"Config":null,"AllowSingleHosts":{"upstreamIgnores":true}}`} {
		if !validateIdentityProfile("abcd", profile, []byte(prefs)) {
			t.Fatalf("rejected safe synthetic schema: %s", prefs)
		}
	}
	for _, prefs := range []string{`null`, `{"WantRunning":"true"}`, `{"WantRunning":true,"wantrunning":false}`, `{"AutoUpdate":{"Apply":"true"}}`, `{"AutoUpdate":{"apply":true}}`, `{"AppConnector":{"Advertise":1}}`, `{"AdvertiseTags":[1]}`, `{"ExitNodeIP":"bad"}`, `{"AdvertiseRoutes":["bad"]}`, `{"RelayServerPort":65536}`, `{"RelayServerPort":-1}`, `{"NetfilterMode":"on"}`, `{"DriveShares":[{"path":42}]}`, `{"DriveShares":[{"bookmarkData":"invalid"}]}`, `{"Config":{"UserProfile":{"ID":"bad"}}}`, `{"Config":{"userprofile":{}}}`, `{"Config":{"AttestationKey":{}}}`, `{"Config":{"PrivateNodeKey":"bad"}}`, `{"Config":{"NetworkLockKey":"bad"}}`} {
		if validateIdentityProfile("abcd", profile, []byte(prefs)) {
			t.Fatalf("accepted malformed synthetic schema: %s", prefs)
		}
	}
	for _, profile := range []string{`{"ID":"other","Key":"profile-abcd"}`, `{"ID":"abcd","Key":"profile-other"}`, `{"ID":"abcd"}`, `{"ID":"abcd","Key":"profile-abcd","id":"other"}`, `{"ID":"abcd","Key":"profile-abcd","UserProfile":{"ID":1.5}}`, `{"ID":"abcd","Key":"profile-abcd","NetworkProfile":{"DomainName":42}}`} {
		if validateIdentityProfile("abcd", []byte(profile), []byte(`{}`)) {
			t.Fatal("accepted malformed synthetic profile")
		}
	}
}

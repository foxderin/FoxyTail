package main

// Known field types are pinned to anasfanani/tailscale-android-cli
// v1.98.8-android ipn/prefs.go and types/persist/persist.go. Unknown fields
// remain opaque and preserved, but case aliases of known fields are rejected:
// encoding/json otherwise treats them as the same member despite distinct keys.
import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"net/netip"
	"strings"
)

type identityField func(json.RawMessage) bool

func identityType[T any](raw json.RawMessage) bool {
	var value T
	return json.Unmarshal(raw, &value) == nil
}
func identityShape(raw []byte, fields map[string]identityField) bool {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return true
	}
	var object map[string]json.RawMessage
	if !identityJSON(raw) || json.Unmarshal(raw, &object) != nil || object == nil {
		return false
	}
	for key, value := range object {
		if check, ok := fields[key]; ok {
			if !check(value) {
				return false
			}
			continue
		}
		for known := range fields {
			if strings.EqualFold(key, known) {
				return false
			}
		}
	}
	return true
}
func identityFields(names string, check identityField) map[string]identityField {
	fields := map[string]identityField{}
	for _, name := range strings.Fields(names) {
		fields[name] = check
	}
	return fields
}
func identityUser(raw json.RawMessage) bool {
	fields := identityFields("LoginName DisplayName ProfilePicURL", identityType[string])
	fields["ID"] = identityType[int64]
	fields["Groups"] = identityType[[]string]
	return identityShape(raw, fields)
}
func identityPersist(raw json.RawMessage) bool {
	fields := identityFields("NodeID", identityType[string])
	for _, name := range []string{"PrivateNodeKey", "OldPrivateNodeKey"} {
		fields[name] = func(value json.RawMessage) bool {
			var key string
			return json.Unmarshal(value, &key) == nil && validIdentityKey(key)
		}
	}
	fields["NetworkLockKey"] = func(value json.RawMessage) bool {
		var key string
		if json.Unmarshal(value, &key) != nil || !strings.HasPrefix(key, "nlpriv:") || len(key) != 135 {
			return false
		}
		_, err := hex.DecodeString(key[7:])
		return err == nil
	}
	fields["UserProfile"] = identityUser
	fields["DisallowedTKAStateIDs"] = identityType[[]string]
	// Hardware-bound state cannot be transported to another device by copying JSON.
	fields["AttestationKey"] = func(value json.RawMessage) bool { return bytes.Equal(bytes.TrimSpace(value), []byte("null")) }
	return identityShape(raw, fields)
}
func validateIdentityProfile(id string, profile, prefs []byte) bool {
	if !bytes.HasPrefix(bytes.TrimSpace(prefs), []byte("{")) {
		return false
	}
	fields := identityFields("ID Key Name NodeID LocalUserID ControlURL", identityType[string])
	fields["UserProfile"] = identityUser
	fields["NetworkProfile"] = func(raw json.RawMessage) bool {
		return identityShape(raw, identityFields("MagicDNSName DomainName DisplayName", identityType[string]))
	}
	if !identityShape(profile, fields) {
		return false
	}
	var link struct {
		ID  string
		Key string
	}
	if json.Unmarshal(profile, &link) != nil || link.ID != id || link.Key != "profile-"+id {
		return false
	}
	fields = identityFields("ControlURL ExitNodeID AutoExitNode InternalExitNodePrior Hostname OperatorUser ProfileName NetfilterKind", identityType[string])
	for _, name := range strings.Fields("RouteAll ExitNodeAllowLANAccess CorpDNS RunSSH RunWebClient WantRunning LoggedOut ShieldsUp NotepadURLs ForceDaemon Egg NoSNAT PostureChecking Sync NoStatefulFiltering") {
		fields[name] = identityType[bool]
	}
	for _, name := range []string{"AdvertiseTags", "AdvertiseServices"} {
		fields[name] = identityType[[]string]
	}
	fields["ExitNodeIP"] = identityType[netip.Addr]
	fields["AdvertiseRoutes"] = identityType[[]netip.Prefix]
	fields["RelayServerPort"] = identityType[*uint16]
	fields["RelayServerStaticEndpoints"] = identityType[[]netip.AddrPort]
	fields["AutoUpdate"] = func(raw json.RawMessage) bool {
		return identityShape(raw, identityFields("Check Apply", identityType[bool]))
	}
	fields["AppConnector"] = func(raw json.RawMessage) bool {
		return identityShape(raw, identityFields("Advertise", identityType[bool]))
	}
	fields["NetfilterMode"] = identityType[int]
	fields["DriveShares"] = func(raw json.RawMessage) bool {
		var shares []json.RawMessage
		if json.Unmarshal(raw, &shares) != nil {
			return false
		}
		shareFields := identityFields("name path who", identityType[string])
		shareFields["bookmarkData"] = identityType[[]byte]
		for _, share := range shares {
			if !identityShape(share, shareFields) {
				return false
			}
		}
		return true
	}
	fields["Config"] = identityPersist
	// AllowSingleHosts has a deliberately no-op UnmarshalJSON in the pinned daemon.
	fields["AllowSingleHosts"] = func(json.RawMessage) bool { return true }
	return identityShape(prefs, fields)
}

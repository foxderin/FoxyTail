# Android network audit: bounded borrowing from Shellscaled

Source audit plus the scoped host tests and Android builds described below; no device routing, VPN coexistence, kernel or encrypted-DNS session was verified.

## Pinned daemon differences

FoxyTail pins `anasfanani/tailscale-android-cli` v1.98.8-android in `tailscale/VERSIONS`, resolving to `d6a741131b0d5010797bd737ca3bd7c02f8cb511`. Shellscaled `11af7c142d55c726f3ca9ca7a6d93ecd45be066e` uses fork `fffe5490c2fb3baed14c83f784d41ecaca85d1a9`.

- The current daemon subscribes to IPv4 rule notifications only and decodes `RTM_DELRULE` as a route message. The other fork subscribes to IPv6 rules too and decodes FIB rule attributes, including full-width table IDs. Rule and route attributes are not interchangeable; a UID-range rule can be misparsed. This is a good candidate for a small upstream daemon patch, not a shell workaround.
- The other fork filters destination rules by address family and preserves destination/inversion in CLI fallback. Its fallback routing predicate excludes Android explicit-network and VPN-protected bits. Current FoxyTail daemon routing also includes subnet/hotspot return rules absent from that smaller rule list. Copying the entire list or changing marks without regression coverage can break advertised routes/hotspot behavior.
- Fixed rule priority is not proof of universal coexistence with Android VPN UID/interface policies or lockdown. FoxyTail bridge/proxy modes have a different ownership boundary from native TUN.

Sources:

- [Current daemon netmon](https://github.com/anasfanani/tailscale-android-cli/blob/d6a741131b0d5010797bd737ca3bd7c02f8cb511/net/netmon/netmon_linux.go#L59-L72), [rule decoder](https://github.com/anasfanani/tailscale-android-cli/blob/d6a741131b0d5010797bd737ca3bd7c02f8cb511/net/netmon/netmon_linux.go#L230-L249).
- [Fork netmon](https://github.com/KyuubiRan/tailscale-android-cli/blob/fffe5490c2fb3baed14c83f784d41ecaca85d1a9/net/netmon/netmon_linux.go).
- [Current Android routing](https://github.com/anasfanani/tailscale-android-cli/blob/d6a741131b0d5010797bd737ca3bd7c02f8cb511/wgengine/router/osrouter/router_linux.go#L1417-L1468), [fork routing](https://github.com/KyuubiRan/tailscale-android-cli/blob/fffe5490c2fb3baed14c83f784d41ecaca85d1a9/wgengine/router/osrouter/router_linux.go#L1660-L1716).

The Private DNS stage alone did not replace the daemon. The subsequent source-build stage now applies the narrow event subscription/decoder/restore-priority patch described in [the daemon build notes](../native/tailscaled/README.md). Routing marks and rule shapes remain unchanged. The scoped event patch includes parser/priority fixtures and both Android architecture builds. Broader routing-rule changes would still need family/fallback tests and actual VPN/subnet/exit-node validation. Keep identity-state schema and Taildrop compatibility checks when upgrading the daemon.

## Private DNS policy hint (implemented)

Both legacy and modern DNS JSON status now expose `privateDnsMode`: `off`, `opportunistic`, `hostname` or `unknown`. It describes the configured system policy, not actual encrypted transport use. The Tunnel page explains automatic/strict encrypted DNS may bypass local port-53 interception. This does not change readiness, capability verdicts, native policy, system settings or existing failure reasons.

[AOSP policy selection](https://android.googlesource.com/platform/frameworks/libs/net/+/8ef52686483cdff0040d22753bb516e99a96a88d/common/framework/com/android/net/module/util/ConnectivitySettingsUtils.java#92) first reads `private_dns_mode`, then `private_dns_default_mode`, then defaults to opportunistic. The shell reader follows that fallback for successfully read unset values; failed/unrecognized shell output remains unknown rather than guessing. It never reads the provider hostname or probes DNS/TLS.

Validation uses fake settings and existing DNS lifecycle/smoke fixtures, not the user's device or DNS traffic. Existing smoke scenario extended rather than adding another boot scenario.

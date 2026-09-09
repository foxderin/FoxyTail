# Changelog

## v1.0.4 (unreleased)

- Fix empty tab labels on the Logs/Peers/Traffic pages (Solid slot introspection regression)
- WebUI now surfaces the real backend error message instead of a bare "exit code 1"
- Fix the MagicDNS redirect loop that broke device-wide DNS when MAGIC_DNS=on (dnsmasq upstream queries are exempted via owner match)
- Fix quad-100 self-assignment in bridge mode so the MagicDNS upstream is actually reachable
- Fix file-send/restore rejecting every /sdcard path (realpath resolved the symlink before the prefix check)
- settings-set: per-key type validation (ranges, enums, charset) and key exact-matching; shell metacharacters can no longer reach the sourced conf
- restore: archives are unpacked to a temp dir and validated line by line before anything is applied; restored hooks are parked as `<hook>.restored` (0644) for review
- Installer: all downloads and SHA256 checks are staged before the previous installation is touched; an aborted upgrade leaves the old module intact
- Watchdog: a manual stop that lands during an in-flight restart now wins; status probes no longer emit broken JSON on pid races; daemon detection matches our binary path instead of a bare pidof
- Route teardown is keyed on the parameters recorded at apply time: flipping IPV6/FWMARK/ROUTE_TABLE between apply and teardown no longer leaks iptables/ip rule state
- Fix stats sampling always running at the idle rate (`\|` BRE alternation never matched on Android)
- Context rules now replay on boot instead of waiting for the first context change
- Add IPv6 parity for the DNS hijack (ip6tables REDIRECT with the same owner exemption)
- WebUI: request-order guards on all polling pages, backend cleanup on timeout, timeout budgets matched to backend worst cases, topology view redraws on peer updates, LineChart follows window resize, stale-data banner on Dashboard
- WebUI: settings switches stay in sync after saves, concurrent confirms cannot strand a promise, toasts are capped, SOCKS self-test no longer counts 4xx/5xx as success
- Smoke suite: bundle freshness guard plus new cases for error propagation, task replacement and tab labels

## v1.0.3

- Replace @material/web (Lit) with hand-built native components: no shadow-DOM overhead, lighter bundle
- Fix icon alignment and reduce layout jank across the WebUI
- Watchdog now respects manual stop: it no longer resurrects tailscaled after the user taps Stop
- Improve login error feedback when the daemon cannot reach the Tailscale control plane
- WebUI bundle: 190 KB JS / 14.6 KB CSS (was ~460 KB JS / ~8 KB CSS)

## v1.0.2

- Rebuild WebUI with SolidJS + Material Web (MD3 theme, fox-orange palette)
- Login hero on Dashboard (non-blocking, dismissible), global status indicator in top bar
- API timeouts everywhere; heavy operations are cancellable session tasks that survive page switches
- Instant page switching with skeletons; fast apps listing (single pm call)


## v1.0.1

- Fix KSU/MMRL WebUI exec bridge signature (string options + string callback name)
- Fix watchdog restart loop while backend state is NeedsLogin
- Fix compat probe false positives on sandbox/searchbox packages
- Fix WebUI tunnel gateway parsing
- Silence duplicate route apply on service start
- Tighten stats sample file permissions

## v1.0.0

- Initial release.


## v1.0.0

- Initial release.

# Changelog

## v1.0.5 — 2026-09-09

- Use asynchronous KernelSU/MMRL spawn instead of the blocking exec bridge; defer root calls until after painting and discard reads from pages already left.
- Detach each WebAPI process from the manager app freezer before acquiring configuration locks, preventing frozen requests from blocking the module.
- Reduce shell/jq process launches, avoid redundant status/app queries, and precompute theme tokens to reduce startup JavaScript.
- Use system/vendor dnsmasq when available; resolve Tailnet short names with inline mappings compatible with Android privilege dropping.
- Coexist with the pinned native DNS redirect, route resolver upstream traffic correctly, and refresh negative DNS caches through verified Android resolver interfaces.
- Distinguish local DNS readiness from native Tailnet DNS, and only warn about proxy DNS conflicts when active interception is detected.
- Validate on a rooted Android 16 device with KernelSU 3.3.0, including WebView timing, background freezing and actual short-name resolution.

## v1.0.4 — 2026-09-09

- Treat runtime configuration as validated data with a fixed schema; serialize writes and make backup/restore transactional.
- Isolate policy routing with a masked mark, reserved-table protection, explicit resource ownership, complete drift detection and recoverable apply/cleanup.
- Restrict native TUN to `all`; per-app selected/bypass routing requires bridge mode, and root UID 0 bypasses the bridge tunnel. IPv6 requires explicitly configured IPv6 subnets.
- Stop and verify old components before an upgrade, preserve user files and supplied dnsmasq, and recover interrupted software switches from a rollback journal.
- Reconcile partial service failures and DNS readiness; preserve degraded status and rebuild the resolver after an account or Tailnet change.
- Apply saved settings through a full service/helper reload, keeping a newer concurrent configuration revision marked as pending.
- Correct UID traffic direction and dual-stack counters; aggregate adjacent deltas across counter resets and time-bucket boundaries.
- Replace global process-name cancellation with request IDs and verified child identities; wait for cancellation acknowledgement before replacing tasks.
- Fix first-load error recovery, SOCKS5 probes, account listing, and Serve/Funnel protocol, path and deletion handling in the WebUI.
- Bound runtime logs continuously while preserving open writer descriptors and retaining a capped backup.
- Add 46 isolated backend regressions and expanded WebUI smoke coverage, pin Node/pnpm and WebView targets, and verify committed production assets in CI.
- Build releases from existing version tags; verify reviewed upstream checksums and publish light/full packages with SHA256SUMS.

Android device routing, module-manager installation and coexistence tests remain pending; host regression checks do not replace device validation.

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

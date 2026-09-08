# Changelog

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

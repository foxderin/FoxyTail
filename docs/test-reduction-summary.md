# Test reduction integration

Baseline: `544e2ab`. Production code, Android tests and CI discovery are unchanged.
The three reductions delete scenarios rather than rename them, hide them behind
skips, or combine their bodies into fewer test functions.

## Count and scope

| Suite | Before | After | Counting unit |
| --- | ---: | ---: | --- |
| Python | 508 | 254 | Discovered `test_*` methods |
| Go | 153 | 76 | `TestX(*testing.T)` functions, excluding `TestMain` |
| WebUI | 64 | 28 | Independently booted scenario executions, expanding boot loops |
| Android | 8 | 8 | Five device check groups and three JVM main entry points |
| Total | 733 | 366 | Above units, consistently applied before/after |

Removed **367 of 733 counted scenarios (50.07%)**. This metric is not assertions,
source lines, branch coverage or runtime. Android groups comprise the direct
BridgeInstrumentation checks, IncomingNotificationChecks, ControlChecks,
FilesIntegrationChecks and WebViewChecks, plus SettingsRulesTest,
IncomingNotificationReceiptTest and IdentityRulesTest. Internal assertions and
parameter rows do not create additional method/group counts. Test/fixture source
has a net reduction of 6,959 lines; the new scope documentation is separate.

Coverage is intentionally reduced, not proven equivalent. The per-suite ledgers
record the exact removals and losses:

- [Python](python-test-reduction.md)
- [Native](native-test-scope.md)
- [WebUI](ui-test-followup-reduction.md)

## Combined validation

- Python: all 37 modules / 254 methods attempted against freshly built real native
  helpers. 250 passed, one existing mksh-dependent test skipped, three failed
  because this environment denies AF_UNIX sockets. Full runner took 92.8 seconds.
  The affected tests are ServiceRecoveryTests' failed-launch stale-socket case,
  failed-recovery teardown case, and trial rollback after context-down case.
- Native: full race runs were attempted; eight retained socket/netlink tests are
  blocked by host permissions (listed in the native ledger). On the integrated
  tree, race runs excluding exactly those eight at the command line passed in
  16.292s and 17.857s; both modules passed `go vet`. Existing privileged-test skips
  still apply. No source or CI skip was introduced to obtain these results.
- Integrated WebUI typecheck, i18n parity, theme check, production build and smoke
  bundle build passed; the final smoke runner passed all 338 assertions. An
  independent temporary counter confirmed 28 boots in 7.47 seconds; the counter
  was removed and the shared fixture restored exactly before committing.
- All three Java host test entry points compiled and ran successfully. Android
  device instrumentation and privileged kernel integration were not executed.

These observations do not establish that the complete suite passes on this host,
that device behavior was tested, or that runtime was halved. WebUI baseline/reduced
runner timings in its ledger are single local samples excluding compilation.

# WebUI test scope reduction

Baseline: `544e2ab`. **64 → 28 independently booted scenario executions**, deleting 36 (56.25%). This is not an assertion count. No remaining scenarios were combined, renamed to escape discovery, or hidden behind skips. Production and Android tests are unchanged.

## Counting

Before: 41 named main scenarios + 2 scheduler-factory iterations + 4 read-recovery scenarios + 12 standalone-runner boots + 5 availability fixtures = 64.

After: 17 named main scenarios + 2 scheduler-factory iterations + 8 standalone-runner boots (identity 2, backup picker 3, Back 1, fields 1, cached DNS 1) + 1 unknown-availability fixture = 28. A temporary runtime counter in `boot()` verifies the final total; that counter is not committed. Existing assertion loops inside retained scenarios are unchanged.

## Retained priorities

Stale-list destructive gating; account and operation revision fences; accepted writes surviving UI disposal without replay; confirmed settings batches and conflict consent; blocked automatic receipt recovery; partial file outcomes and selection bounds; backup hash/path and Serve/coexistence boundaries; untrusted log text and full copy; auth-key disposal; trial recovery; cancellation ownership; authoritative failure results; exit-node confirmation; context baseline safety; native file cancellation; explicit DNS probe progress; generic interrupted-read schedulers; identity import/export/restore and fresh baselines; local backup selection; system Back state; keyboard selection without accidental commit; cache-only DNS capability reads; unknown native operation adoption without resubmission.

## Exact removed main scenarios

- `Files exposes daemon-held deliveries and recovers without hiding failures`
- `routes, appearance and retained Files UI`
- `session drafts restore unmounted Logs but a new document starts clean`
- `fresh document does not inherit prior session edits`
- `settings preflight failure unlocks the batch for retry`
- `Select keeps the value and indicator in one accessible row`
- `Select owns disabled state and dismissal`
- `Back closes active popup before disclosure and parent links unwind history`
- `popup selects open option lists and dispatch native change events`
- `peer detail probes run from the address row and render a result panel`
- `Incoming notification targets retained inbox and supersedes pending history focus`
- `Incoming notifications report preference separately from system permission`
- `Automatic buffered receipt writes one fresh setting without restart`
- `Files composer groups sources and keeps browser navigation available`
- `Traffic cancellation releases busy state and resumes retained page`
- `Native navigation dismisses retained page modal without discarding state`
- `Back ignores hidden retained disclosures`
- `context Add separates the editor and can cancel and reopen`
- `context rules publish before slow status and status resumes only when visible`
- `feedback primitives keep errors readable and name destructive actions`
- `dashboard states expose one status and a direct recovery action`
- `status sheet mirrors the connection card without top-bar controls`
- `critical feedback is compact and uses availability errors, not task messages`
- `untracked native busy lives in the status chip, not a page banner`

## Removed independent runners / fixture rows

- `runAccountDetailsSmoke`: 1 boot.
- `runToastDedupSmoke`: 1 boot.
- `runStatusModalSmoke`: 1 boot.
- `runMotionSmoke`: 1 boot.
- Read recovery: `Logs initial interrupted read resumes without enabling auto refresh`; `Advanced independent reads and persistent DNS probe errors`; `DNS probe failure survives successful observation refresh`; `Network summary invalidates after revision and failed refresh`: 4 boots.
- Availability fixtures `empty`, `error`, `no-root`, `no-bridge`: 4 boots. Their test-only branches are deleted, not left disabled. The `unknown` fixture remains.

## Deliberate coverage loss

These are not all exact duplicates. Overlapping keyboard/Back/navigation and confirmation checks are reduced to representative boundaries, but page-specific wiring is now less covered. Lost checks include theme preference round trips, session-store/remount variants, notification inbox focus and permission presentation, automatic-receive setting UI, composer layout, account detail formatting, peer probe layout, traffic/page-specific interrupted reads, dashboard status presentation, modal focus/backdrop behavior, persistent toast deduplication/full-detail affordances, and recent context editor spacing/cancel-reopen checks.

Reduced-motion/transform/label-layout CSS source assertions are removed. jsdom never proved actual rendered geometry. Generic scheduler tests remain but do not prove every page uses those schedulers correctly. Native root-denial/origin/URI tests remain but do not replace the deleted WebUI no-root/no-bridge presentation fixtures. UI-specific notification and settings wiring regressions may now escape this suite. This is an explicit scope tradeoff for the requested reduction, not a claim of unchanged coverage.

Android tests are retained because actual WebView origin restrictions, URI permissions, Activity lifecycle and binary cancellation/export have unique platform behavior that jsdom cannot replace.

## Verification

Both baseline and reduced suites passed against the same freshly built application bundle on this host. Temporary runtime counters measured baseline **64 boots / 637 assertions / 15 seconds**, reduced **28 boots / 338 assertions / 8 seconds**. These are single local runner samples excluding bundle build, not a CI timing guarantee. The bundle build also passed (148 modules). No device visual or instrumentation execution is claimed. Assertion totals are runner output, never the scenario-count reduction metric. Temporary counters and baseline copies are not part of the committed suite.

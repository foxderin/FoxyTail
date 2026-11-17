# Device identity state

Identity files contain reusable, **unencrypted credentials for all stored profiles**, not recoverable auth keys. Protect saved copies and avoid concurrent devices using the same identity. Configuration backups remain separate and do not contain identity state.

## Supported workflow

Explicitly stop the service before export, preview or restore. The backend requires a manual-stop marker, no daemon, no active outgoing transfers, no configuration trial and no installation. These operations share the service lifecycle lock. Export creates a private snapshot; Android's document picker saves it without passing secret bytes through the WebView. The app rejects sharing identity artifacts. Private staged, exported and rollback artifacts expire after 24 hours; saved document-picker files do not expire automatically.

External offline editing of exported `.state` or `.json` files is supported through validated import. There is no raw JSON editor in the WebView. Current-profile nickname editing instead uses the official `tailscale set --nickname` command with selected-profile checks and readback.

Preview returns bounded metadata and source/current-baseline digests. Explicitly confirmed restore checks both digests, replaces state atomically and leaves the service stopped. Start separately. An absent state file or missing state directory is supported for migration; an existing empty or invalid bounded original can also be replaced. Nonempty originals receive an exact temporary private rollback artifact; absent/empty originals do not produce a downloadable rollback artifact.

## Validation and recovery

The supported format is the modern JSON FileStore in pinned `anasfanani/tailscale-android-cli` `v1.98.8-android`: base64 outer values, linked profile registry/current profile, matching embedded IDs/keys and typed known preferences/persisted keys. Duplicate JSON members and ambiguous case aliases are rejected. Genuine unknown fields are retained. Non-null hardware attestation state is unsupported. Limits are 4 MiB, 128 profiles, 512 outer entries and bounded JSON nesting. Legacy/incompatible formats fail closed.

A private journal preserves original bytes or original absence across interrupted replacement. Startup recovers unfinished transactions before launching the daemon; committed replacements survive interrupted cleanup. Unsafe or unreadable recovery state blocks startup. Validation does not prove authorization, unexpired keys, server acceptance, cross-version compatibility or connectivity.

App-managed durable operations and service lifecycle locking do not control trusted root users or external CLI/daemon writes. Concurrent out-of-band identity editing is unsupported.

## Verification

Synthetic-only tests cover format/link validation, stale digests, private artifacts, original preservation, interrupted recovery, fresh/empty baselines and lifecycle serialization. No real user identity was read or exported. Device filesystem behavior and real controller authentication after import remain unverified.

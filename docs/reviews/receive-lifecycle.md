# Optional automatic recovery and incoming-file notifications

## Independent switches

- Direct Taildrop reception remains the daemon's existing Android behavior. This change does **not** restart the daemon or turn direct reception off.
- `TAILDROP_AUTO_RECEIVE=0` is the upgrade/default value. Set to `1` through `settings-set` to enable recovery of completed files still buffered by the daemon. This key is hot-read from validated saved configuration on the next resident poll (normally 15 seconds; power saving can increase the interval). No unrelated pending settings are applied and no daemon restart is requested.
- Notifications are independently opt-in inside the Android app and require Android notification permission/channel availability. Automatic recovery does not enable notifications.

## Root-owned lifecycle and safety

`foxytail.receive` uses the existing verified PID ownership helpers. Module boot/start/resume starts it; pause/stop/disable/upgrade quiescence stops it. It respects installation, module-disable, manual-stop, and context-stop markers. It reads native `inbox-list` snapshots without holding the configuration lock across I/O. Shared storage must resolve to the existing safe Taildrop directory, or be safely prepared when recovery is enabled.

Recovery submits the existing `file-receive` durable mutation with the expected self identity. The private journal is written before submission. An ambiguous start is reconciled only with the **same** operation ID, filename, and identity within the controller's acceptance window, never by creating another ID. A running operation is not cancelled merely because automatic recovery was switched off. Interrupted, expired/unknown, and unconfirmed outcomes block further automatic work and are exposed through `files-inbox.receive.automatic` for inspection. The UI/manual recovery route remains available. After manual recovery, the journal clears only when the same-account final destination exists, its pending entry is gone, and the old operation is not reported running.

A successful copied file whose source cleanup still needs retry can be retried after a cooldown; the native receive implementation verifies the existing destination before deleting the source. Partial/deleted markers and files over the receive limit are not selected automatically. Unconfirmed errors conservatively block the queue; this is deliberate rather than silently claiming recovery is functioning.

**Integration dependency:** safe concurrent automatic/UI mutations require the shared backend mutation-admission guard, not merely `operation-start`'s receipt allocation lock. Do not ship this resident without that companion fix and overlap tests.

## Notification contract and limitations

The producer observes new names in native final, regular inbox entries under the current self identity, and new/changed daemon-buffered pending entries by name/size. Pending arrivals are observed even when automatic recovery is off and the final inbox directory does not exist. Pending notices explicitly mean awaiting receipt; they never claim completion. It ignores `.partial`/`.deleted`, and native enumeration excludes unsafe names and symlinks. First start, each resident restart, and account changes baseline existing files without broadcasting history. Failed/unavailable/locked scans preserve prior observations.

An observation is persisted atomically under root-private runtime state **before** its broadcast. Delivery is best-effort, at-most-once from this producer: there is no retry queue. Thus process crashes, app force-stop, disabled notifications, Android restrictions, and the baseline after downtime can lose notifications; later opt-in does not replay old notices. These notices describe newly observed completed inbox entries, not cryptographic proof that a network transfer occurred. Edits to metadata of an existing completed filename do not notify. A locally created new file can still look like an arrival, and same-name replacements between polls are not detected. A file arriving and disappearing between polls may not be observed.

Wire format:

```
am broadcast --user 0 --exclude-stopped-packages \
  -n dev.foxderin.tail/.ReceiveNotificationReceiver \
  -a dev.foxderin.tail.RECEIVED \
  --es event_id <SHA256, 64 lowercase hex> --ei count <1..10000> \
  --es kind <pending|completed>
```

The hash includes the event kind and a persisted observation generation so a later same-name/same-size arrival after disappearance is distinct. No filename, sender, contents, or path crosses the broadcast. The receiver is protected by `android.permission.DUMP`, additionally checks app preference/notification availability and deduplicates event IDs. Never include stopped packages. Broadcast success/acknowledgment does not prove a visible notification or file delivery.

## Verification scope

Host tests exercise actual shell config/default/hot-save behavior, private atomic state, first/account/restart baselines, failed scans, partial filtering, event flags/count/hash/dedup, large inbox snapshots without oversized argv, guarded mutations and same-ID journal reconciliation. Native receive tests cover final publication and source deletion ordering separately. Host tests are not Android hardware, daemon interoperability, unlock, Doze, force-stop, permission-prompt, or visual-notification delivery validation.

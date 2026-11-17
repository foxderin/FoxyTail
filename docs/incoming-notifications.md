# Incoming file notification bridge

This bridge does not receive bytes, recover pending files, poll an inbox, or run a foreground service. The module owns reception and discovery. The app only posts a notification for a pending or completed-file event when the user opted in and Android permits notifications.

## Wire contract

The module sends an explicit broadcast as root for Android user 0 (the module's shared `/sdcard` inbox):

```sh
am broadcast --user 0 --exclude-stopped-packages \
  -n dev.foxderin.tail/.ReceiveNotificationReceiver \
  -a dev.foxderin.tail.RECEIVED \
  --es kind pending \
  --es event_id '<64 lowercase hexadecimal characters>' --ei count 1
```

- `kind` is `pending` or `completed`; omitted means `completed` for compatibility. Unknown values are rejected. Pending means the daemon has a buffered file awaiting saving to the shared inbox, not successful receipt into that inbox. It is reported independently of automatic recovery being enabled. Completed means an observed final file in the inbox, not proof of its network origin. Partial files must never generate completed events.
- `event_id` identifies a stable event or batch and must include the kind in its identity; retries retain the same ID. `count` is the number of files in that event, from 1 to 10000, not a live total.
- Pending and completed use the same notification slot: completion replaces pending wording instead of leaving a stale pending notification. Updates use only-alert-once, so an existing notice is updated quietly; this also means later arrivals are quiet until the existing notice is dismissed. Both open the fixed inbox.
- The module must establish a baseline without announcing historical inbox files, including after monitor restart. The app keeps the latest 128 successfully posted event IDs across process death as additional replay suppression, not an unbounded exactly-once delivery ledger.
- The manifest requires `android.permission.DUMP` on the receiver. Ordinary apps cannot invoke it. This is not root-exclusive authentication: platform/system, privileged apps, and apps explicitly granted this development permission through adb are trusted too. The payload cannot open a supplied file, URI or command. Notifications contain only a count and open the app's fixed inbox page.
- No intent filter is registered; the component and action above must both match. Never use `--include-stopped-packages`, launch an Activity, or clear stopped state from the module to force delivery.
- Ordered result `1` means the receiver posted or had already recorded the event; `2` means the event was suppressed by the user preference or Android notification settings and must not be retried after opt-in; `0` means no such acknowledgement. Shell exit success, receiver acknowledgement, and actual user-visible display are different things. Do not describe any of them as file-receive success. Android/OEM delivery restrictions and force-stop can prevent notification.

## App preference

`files.receiveNotifications` accepts optional `enabled: boolean`; no argument reads the state. It returns `{ok:true, enabled:boolean, allowed:boolean}`. The same object is `files.snapshot.receiveNotifications` and is included in `files` events.

- `enabled` defaults to false and is the user's persistent preference.
- `allowed` separately reflects runtime POST_NOTIFICATIONS, app notification settings and incoming-channel importance. Enabling on Android 13+ requests permission if absent. The immediate reply may still be `allowed:false`; the permission callback publishes updated state.
- Disabling removes the current incoming notification. It does not stop direct daemon reception, disable buffered recovery, change page auto-refresh, or affect outgoing transfer notifications.
- Events received while disabled or blocked are not saved as delivered and do not cause the app to retry. The root event source owns discovery; there is no promise to replay events that occurred before opt-in or while force-stopped.
- The incoming channel/notification ID is separate from TransferService. No always-on dataSync service consumes the outgoing service's Android background-time budget.

## Verification boundary

Host tests cover the event shape, deduplication and bounded ledger; instrumentation checks the merged receiver permission/export/direct-boot contract. A device acceptance test must additionally check root delivery, denial from an ordinary third-party UID, notification permission denied/granted, channel disabled, duplicate event, pending while auto-receive is off, pending-to-completed wording/update, process death, force-stop/exclusion, unlock, and notification navigation while an outgoing job remains active. Compilation does not prove OEM background delivery.

Platform sources:
- [Broadcast receiver sender permissions](https://developer.android.com/develop/background-work/background-tasks/broadcasts#restrict-broadcasts-permissions)
- [DUMP protection declaration](https://android.googlesource.com/platform/frameworks/base/+/main/core/res/AndroidManifest.xml)
- [Root/system component permission handling](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/app/ActivityManager.java)
- [Exclude stopped packages](https://developer.android.com/reference/android/content/Intent#FLAG_EXCLUDE_STOPPED_PACKAGES)
- [Foreground service timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout)

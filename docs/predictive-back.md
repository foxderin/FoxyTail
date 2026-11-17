# Predictive Back boundary

The bundled WebUI owns its logical route stack and the existing Back priority:
visible dialog, visible menu/disclosure, previous route, parent/dashboard, exit.
It publishes `app.backState { canHandle: boolean }` after bootstrap and rendering,
and whenever routes or visible overlays change. The native bridge validates this
as a strict boolean. Unhydrated/reloaded documents conservatively intercept Back.
Native intents and lifecycle resume refresh the published state.

On Android 13+, ControlActivity registers its OnBackInvokedCallback only while
the WebUI can consume Back. At a hydrated dashboard with no history or visible
overlay it unregisters, letting Android own back-to-home/task handling and its
predictive animation. A dashboard reached through another route is not an empty
stack and still goes back through that route. Android 12 and earlier retain the
existing committed-Back fallback. The manifest already opts into the platform API.

No route or form state changes on gesture progress or cancellation: the in-app
callback still emits `back` only on invocation. This change does **not** implement
a preview between HTML pages or a custom progress animation. The root preview is
system-rendered, including system animation/accessibility preferences; WebUI
reduced-motion styling does not attempt to override that system animation.

Official references:
- https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture
- https://developer.android.com/guide/navigation/custom-back/support-animations-views

## Verification

Host smoke coverage checks empty root, root menu/dialog, back-stack draining,
returning to dashboard with existing history, same-root native intents, and no
premature Activity finish. Android instrumentation checks strict bridge arguments
and callback registration/unregistration, in addition to existing native Back
navigation/menu tests. Compiling the instrumentation APK does not run it.

Device validation remains required: Android 13/14 with predictive animations
enabled in developer options, Android 15+ gesture navigation, cancellation at
root and within dialogs, IME dismissal, three-button Back, external intent arrival,
and reduced/disabled system animations. No device animation result is claimed.

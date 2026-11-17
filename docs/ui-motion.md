# Interface motion

The WebUI uses a shared 120 ms feedback / 180 ms entrance rhythm with a decelerating easing curve. Motion is deliberately short and does not postpone an operation, focus, selection, Back, or navigation.

- Retained pages fade in when shown. Their wrapper is never transformed: dropdowns that escape clipping via fixed positioning keep the viewport coordinate system. Hidden pages leave layout and focus immediately; forms are not remounted for animation.
- Dropdowns enter with a 3 px offset. The select indicator changes emphasis while open, without rotating the two-way `unfold_more` glyph. Selection, Escape, outside click and Back close immediately.
- On phones the status sheet rises 12 px; desktop sheets use the compact popup entrance. Scrims fade independently. Dialog, task tray, toast and pending-action entrances share the same duration/easing tokens.
- `prefers-reduced-motion: reduce` is evaluated live by CSS. Decorative entrances and pressed-control scaling are disabled. Existing progress indicators retain their static reduced-motion fallback. No JavaScript preference cache or animation completion callback owns application state.

Verification: smoke tests exercise immediate dismissal/focus, Back ordering, retained-page identity and a single visible route without dispatching animation completion events. CSS contract checks are not pixel or computed-media verification. Check motion and the OS Reduce animations setting on an Android device before treating its visual timing as device-validated.

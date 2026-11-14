# Progress

## Milestones
- [x] M0 Scaffold (Tauri v2 + Vite + vanilla TS + CodeMirror 6, hidden window shown after first paint, timing, release profile, CSP)
- [x] M1 Notepad parity (tabs, files, encodings, line endings, session restore, find/replace, view, print)
- [x] M2 Look and effects (themes, effects engine, opacity + tint, fallbacks, --no-effects, temporary View menu)
- [ ] M3
- [ ] M4
- [ ] M5
- [ ] M6
- [ ] M7
- [ ] M8
- [ ] M9

## M0 results (release, Windows)
- exe: 3,257,344 bytes (3.1 MB) vs 10 MB budget: OK
- initial JS: 89.3 KB gzipped (274.5 KB raw) + 0.15 KB CSS vs 300 KB budget: OK
- startup, process start to editor ready / window shown (MYNOTE_TIMING=1):
  - run 1: 552 / 684 ms; run 2: 444 / 507 ms; run 3: 424 / 511 ms
  - Budget is 400 ms to a usable editor: NOT MET yet (about 510 ms to shown, 424-552 to ready). Mostly WebView2 init. To investigate in a later milestone.

## M1 results (release, Windows)
- exe: 3,486,208 bytes (3.3 MB; +0.2 MB for dialog plugin/serde) vs 10 MB: OK
- initial JS: 96.3 KB gzipped (293.8 KB raw) + 1.4 KB CSS; Find/Replace is a lazy chunk (6.6 KB gz) vs 300 KB: OK
- startup (3 clean runs, editor ready / shown): 462/536, 565/631, 509/569 ms. 400 ms budget still NOT MET (M0: 424-552 ready). Session load adds little; WebView2 init still dominates.
- Stress run (3 files incl. a 22 MB / 400k-line file via command line): editor ready at 789 ms, so roughly 250-300 ms of main-thread work to build that document. Read/decode runs in Rust off the UI thread and ships raw bytes; the document build is the blocking part. The 100 MB warning is a prompt (Open anyway / Cancel), not yet exercised with a real 100 MB file.
- Verified by driving the release exe over the WebView2 debug port: file open from args (UTF-16 LE, Windows-1252, UTF-8/LF detected per file), tab switching, dirty marker, Ctrl+H replace-all, Ctrl+G dialog, no console errors. NOT verified by hand: native open/save dialogs, drag-drop of files, tab drag reorder, middle-click, Ctrl+Tab (WebView2 may swallow it; Ctrl+PageUp/PageDown also work), print, close prompts, real session restore after restart.

## M2 results (release, Windows 11 build 26300)
- exe: 3,507,712 bytes (3.3 MB; +21 KB for window-vibrancy and registry/high-contrast reads) vs 10 MB: OK
- initial JS: 95.6 KB gzipped (296.6 KB raw, `gzip -9`) + 2.3 KB CSS; Find stays lazy (6.7 KB gz) vs 300 KB: OK
- startup, 4 warm runs, editor ready / shown: 436/499, 459/512, 436/492, 471/542 ms. No regression vs M1 (462-565 ready), but the 400 ms budget is still NOT MET. One cold first run after the build took 915/971 ms (new exe, first WebView2 start).
- Verified on the real release exe, Windows 11 build 26300 only (>= 22621, so Blur = Acrylic): default first launch is solid dark with effects Off (screenshot); Light and Dark via the View menu; Transparent at 50% with a vivid striped backdrop window behind it (stripes visible through the editor); Blur (Acrylic) dark and light, client area translucent. Theme/effect/opacity changes go through the real View menu and persist to settings.json.
- NOT verified by running: Windows 10, Windows 11 build 22000-22620 (Mica path), macOS, Linux (macOS and Linux code is written but never compiled here). Not run-tested either: the `--no-effects` flag, the Reduce effects switch, OS "Transparency effects" off and high-contrast fallbacks, and the on-focus re-check. Their decision logic is unit tested (`effects::decide`, 6 tests; settings parsing, 4 tests) and wired in `effects::apply`. A last screenshot pass with typed text over Transparent/Blur in both themes did not run (the app exited before capture), so text legibility over a busy backdrop at 50% was only looked at in the Transparent shot.

## Decisions (M2)
- Rust owns settings: `settings.json` in the app data dir (theme, effects, opacity 0.5-1.0, reduceEffects), written atomically, parsed per field so a bad file falls back to defaults. First launch: system theme, effects Off, opacity 0.85 (used only once effects are on). Commands `get_appearance` / `set_appearance` (sync, so they run on the main thread as macOS needs) return settings plus the real effect status (requested, active, backend, reason, support flags).
- Windows Blur backend, per the window-vibrancy docs: build >= 22621 Acrylic (system backdrop API); 22000-22620 Mica (Acrylic lags on 22000); Windows 10 Blur unsupported -> solid (Acrylic/blur lag on 1903+), Transparent still offered. The legacy `apply_blur` is never used (lags on 22621+). macOS: vibrancy (WindowBackground material). Linux: translucency only if GDK reports a compositor; no Blur.
- Fallback to solid with a recorded reason (`Status.reason`, shown in the View menu, printed with MYNOTE_TIMING=1): `--no-effects`, Reduce effects, high contrast, OS transparency effects off (Windows registry `EnableTransparency`), no compositor, blur unsupported, or an apply call returning an error. OS state is re-checked on window focus and theme change, and the frontend gets an `appearance-changed` event if the outcome changed.
- Reduce effects also turns off CSS transitions/animations (`html.reduce-fx`), like prefers-reduced-motion.
- Window is `transparent: true` in tauri.conf (required by window-vibrancy); solid mode gets an opaque window/webview background from Rust (`set_background_color`), effects get alpha 0 (WebView2 only honors 0 or 255). macOS needs the `macos-private-api` feature + `macOSPrivateApi` (no effect elsewhere).
- Opacity applies only to the background surfaces (`color-mix` on `--s-bg` / `--s-strip`), never to text. A separate fixed `#tint` layer (theme colour, 35% for Transparent, 15% for Blur) sits under the surfaces so text stays readable on any wallpaper. Menus, dialogs and the find panel are always opaque.
- Theme: CSS variables on `<html data-theme>`; Rust resolves System (window theme) and also sets the native title bar theme. Fonts are system stacks only. Tabs are browser style (rounded top, accent bar on the active tab, dividers) and only a newly opened tab animates (120 ms).
- Temporary View menu: `src/theme/viewmenu.ts` + the `#viewmenu` button in index.html + one line in app.ts. M3 deletes all three.
- New dependencies: `window-vibrancy` 0.8 (effects; ~21 KB in the exe total with the rest of M2). `windows-version` (direct, already in the tree via tao/window-vibrancy; OS build number), extra `windows-sys` features (registry, accessibility; already in tree), `gtk` 0.18 on Linux only (already in tree via tauri; compositor check).
- Tauri app data dir ignores the APPDATA env var on Windows, so test runs wrote to the real `%APPDATA%\com.example.mynote`. The test `settings.json` was deleted afterwards; `session.json` there holds an empty Untitled tab.

## Decisions
- Editor text is always `\n` in memory; encoding and line ending are per-tab metadata re-applied on save. Mixed line endings are normalized to the majority on save. New files default to UTF-8 + CRLF.
- Status-bar encoding / line-ending choice changes how the file is SAVED (marks tab dirty); it does not reload/reinterpret the file.
- File IPC uses raw byte bodies `[u32 BE meta len][meta JSON][payload]` (no JSON-escaping of 20 MB strings). Read/write/detect/dialog commands live in Rust `files`; session file in `config`.
- New dependencies: `tauri-plugin-dialog` (native open/save pickers, used from Rust only so no frontend permission; ~+0.2 MB), `serde`/`serde_json` (already in tree), `@codemirror/search` (commands + query only; own panel UI, lazy).
- Capabilities: only `core:event:allow-listen`/`unlisten` (drag-drop and close-requested events).
- Tab reorder uses pointer events (HTML5 drag-drop conflicts with Tauri file drop on Windows). New tab = Ctrl+N or Ctrl+T.
- Closing the last tab leaves a fresh Untitled tab (does not quit). No single-instance handling: "Open with" while running starts a second window.
- App close prompts per unsaved tab (as specified); "Don't save" discards that text, so unsaved text is restored only after a crash/kill/logoff. Session holds untitled and dirty text (up to 8 MB per tab); clean file tabs are re-read from disk lazily on first activation.
- Session written 1.5 s after the last change, in an idle callback, by Rust via temp file + rename.
- Print renders the full document text into a hidden `<pre>` (CodeMirror only renders the viewport).
- View menu items are shortcuts and clickable status-bar items: Alt+Z / "Wrap" toggles wrap, "100%" resets zoom.

## Decisions (M0)
- Scaffold via create-tauri-app (vanilla-ts), then renamed; bundle disabled (`--no-bundle` builds the exe only); icons are the scaffold defaults.
- Removed the opener plugin and `withGlobalTauri`; frontend uses `@tauri-apps/api` invoke only.
- Capability file has an empty permission list: app commands `editor_ready` and `show_window` need none.
- CSP is strict; `style-src` allows `'unsafe-inline'` because CodeMirror injects style elements. `connect-src` is IPC only.
- CodeMirror packages: state, view, commands (history, default keymap). No language, search or autocomplete.
- Dark theme only for now; window `backgroundColor` #1e1e1e matches the CSS `--bg`.
- Timing uses Windows process creation time (windows-sys, already in the tree); other platforms print "unavailable".
- Window is shown after two animation frames following editor creation.

## Next
- M3 (Settings UI): remove the temporary View menu, move theme/effects/opacity/Reduce effects into Settings.
- Open: re-run the text-legibility screenshots in both themes at 50%; test `--no-effects` and Reduce effects at runtime; try Windows 10 / 11 21H2 / macOS / Linux if available.


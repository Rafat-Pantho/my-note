# Progress

## Milestones
- [x] M0 Scaffold (Tauri v2 + Vite + vanilla TS + CodeMirror 6, hidden window shown after first paint, timing, release profile, CSP)
- [x] M1 Notepad parity (tabs, files, encodings, line endings, session restore, find/replace, view, print)
- [ ] M2
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
- M1 as assigned.


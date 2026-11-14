# Progress

## Milestones
- [x] M0 Scaffold (Tauri v2 + Vite + vanilla TS + CodeMirror 6, hidden window shown after first paint, timing, release profile, CSP)
- [ ] M1
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

## Decisions
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

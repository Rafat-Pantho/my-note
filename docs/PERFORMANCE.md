# Performance (M6)

> Update 2026-11-15: the window is now shown as soon as the editor is built (no two-frame wait), about 30 ms
> sooner; "editor ready" is unchanged. WebView2 also gets extra args that stop its own startup connections. See
> "Post-M9 fixes" in PROGRESS.md for numbers.

Measured on the release exe, Windows 11 build 26300, warm disk, 2026-11-15. One machine only; treat differences
under about 20 ms as noise (run-to-run spread here is 20-40 ms).

## Budgets

| Budget (CLAUDE.md) | Measured | Verdict |
|---|---|---|
| Cold start to usable editor, 400 ms or less | editor ready: median **399 ms** (388-411, 5 runs); window visible: median **441 ms** (432-455) | **Borderline / missed.** "Ready" sits on the line; the window the user actually sees is about 40 ms over. |
| Windows release exe, 10 MB or less | 6,010,368 bytes (5.7 MB) | OK |
| Initial JavaScript, 300 KB gzipped or less | 98.9 KB gzipped (index 8.4 + CodeMirror chunk 88.3 + appearance 2.2) + 2.5 KB CSS | OK |

Idle memory (6 s after launch, whole process tree = My Note + 6 WebView2 processes): about **372 MB working set,
about 205 MB private**. With `--disable-gpu`: about 330 MB / **105 MB private**.

### Startup: the 400 ms budget is not reliably met

Timeline, medians of the final 5 runs (ms since process start, `MYNOTE_TIMING=1`):

| Step | ms |
|---|---|
| `run()` entered | 10 |
| Tauri `setup` starts (the WebView2 environment and browser process are created before it) | 341 |
| Page starts (navigation start, derived: ready minus the page's own marks) | about 330 |
| Page: script evaluated, `boot()` begins | +49 |
| Page: settings, launch args and session received | +18 |
| Page: tab activated, editor built | +5 |
| **editor ready** | **399** |
| window shown (two animation frames, then `show_window`) | 441 |

Top three causes of the miss (measured to the visible window, 441 ms):
1. **WebView2 start-up, about 320 ms of the 441.** It happens inside Tauri/wry before our setup code runs (`run()` is
   entered at 10 ms, `setup` at 341 ms). None of our code runs during it. WebView2 flags I tried
   (`--in-process-gpu`; `--disable-background-networking --disable-component-update --disable-sync --no-pings`)
   made no difference.
2. **Ready to visible, about 40-50 ms.** `show_window` runs after two animation frames and `Window::show` on a
   transparent window is slow. With `--disable-gpu` this gap shrinks to about 15 ms.
3. **Page boot, about 70 ms:** parsing and evaluating the 276 KB (raw) CodeMirror chunk (about 49 ms before `boot()`
   runs) plus three parallel IPC round trips (about 18 ms).

The budget was not relaxed. A decision for you: running WebView2 with `--disable-gpu` by default would bring the
visible-window median to about 398 ms (5 runs: 379-456) and cut private memory by about 100 MB. It measured smooth
(below), but it changes rendering for everyone, so it is **not** applied.

## What changed in M6

- **Session restore no longer blocks the first paint for big sessions.** A session file over 256 KB (megabytes of
  unsaved text) is not sent with the first request: Rust answers with one marker byte and the page fetches and parses
  the file after the window is shown. Test: 3 unsaved tabs of 6 MB each (19 MB session file): editor ready
  **550 ms to about 375 ms**. Small sessions are unchanged (they arrive with the settings, in parallel, with no flash of
  an empty tab). While a late restore is pending the session is never written (the saved one cannot be overwritten),
  and closing waits for the restore. If the user already typed into the placeholder tab, the restored tabs go before
  it and nothing is lost; if it is still blank it is replaced. Verified: the 19 MB session came back intact (3 tabs,
  6,291,450 characters each) and was saved again. **Not verified:** the typed-before-restore merge on the real app (it
  needs a hand-timed race). A Rust unit test covers the size gate.
- **MYNOTE_TIMING=1 now also prints** `run`, `setup start/done` and a page breakdown (`boot`, `ipc`, `active`, ms
  since navigation start). Nothing is printed otherwise.
- Nothing else needed changing: startup makes only three IPC calls, in parallel (`load_session`, `take_launch_args`,
  `get_settings`); fonts are system stacks only (no font file, no `@font-face`); everything non-critical (listeners,
  wheel / context-menu handlers, drag-drop) is registered after the editor is built.

## Initial bundle contents

From `dist/index.html`, the only scripts fetched at start are `index`, `dist` (CodeMirror state / view / commands) and
`appearance` (modulepreload). **Not** loaded at startup (lazy chunks): settings 4.5 KB gz + panel 2.1 + CSS, AI
controller / menu 9.1 KB gz + CSS, word diff 0.8, AI api 0.6, find / replace 6.6. Checked in the Vite output and
`dist/index.html`, and on the running exe in M5.

## WebView2 user data folder

`%LOCALAPPDATA%\com.example.mynote\EBWebView` (Tauri's default: local, not roaming, not a network path). 125 MB after
use (caches and component data that WebView2 creates). It is separate from `%APPDATA%\com.example.mynote`
(`config.json`, `session.json`). Nothing to change; it should stay on a local disk.

## No-GPU test (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu`)

Confirmed active over the debug port (`SystemInfo.getInfo`): `gpu_compositing` and `rasterization` are
`disabled_software`, renderer "Microsoft Basic Render Driver". Driven by real input events over the DevTools protocol;
this display runs at about 164 Hz (frame interval 6.1 ms):

| Action | Result |
|---|---|
| Typing, 300 keystrokes into an empty note | key to painted frame: p50 12.1 ms, p95 13.5 ms, max 18.8 ms (about 2 frames); 0 long tasks |
| Scrolling a 15,000-line document (about 1 MB), 120 wheel events | every frame 6.1-6.4 ms; 0 long tasks |
| Switching between 6 tabs, 24 switches | click to painted: p50 12 ms, max 13.6 ms; 0 long tasks |
| Effects: Blur (Acrylic), Transparent, Off, Blur + Reduce effects | as requested; Reduce effects falls back to solid with the reason "Reduce effects is on". Acrylic and Transparent come from Windows, not WebView2's GPU path |

Blur with and without the GPU looked the same in a window capture. Startup with `--disable-gpu` (5 runs): ready
361-439 ms (median 381), visible 379-456 ms (median 398).

Not tested: a slow or CPU-throttled machine (this one is fast), 4K or multiple monitors, the OS "Transparency effects"
toggle, a document pasted with the real clipboard (the test pasted by event).

## How to reproduce

```powershell
npm run tauri -- build --no-bundle      # exe: src-tauri\target\release\my-note.exe
powershell -NoProfile -File docs\measure-startup.ps1 -Runs 5
powershell -NoProfile -File docs\measure-startup.ps1 -Runs 5 -WebViewArgs "--disable-gpu"
```

- Startup: the script launches the exe with `MYNOTE_TIMING=1`, redirects stdout, waits 6 s, reads memory for the whole
  process tree, then kills it. Take the median of "editor ready" and "window shown". Discard the first launch after a
  rebuild (cold WebView2, antivirus scan). The process-tree sum can occasionally pick up stray processes (one run showed
  228 processes): ignore a memory figure with an odd process count.
- Exe size: `ls -l src-tauri/target/release/my-note.exe`.
- Initial JS: after `npm run build`, `grep -oE 'assets/[^"]+\.js' dist/index.html`, then `gzip -9 -c <file> | wc -c` for
  each and add them. Confirm the lazy chunks (settings, controller, diff, api, find, panel) are not in that list.
- Big session: write a `session.json` into `%APPDATA%\com.example.mynote` (back up the real one first) with a few
  untitled dirty tabs holding several MB of `text` each; the `page marks` line then says `(session late)`.
- Smoothness: launch with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--disable-gpu --remote-debugging-port=9222"` and drive
  the page over the DevTools protocol (`Input.dispatchKeyEvent`, `Input.dispatchMouseEvent` wheel) while a
  `requestAnimationFrame` loop and a `longtask` PerformanceObserver record frame times. The script was throwaway and is
  not kept.

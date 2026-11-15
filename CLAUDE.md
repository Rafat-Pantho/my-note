# My Note

Fast, modern, cross-platform notepad with optional local or remote AI.
Stack: Tauri v2 (Rust backend) + vanilla TypeScript + Vite + CodeMirror 6.
No React, Vue, Svelte or other UI framework.

## Priorities (in order)
1. Fast startup and small download. 2. Features. 3. Modern look.
Budgets (report real numbers, never silently relax them):
- Cold start to a usable editor: 400 ms or less on a mid-range laptop.
- Windows release exe: 10 MB or less.
- Initial JavaScript: 300 KB gzipped or less. Settings, AI and diff code are lazy-loaded chunks.

## Non-negotiable rules
- The app works fully with no AI, no network, no GPU and no blur. Those are optional layers; the editor core never depends on them.
- At startup: no network calls, no process spawning, no AI probing.
- Never install or launch anything for the user (no Ollama install, no model pulls).
- AI is OFF until the user turns it on. Ollama detection is a file-existence check of known install paths only. Ask consent before any connection. If denied, never connect, remember the choice, and let the user change it in Settings. Remote APIs: connect only after the user enters a key and approves the host shown.
- API keys live in the OS keychain (keyring crate). Never in config files, logs, or the frontend after saving.
- Text leaves the machine only on an explicit user action. The status bar always shows the active AI environment and whether it is local or remote.
- AI never edits the document directly. Results go to a preview. Accept applies them as one undoable change and records a snapshot in the rollback history.
- Scope rule: if text is selected, AI works on the selection; otherwise on the whole file. Always show which.
- Effects: transparency and blur are optional (window-vibrancy crate), with a solid fallback, a Reduce effects setting, a --no-effects flag, and automatic fallback if the OS or the call fails.
- Everything else should behave like Windows Notepad.
- Markdown preview: sanitize all rendered HTML (no raw HTML, no scripts, no remote images by default). Open links only in the system browser after a confirm, and only for http, https and mailto. The strict CSP stays.
- Spell check, Markdown, tables and preview are lazy-loaded and cost nothing unless the file type or a setting needs them.

## Code rules
- TypeScript strict. cargo fmt and cargo clippy clean.
- Rust modules in src-tauri/src: config, files, ai, effects, keychain. Frontend folders in src: editor, tabs, settings, ai, theme.
- The frontend never makes network requests. All HTTP happens in Rust. Keep Tauri capabilities minimal.
- A new dependency needs a one-line justification and its size cost.
- Add tests for pure logic: encoding, line endings, selection scope, rollback, stream parsers.

## Workflow
- At session start read only this file and PROGRESS.md. Do not re-read the whole repo.
- Do only the milestone you are given. Update PROGRESS.md after each sub-step (done, decisions, next).
- Keep replies short. Commit at the end of the milestone with a clear message, then stop.
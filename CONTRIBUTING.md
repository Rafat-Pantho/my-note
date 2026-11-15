# Contributing to My Note

Thanks for helping. Keep changes small and focused.

## Setup

Requirements: Node.js (LTS), Rust (stable), and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
npm ci
npm run tauri dev
```

## Tests and checks

Run these before opening a pull request. CI runs the same checks.

```bash
npm test                          # tsc (test config) + Node tests for pure logic
npx tsc                           # strict TypeScript check
npx vite build                    # frontend build
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Add tests for pure logic: encoding, line endings, selection scope, rollback, and stream parsers.

## Rules

These come from `CLAUDE.md` and apply to every change.

- **Works offline.** The app must work fully with no AI, no network, no GPU and no blur. The editor core never depends on those.
- **No network at startup**, no process spawning, no AI probing.
- **Never install or launch anything for the user** (no Ollama install, no model pulls).
- **AI is off until the user turns it on.** Ask consent before any connection. If denied, never connect.
- **API keys live in the OS keychain** (the `keyring` crate). Never in config files, logs or the frontend after saving.
- **Text leaves the machine only on an explicit user action.**
- **AI never edits the document directly.** Results go to a preview; Accept is one undoable change and records a rollback snapshot.
- **Scope:** if text is selected, AI works on the selection; otherwise on the whole file. Always show which.
- **Effects are optional** and have a solid fallback.
- **Code layout:** Rust modules in `src-tauri/src` are `config`, `files`, `ai`, `effects`, `keychain`. Frontend folders in `src` are `editor`, `tabs`, `settings`, `ai`, `theme`.
- **The frontend makes no network requests.** All HTTP happens in Rust. Keep Tauri capabilities minimal.
- **TypeScript strict.** `cargo fmt` and `cargo clippy` clean.
- **New dependencies** need a one-line justification and their size cost in the pull request.

## Budgets

Report real numbers in the pull request if a change could affect them:

- Cold start to a usable editor: 400 ms or less on a mid-range laptop.
- Windows release exe: 10 MB or less.
- Initial JavaScript: 300 KB gzipped or less.

## Pull requests

- Describe what changed and why.
- Note which checks you ran and their results.
- Update `PROGRESS.md` when you finish a milestone or sub-step.

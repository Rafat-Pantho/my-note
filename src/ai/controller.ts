/** AI actions: the menu, the streaming preview, accepting a result and the rollback history. One lazy chunk,
 *  loaded the first time the user opens the AI menu (never at startup).
 *
 *  Rules kept here:
 *  - The document is never touched while a result streams or waits in the preview. Only Accept changes it,
 *    as ONE transaction (one Ctrl+Z), and records a snapshot in the tab's rollback history.
 *  - Text is sent only when the user picks an action, to the environment whose host they allowed.
 *  - Cancel is visible at every stage; nothing is applied by cancelling. */
import "./ai.css";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { modal } from "../editor/dialog";
import type { Tab } from "../tabs/tabs";
import { appearance } from "../theme/appearance";
import { type ActionId, type ActionRun, type RunOptions, expectedOutputTokens, makeRun } from "./actions";
import * as api from "./api";
import { type Placement, changeSpec, planChange } from "./apply";
import type { DiffOp } from "./diff";
import { type Entry, RollbackHistory } from "./history";
import { showActionMenu } from "./menu";
import { ThinkStripper, cleanResult, matchWhitespace } from "./output";
import { buildMessages, promptTokens } from "./prompts";
import { blockedReason, destination } from "./ready";
import { type Scope, isStale, mapRange, resolveScope } from "./scope";
import { checkContext, estimateTokens } from "./tokens";
import type { ActiveEnv, StreamEvent } from "./types";

export interface AiHost {
  view(): EditorView;
  /** The active tab. */
  tab(): Tab;
  /** The active tab is a document (not Settings). */
  isDocTab(): boolean;
  openSettings(section: string): void;
  /** A short message in the status bar. */
  flash(text: string): void;
}

export interface AiController {
  openMenu(at?: HTMLElement | { x: number; y: number }): void;
  /** Runs a built-in action straight away (right-click quick actions). */
  runQuick(id: ActionId): void;
  showHistory(): void;
  /** Call for every editor update of the active tab. */
  onUpdate(u: ViewUpdate): void;
  /** Call when another tab becomes active: a pending result belongs to the old tab and is discarded. */
  onTabChange(next: Tab): void;
}

type Phase = "streaming" | "ready" | "error";

interface Session {
  tab: Tab;
  run: ActionRun;
  scope: Scope;
  /** Where the sent text is now (followed through edits). */
  range: { from: number; to: number };
  /** The text that was sent. */
  original: string;
  env: ActiveEnv;
  messages: ReturnType<typeof buildMessages>;
  opts: { maxTokens: number; numCtx?: number };
  phase: Phase;
  requestId: string;
  token: number;
  stripper: ThinkStripper;
  /** Streamed text so far (reasoning removed). */
  raw: string;
  /** The cleaned final result, once done. */
  result: string;
  truncated: boolean;
  error: string | null;
  /** The source text changed while the result was pending. */
  stale: boolean;
  view: "result" | "diff";
}

interface Btn {
  label: string;
  run: () => void;
  primary?: boolean;
  title?: string;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

const MAX_DIFF_CHARS = 400_000;
const MAX_REPLY_TOKENS = 8192;

/** Fills `into` with a word diff of `a` -> `b` (deleted text struck through, inserted text highlighted). */
async function renderDiff(into: HTMLElement, a: string, b: string, summary?: HTMLElement): Promise<void> {
  if (a.length + b.length > MAX_DIFF_CHARS) {
    into.replaceChildren(h("p", "aip-note", "This text is too large to compare word by word."));
    return;
  }
  const { diffWords, diffStats } = await import("./diff");
  const ops: DiffOp[] = diffWords(a, b);
  const frag = document.createDocumentFragment();
  for (const o of ops) {
    if (o.t === "eq") frag.append(o.s);
    else frag.append(h(o.t === "del" ? "del" : "ins", "", o.s));
  }
  const pre = h("pre", "aip-diff-text");
  pre.append(frag);
  into.replaceChildren(pre);
  if (summary) {
    const s = diffStats(ops);
    summary.textContent = a === b ? "No changes." : `+${s.added} word${s.added === 1 ? "" : "s"}, -${s.removed} word${s.removed === 1 ? "" : "s"}`;
  }
}

export function createController(host: AiHost): AiController {
  const histories = new WeakMap<Tab, RollbackHistory>();
  const historyOf = (tab: Tab) => {
    let hst = histories.get(tab);
    if (!hst) histories.set(tab, (hst = new RollbackHistory()));
    return hst;
  };

  let session: Session | null = null;
  let historyOpen: { selected: number | null } | null = null;
  let runToken = 0;
  /** True while our own transaction is being applied (it must not count as "the user edited"). */
  let applying = false;

  /* ---------- panel shell ---------- */

  let root: HTMLElement | null = null;
  let head!: HTMLElement;
  let statusEl!: HTMLElement;
  let body!: HTMLElement;
  let foot!: HTMLElement;
  let textEl!: HTMLPreElement;
  let textNode!: Text;
  let diffEl!: HTMLElement;

  function ensurePanel(): HTMLElement {
    if (root) return root;
    root = h("div");
    root.id = "aipanel";
    root.hidden = true;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "AI");
    head = h("div", "aip-head");
    statusEl = h("div", "aip-status");
    body = h("div", "aip-body");
    foot = h("div", "aip-foot");
    root.append(head, statusEl, body, foot);
    document.getElementById("app")!.insertBefore(root, document.getElementById("statusbar"));
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (session?.phase === "streaming") cancel();
      else closePanel();
    });
    return root;
  }

  function status(kind: "info" | "warn" | "err", text: string) {
    statusEl.className = `aip-status ${kind}`;
    statusEl.textContent = text;
    statusEl.hidden = !text;
  }

  function buttons(list: Btn[]) {
    foot.replaceChildren(
      ...list.map((b) => {
        const e = h("button", b.primary ? "aip-btn primary" : "aip-btn", b.label);
        e.type = "button";
        if (b.title) e.title = b.title;
        e.onclick = b.run;
        return e;
      }),
    );
  }

  function closePanel() {
    session = null;
    historyOpen = null;
    if (root) root.hidden = true;
    host.view().focus();
  }

  /** Stops a running request (the connection is closed, so the server stops too) and closes the panel. */
  function cancel() {
    const s = session;
    if (s?.phase === "streaming") void api.cancelChat(s.requestId).catch(() => undefined);
    closePanel();
  }

  /* ---------- menu ---------- */

  function openMenu(at?: HTMLElement | { x: number; y: number }) {
    if (!host.isDocTab()) return;
    const view = host.view();
    const scope = resolveScope(view.state.doc, view.state.selection.main);
    const anchor = at ?? document.getElementById("aibtn") ?? { x: 100, y: 100 };
    const show = (presets: { id: string; name: string; instruction: string }[]) =>
      showActionMenu({
        at: anchor,
        scopeLabel: scope.label,
        blocked: blockedReason(appearance()?.ai),
        emptyText: scope.text.trim() === "",
        presets,
        historyCount: historyOf(host.tab()).entries.length,
        onRun: (id, opts) => void runAction(id, opts),
        onHistory: showHistory,
        onSettings: () => host.openSettings("ai"),
        onClose: () => view.focus(),
      });
    // Saved presets come from Rust's config; reading them makes no network request.
    api.getAi().then((v) => show(v.presets), () => show([]));
  }

  function runQuick(id: ActionId) {
    void runAction(id, {});
  }

  /* ---------- running an action ---------- */

  async function runAction(id: ActionId, opts: RunOptions): Promise<void> {
    let run: ActionRun;
    try {
      run = makeRun(id, opts);
    } catch (e) {
      host.flash((e as Error).message);
      return;
    }
    const ai = appearance()?.ai;
    if (blockedReason(ai) || !ai?.env) {
      openMenu(); // shows the reason and how to fix it
      return;
    }
    const env = ai.env;
    const view = host.view();
    const tab = host.tab();
    const scope = resolveScope(view.state.doc, view.state.selection.main);
    if (run.def.needsText && scope.text.trim() === "") {
      host.flash("Nothing to work on: it is empty. Type or select some text first.");
      return;
    }

    const messages = buildMessages(run, scope.text);
    const reply = expectedOutputTokens(run.def, estimateTokens(scope.text));
    const check = checkContext(env.kind, env.local, promptTokens(messages) + reply);
    if (check.exceeds) {
      const r = await modal({
        message:
          `${scope.label} is about ${check.need.toLocaleString("en-US")} tokens with the reply, and ${env.name} (${env.model}) is assumed to handle about ${check.limit.toLocaleString("en-US")}. ` +
          `The model may refuse it or silently ignore part of the text. Nothing is cut off by My Note.\n\nSend it anyway to ${destination(env)}?`,
        buttons: ["Don't send", "Send anyway", "Cancel"],
      });
      if (r.button !== "Send anyway") return;
      // The document could have been edited while the dialog was open.
      const again = resolveScope(view.state.doc, view.state.selection.main);
      if (again.text !== scope.text || again.from !== scope.from) {
        host.flash("The text changed while you were deciding. Run the action again.");
        return;
      }
    }

    discard();
    const s: Session = {
      tab,
      run,
      scope,
      range: { from: scope.from, to: scope.to },
      original: scope.text,
      env,
      messages,
      opts: { maxTokens: Math.min(MAX_REPLY_TOKENS, Math.max(1024, reply)), numCtx: check.numCtx },
      phase: "streaming",
      requestId: "",
      token: 0,
      stripper: new ThinkStripper(),
      raw: "",
      result: "",
      truncated: false,
      error: null,
      stale: false,
      view: "result",
    };
    session = s;
    openSessionPanel(s);
    begin(s);
  }

  /** Drops any current preview or running request without touching the document. */
  function discard() {
    const s = session;
    if (s?.phase === "streaming") void api.cancelChat(s.requestId).catch(() => undefined);
    session = null;
    historyOpen = null;
  }

  function begin(s: Session) {
    s.phase = "streaming";
    s.raw = "";
    s.result = "";
    s.error = null;
    s.truncated = false;
    s.view = "result";
    s.stripper = new ThinkStripper();
    s.requestId = api.newRequestId();
    const token = ++runToken;
    s.token = token;
    textNode.data = "";
    renderSession(s);
    api
      .streamChat(s.env.id, s.requestId, s.messages, (ev) => onEvent(s, token, ev), {
        maxTokens: s.opts.maxTokens,
        numCtx: s.opts.numCtx,
      })
      .catch((e) => fail(s, token, String(e)));
  }

  const live = (s: Session, token: number) => session === s && s.token === token && s.phase === "streaming";

  function onEvent(s: Session, token: number, ev: StreamEvent) {
    if (!live(s, token)) return;
    switch (ev.event) {
      case "chunk": {
        const shown = s.stripper.push(ev.text);
        if (shown) {
          s.raw += shown;
          textNode.appendData(shown);
        }
        status("info", streamingNote(s));
        break;
      }
      case "done": {
        const tail = s.stripper.end();
        if (tail) s.raw += tail;
        finish(s, ev.truncated);
        break;
      }
      case "error":
        fail(s, token, ev.message);
        break;
      case "cancelled":
        break; // we asked for it; the panel is already closed
    }
  }

  const streamingNote = (s: Session) =>
    s.stripper.thinking && !s.raw
      ? `The model is thinking... (${destination(s.env)})`
      : `Receiving the result from ${destination(s.env)}. Your document has not been changed.`;

  function fail(s: Session, token: number, message: string) {
    if (session !== s || s.token !== token) return;
    s.phase = "error";
    s.error = message;
    renderSession(s);
  }

  function finish(s: Session, truncated: boolean) {
    const result = cleanResult(s.raw, s.original);
    if (result.trim() === "") {
      s.phase = "error";
      s.error = s.raw.trim() === "" ? "The model returned no text." : "The model returned only whitespace.";
      renderSession(s);
      return;
    }
    s.result = result;
    s.truncated = truncated;
    s.phase = "ready";
    textNode.data = result;
    renderSession(s);
  }

  /* ---------- the preview panel ---------- */

  function openSessionPanel(s: Session) {
    ensurePanel().hidden = false;
    body.className = "aip-body";
    textEl = h("pre", "aip-text");
    textNode = document.createTextNode("");
    textEl.append(textNode);
    diffEl = h("div", "aip-diff");
    diffEl.hidden = true;
    body.replaceChildren(textEl, diffEl);
    renderSession(s);
  }

  function envBadge(env: ActiveEnv): HTMLElement {
    const b = h("span", `aip-badge ${env.local ? "local" : "remote"}`);
    b.textContent = `${env.local ? "Local" : "Remote"} · ${env.name}${env.model ? ` · ${env.model}` : ""}`;
    b.title = `Text goes to ${destination(env)}`;
    return b;
  }

  function renderSession(s: Session) {
    if (session !== s) return;
    // header
    const parts: HTMLElement[] = [h("strong", "aip-title", s.run.title), h("span", "aip-badge", s.scope.label), envBadge(s.env), h("span", "aip-spacer")];
    if (s.phase === "ready" && s.run.def.diff) {
      for (const v of ["result", "diff"] as const) {
        const t = h("button", `aip-tab${s.view === v ? " on" : ""}`, v === "result" ? "Result" : "Changes");
        t.type = "button";
        t.onclick = () => showView(s, v);
        parts.push(t);
      }
    }
    const x = h("button", "aip-x", "×");
    x.type = "button";
    x.title = s.phase === "streaming" ? "Cancel" : "Reject and close";
    x.setAttribute("aria-label", x.title);
    x.onclick = () => (s.phase === "streaming" ? cancel() : closePanel());
    parts.push(x);
    head.replaceChildren(...parts);

    textEl.hidden = s.view !== "result";
    diffEl.hidden = s.view !== "diff";

    // status line and buttons by phase
    if (s.phase === "streaming") {
      status("info", streamingNote(s));
      buttons([{ label: "Cancel", run: cancel, primary: true, title: "Stop and discard" }]);
    } else if (s.phase === "error") {
      status("err", s.error ?? "Something went wrong.");
      const list: Btn[] = [
        { label: "Try again", run: () => begin(s), primary: true },
        { label: "Close", run: closePanel },
      ];
      if (/Settings > AI/.test(s.error ?? "")) list.splice(1, 0, { label: "Open AI settings", run: () => host.openSettings("ai") });
      buttons(list);
    } else {
      renderReady(s);
    }
  }

  function renderReady(s: Session) {
    const notes: string[] = [];
    if (s.truncated) notes.push("The model stopped at its output limit, so this result is incomplete.");
    if (s.stale) notes.push("The text changed while the result was pending, so it can no longer replace it. You can insert it at the cursor or copy it.");
    if (notes.length) status("warn", notes.join(" "));
    else status("info", "Your document has not been changed. Review the result, then choose.");

    const list: Btn[] = [];
    const word = s.scope.kind === "selection" ? "selection" : "file";
    if (s.stale) {
      list.push({ label: "Insert at cursor", run: () => accept(s, "cursor"), primary: true });
    } else {
      const label: Record<Exclude<Placement, "cursor">, string> = {
        replace: `Replace ${word}`,
        below: "Insert below",
        append: s.scope.kind === "selection" ? "Insert after selection" : "Insert at end of file",
      };
      const apply = s.run.def.apply;
      const order: Exclude<Placement, "cursor">[] = apply === "replace" ? ["replace", "below"] : apply === "below" ? ["below", "replace"] : ["append", "below"];
      order.forEach((p, i) => list.push({ label: label[p], run: () => accept(s, p), primary: i === 0 }));
    }
    list.push({ label: "Copy", run: () => void copy(s), title: "Copy the result to the clipboard" });
    list.push({ label: "Regenerate", run: () => begin(s), title: "Ask again with the same text" });
    list.push({ label: "Reject", run: closePanel, title: "Close without changing the document" });
    buttons(list);
    (foot.querySelector(".primary") as HTMLElement | null)?.focus();
  }

  function showView(s: Session, v: "result" | "diff") {
    if (session !== s) return;
    s.view = v;
    renderSession(s);
    if (v === "diff") {
      const shown = matchWhitespace(s.result, s.original);
      const summary = h("div", "aip-summary");
      const holder = h("div");
      diffEl.replaceChildren(summary, h("p", "aip-note", "Comparing..."));
      void renderDiff(holder, s.original, shown, summary).then(() => {
        if (session === s && s.view === "diff") diffEl.replaceChildren(summary, holder);
      });
    }
  }

  async function copy(s: Session) {
    try {
      await navigator.clipboard.writeText(s.result);
      host.flash("Copied the result.");
    } catch {
      host.flash("Could not copy. Select the text in the preview and press Ctrl+C.");
    }
  }

  /* ---------- accept ---------- */

  function accept(s: Session, placement: Placement) {
    if (session !== s || s.phase !== "ready") return;
    const view = host.view();
    const doc = view.state.doc;
    if (host.tab() !== s.tab) return;
    const stale = isStale(s.scope.kind, doc, s.range, s.original);
    if (stale && placement !== "cursor") {
      s.stale = true;
      renderSession(s);
      return;
    }
    const range = s.scope.kind === "file" ? { from: 0, to: doc.length } : s.range;
    const text = placement === "replace" ? matchWhitespace(s.result, s.original) : s.result;
    const plan = planChange(doc, range, placement, text, view.state.selection.main.head);
    const before = doc.sliceString(plan.from, plan.to);

    applying = true;
    try {
      view.dispatch(changeSpec(plan, "input.ai")); // one transaction: one Ctrl+Z
    } finally {
      applying = false;
    }
    const added = historyOf(s.tab).add({
      action: s.run.title,
      time: Date.now(),
      scope: s.scope.kind,
      scopeLabel: s.scope.label,
      from: plan.from,
      to: plan.from + plan.insert.length,
      before,
      after: plan.insert,
    });
    closePanel();
    host.flash(
      added.skipped
        ? `${s.run.title}: applied. Too large for the rollback history; Ctrl+Z still undoes it.`
        : `${s.run.title}: applied. Ctrl+Z undoes it, or use Rollback history.`,
    );
  }

  /* ---------- editor updates ---------- */

  function onUpdate(u: ViewUpdate) {
    if (!u.docChanged) return;
    const tab = host.tab();
    const hist = histories.get(tab);
    if (hist) {
      // Undo/redo rewrite exactly the text an entry points at, so such entries can no longer be followed.
      if (u.transactions.some((tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo"))) hist.detachTouching(u.changes);
      hist.map(u.changes);
    }
    const s = session;
    if (!s || s.tab !== tab || applying) return;
    s.range = mapRange(s.range, u.changes);
    const stale = isStale(s.scope.kind, u.state.doc, s.range, s.original);
    if (stale !== s.stale) {
      s.stale = stale;
      if (s.phase === "ready") renderSession(s);
    }
  }

  function onTabChange(next: Tab) {
    document.querySelector(".aimenu")?.remove();
    const s = session;
    if (s && s.tab !== next) {
      const had = s.phase === "streaming" || s.phase === "ready";
      cancel();
      if (had) host.flash("AI result discarded because you switched tabs.");
    } else if (historyOpen) closePanel();
  }

  /* ---------- rollback history ---------- */

  function showHistory() {
    if (!host.isDocTab()) return;
    discard();
    const tab = host.tab();
    historyOpen = { selected: null };
    ensurePanel().hidden = false;
    renderHistory(tab);
  }

  const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  function renderHistory(tab: Tab) {
    const hist = historyOf(tab);
    const entries = [...hist.entries].reverse(); // newest first
    const open = historyOpen!;
    head.replaceChildren(h("strong", "aip-title", "Rollback history"), h("span", "aip-badge", `${entries.length} in this tab`), h("span", "aip-spacer"));
    const x = h("button", "aip-x", "×");
    x.type = "button";
    x.title = "Close";
    x.setAttribute("aria-label", "Close");
    x.onclick = closePanel;
    head.append(x);
    status("info", "Each entry is an AI change you accepted in this tab. Restoring puts the old text back and can itself be undone with Ctrl+Z.");

    const list = h("div", "aip-list");
    const detail = h("div", "aip-detail");
    body.className = "aip-body split";
    body.replaceChildren(list, detail);
    if (!entries.length) {
      list.append(h("p", "aip-note", "No AI changes have been accepted in this tab yet."));
      buttons([{ label: "Close", run: closePanel, primary: true }]);
      return;
    }
    if (open.selected === null || !hist.get(open.selected)) open.selected = entries[0].id;

    for (const e of entries) {
      const row = h("button", `aip-item${e.id === open.selected ? " on" : ""}`);
      row.type = "button";
      row.append(h("span", "aip-item-t", `${fmtTime(e.time)} · ${e.action}`), h("span", "aip-item-s", e.restored ? `${e.scopeLabel} · rolled back` : e.detached ? `${e.scopeLabel} · undone with Ctrl+Z` : e.scopeLabel));
      row.onclick = () => {
        open.selected = e.id;
        renderHistory(tab);
      };
      list.append(row);
    }
    const sel = hist.get(open.selected)!;
    detail.append(h("div", "aip-summary"), h("div", "aip-diff"));
    void showEntryDiff(detail, sel);

    const unavailable = sel.restored ? "Already rolled back" : sel.detached ? "Undone with Ctrl+Z" : null;
    const restore: Btn = {
      label: unavailable ?? "Restore this version",
      run: () => void restoreEntry(tab, sel),
      primary: !unavailable,
      title: unavailable ? "Nothing to restore: this change is no longer in the document" : "Put the text from before this change back",
    };
    buttons([restore, { label: "Close", run: closePanel }]);
    const restoreBtn = foot.querySelector("button") as HTMLButtonElement | null;
    if (restoreBtn && unavailable) restoreBtn.disabled = true;
  }

  async function showEntryDiff(detail: HTMLElement, e: Entry) {
    const summary = detail.querySelector(".aip-summary") as HTMLElement;
    const holder = detail.querySelector(".aip-diff") as HTMLElement;
    summary.textContent = "Comparing...";
    await renderDiff(holder, e.before, e.after, summary);
    if (e.before === "") summary.textContent = `Inserted text. ${summary.textContent}`;
  }

  async function restoreEntry(tab: Tab, e: Entry) {
    const view = host.view();
    if (host.tab() !== tab) return;
    const hist = historyOf(tab);
    const plan = hist.planRestore(e.id, view.state.doc);
    if (!plan) return;
    if (plan.lostEdits) {
      const r = await modal({
        message:
          "The text from this AI change was edited afterwards, or replaced by a later change. Restoring puts the old version back and the edits made to it since are lost.\n\nYou can still bring them back with Ctrl+Z. Restore anyway?",
        buttons: ["Don't restore", "Restore anyway", "Cancel"],
      });
      if (r.button !== "Restore anyway") return;
      // The document may have changed while the dialog was open: plan again.
    }
    const fresh = hist.planRestore(e.id, view.state.doc);
    if (!fresh) return;
    applying = true;
    try {
      view.dispatch(changeSpec(fresh, "input.ai")); // one transaction, so the rollback is one Ctrl+Z too
    } finally {
      applying = false;
    }
    hist.markRestored(e.id);
    hist.add({
      action: `Restore: ${e.action}`,
      time: Date.now(),
      scope: e.scope,
      scopeLabel: e.scopeLabel,
      from: fresh.from,
      to: fresh.from + fresh.insert.length,
      before: fresh.current,
      after: fresh.insert,
    });
    host.flash(`Restored the text from before "${e.action}". Ctrl+Z undoes the restore.`);
    if (historyOpen) renderHistory(tab);
  }

  return { openMenu, runQuick, showHistory, onUpdate, onTabChange };
}

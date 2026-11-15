/** Spell check and autocorrect for the editor. Lazy chunk: loaded only when a tab of an enabled file type has
 *  text, so it costs nothing while both are off or the document is empty.
 *
 *  Squiggles: a view plugin tokenizes only the visible lines, asks Rust (`spell_check`) about words it has not
 *  seen, and marks the wrong ones. Work happens in idle callbacks, in chunks, after a pause in typing; the
 *  word under the caret is left alone while it is being typed. Autocorrect: a typo from the built-in list is
 *  fixed when Space or Enter is typed, as its own undo step, so one Ctrl+Z brings the typo back.
 *  Pure parts: tokenize.ts, autocorrect.ts. */
import { invoke } from "@tauri-apps/api/core";
import { isolateHistory } from "@codemirror/commands";
import { type Extension, Prec, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, keymap } from "@codemirror/view";
import { correctionAt } from "./autocorrect";
import type { ContextItem } from "./contextmenu";
import { newlineCommand } from "./newline";
import type { TextKind } from "./spelltypes";
import { type Word, inFenceAt, tokenize } from "./tokenize";

export interface SpellConfig {
  spell: boolean;
  autocorrect: boolean;
  language: string;
  dictDir: string;
}

interface Reply {
  epoch: number;
  language: string;
  bad: number[];
}

const cfg: SpellConfig = { spell: false, autocorrect: false, language: "", dictDir: "" };
/** Words the checker has seen: true = misspelled. Dropped when the dictionary or the language changes. */
const cache = new Map<string, boolean>();
let cacheEpoch = -1;
/** Bumped whenever cached answers stop being valid; replies to older requests are discarded. */
let generation = 0;
/** Words the user chose to Ignore or Add this session (autocorrect never touches them either). */
const ignored = new Set<string>();
const added = new Set<string>();
const plugins = new Set<SpellPlugin>();
let notify: (text: string) => void = () => {};
let lastError = "";
/** The generation in which a check failed (a broken dictionary): no more tries until settings change. */
let failedGeneration = -1;

const CACHE_MAX = 60_000;
const CHUNK = 300;
/** Lines around the visible ones that are checked too, so a short scroll does not show unchecked text. */
const MARGIN_LINES = 20;
const MAX_RANGE_CHARS = 60_000;
const DELAY_TYPING = 350;
const DELAY_MOVE = 80;
const SUGGEST_WAIT_MS = 800;

const repaint = StateEffect.define<null>();

/** Shows one message for a failure (a broken dictionary file); said once, not on every pass. */
export function setNotifier(fn: (text: string) => void): void {
  notify = fn;
}

/** Applies the settings. Turning spell check off frees the dictionary in Rust. */
export function configure(next: SpellConfig): void {
  const changed = next.spell !== cfg.spell || next.language !== cfg.language || next.dictDir !== cfg.dictDir;
  const wasOn = cfg.spell;
  Object.assign(cfg, next); // `autocorrect` is read when a key is typed, so it needs nothing else
  if (!changed) return;
  generation++;
  cache.clear();
  lastError = "";
  failedGeneration = -1;
  if (wasOn && !next.spell) void invoke("spell_unload").catch(() => {});
  for (const p of plugins) p.schedule(0);
}

const idle = () =>
  new Promise<void>((resolve) => {
    if ("requestIdleCallback" in window) requestIdleCallback(() => resolve(), { timeout: 400 });
    else setTimeout(resolve, 20);
  });

function remember(r: Reply, words: string[]): void {
  if (r.epoch < cacheEpoch) return; // an answer from before a newer dictionary state
  if (r.epoch > cacheEpoch) {
    cache.clear();
    cacheEpoch = r.epoch;
  }
  if (cache.size > CACHE_MAX) cache.clear();
  const bad = new Set(r.bad);
  words.forEach((w, i) => cache.set(w, bad.has(i)));
}

const isWrong = (w: string) => cache.get(w) === true && !ignored.has(w);

/** Document ranges to check: the visible lines plus a margin, merged, each capped. */
function rangesToCheck(view: EditorView): { from: number; to: number }[] {
  const doc = view.state.doc;
  const out: { from: number; to: number }[] = [];
  for (const r of view.visibleRanges) {
    const a = doc.line(Math.max(1, doc.lineAt(r.from).number - MARGIN_LINES)).from;
    const b = doc.line(Math.min(doc.lines, doc.lineAt(r.to).number + MARGIN_LINES)).to;
    const last = out[out.length - 1];
    if (last && a <= last.to) last.to = Math.max(last.to, b);
    else out.push({ from: a, to: b });
  }
  return out;
}

class SpellPlugin {
  decorations: DecorationSet = Decoration.none;
  private timer = 0;
  private running = false;
  private again = false;
  private dead = false;
  /** Caret position right after the last edit: the word there is being typed, so it is not marked yet. */
  private editHead: number | null = null;

  constructor(
    readonly view: EditorView,
    readonly kind: TextKind,
  ) {
    plugins.add(this);
    byView.set(view, this);
    this.schedule(0);
  }

  update(u: ViewUpdate) {
    if (u.docChanged) {
      this.decorations = this.decorations.map(u.changes);
      const sel = u.state.selection.main;
      this.editHead = sel.empty ? sel.head : null;
      this.schedule(DELAY_TYPING);
    } else if (u.selectionSet || u.viewportChanged) {
      if (this.editHead !== null && u.state.selection.main.head !== this.editHead) this.editHead = null;
      this.schedule(DELAY_MOVE);
    }
  }

  destroy() {
    this.dead = true;
    clearTimeout(this.timer);
    plugins.delete(this);
    if (byView.get(this.view) === this) byView.delete(this.view);
  }

  schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void idle().then(() => this.run()), delay);
  }

  /** Words of the ranges to check (offsets are document positions). */
  private words(): Word[] {
    const doc = this.view.state.doc;
    const markdown = this.kind === "markdown";
    const out: Word[] = [];
    for (const r of rangesToCheck(this.view)) {
      const text = doc.sliceString(r.from, Math.min(r.to, r.from + MAX_RANGE_CHARS));
      const inFence = markdown && inFenceAt((n) => doc.line(n).text, doc.lineAt(r.from).number);
      out.push(...tokenize(text, r.from, { markdown, inFence }));
    }
    return out;
  }

  /** Marks every word the cache says is wrong. */
  private paint(words: Word[]) {
    if (this.dead) return;
    const sel = this.view.state.selection.main;
    const typing = this.editHead !== null && sel.empty && sel.head === this.editHead;
    const b = new RangeSetBuilder<Decoration>();
    const mark = Decoration.mark({ class: "cm-misspelled" });
    let end = -1;
    for (const w of words) {
      if (w.from < end || !isWrong(w.text)) continue;
      if (typing && sel.head >= w.from && sel.head <= w.to) continue;
      b.add(w.from, w.to, mark);
      end = w.to;
    }
    this.decorations = b.finish();
    this.view.dispatch({ effects: repaint.of(null) });
  }

  async run(): Promise<void> {
    if (this.dead) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        if (!cfg.spell) {
          if (this.decorations.size) this.paint([]);
          break;
        }
        const gen = generation;
        if (failedGeneration === gen) break;
        let words = this.words();
        this.paint(words);
        const unknown = [...new Set(words.map((w) => w.text))].filter((t) => !cache.has(t) && !ignored.has(t));
        for (let i = 0; i < unknown.length && !this.dead && gen === generation; i += CHUNK) {
          await idle();
          if (this.dead || gen !== generation) break;
          const chunk = unknown.slice(i, i + CHUNK);
          let reply: Reply;
          try {
            reply = await invoke<Reply>("spell_check", { words: chunk });
          } catch (e) {
            const msg = String(e);
            if (msg !== lastError) notify(msg);
            lastError = msg;
            failedGeneration = gen;
            return;
          }
          if (gen !== generation) break;
          remember(reply, chunk);
          words = this.words(); // the text may have changed while we waited
          this.paint(words);
        }
      } while (this.again && !this.dead);
    } finally {
      this.running = false;
    }
  }
}

const byView = new WeakMap<EditorView, SpellPlugin>();

/** The marked word at a document position, if any. */
function wrongWordAt(view: EditorView, pos: number): { from: number; to: number; word: string } | null {
  const p = byView.get(view);
  if (!p || !cfg.spell) return null;
  let hit: { from: number; to: number } | null = null;
  p.decorations.between(pos, pos, (from, to) => {
    hit = { from, to };
    return false;
  });
  const h = hit as { from: number; to: number } | null;
  return h ? { ...h, word: view.state.sliceDoc(h.from, h.to) } : null;
}

function repaintAll(): void {
  generation++;
  cache.clear();
  for (const p of plugins) p.schedule(0);
}

/** Items for the right-click menu when the click is on a marked word: suggestions, Add to dictionary,
 *  Ignore. Empty (and instant) anywhere else. */
export async function contextItems(
  view: EditorView,
  x: number,
  y: number,
  flash: (text: string) => void,
): Promise<ContextItem[]> {
  const pos = view.posAtCoords({ x, y });
  const hit = pos === null ? null : wrongWordAt(view, pos);
  if (!hit) return [];
  const { word } = hit;
  const timeout = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), SUGGEST_WAIT_MS));
  const suggestions = await Promise.race([invoke<string[]>("spell_suggest", { word }), timeout]).catch(() => []);
  const replace = (text: string) => {
    if (view.state.sliceDoc(hit.from, hit.to) !== word) return; // the text moved while the menu was open
    view.dispatch({
      changes: { from: hit.from, to: hit.to, insert: text },
      selection: { anchor: hit.from + text.length },
      userEvent: "input.spellcheck",
    });
  };
  const items: ContextItem[] = suggestions.length
    ? suggestions.map((s) => ({ label: s, strong: true, run: () => replace(s) }))
    : [{ label: "No suggestions", disabled: true }];
  items.push(
    { label: "", sep: true },
    {
      label: "Add to dictionary",
      run: () =>
        void invoke<number>("spell_add_word", { word })
          .then((epoch) => {
            added.add(word);
            cacheEpoch = Math.max(cacheEpoch, epoch);
            repaintAll();
            flash(`Added "${word}" to your dictionary.`);
          })
          .catch((e) => flash(String(e))),
    },
    {
      label: "Ignore",
      run: () => {
        ignored.add(word);
        for (const p of plugins) p.schedule(0);
      },
    },
    { label: "", sep: true },
  );
  return items;
}

/* ---------- autocorrect ---------- */

function fixAt(view: EditorView, pos: number, kind: TextKind) {
  if (!cfg.autocorrect || view.composing) return null;
  const doc = view.state.doc;
  const line = doc.lineAt(pos);
  const markdown = kind === "markdown";
  const fix = correctionAt(line.text, pos - line.from, {
    markdown,
    inFence: markdown && inFenceAt((n) => doc.line(n).text, line.number),
    keep: (w) => ignored.has(w) || added.has(w),
  });
  if (!fix) return null;
  const from = line.from + fix.from;
  const to = line.from + fix.to;
  return { from, to, insert: fix.insert, was: doc.sliceString(from, to) };
}

/** The correction is its own history event: Ctrl+Z puts the typo back and keeps what was typed after it. */
function applyFix(view: EditorView, fix: { from: number; to: number; insert: string; was: string }): void {
  if (view.state.sliceDoc(fix.from, fix.to) !== fix.was) return;
  view.dispatch({
    changes: { from: fix.from, to: fix.to, insert: fix.insert },
    annotations: isolateHistory.of("full"),
    userEvent: "input.autocorrect",
  });
}

function autocorrect(kind: TextKind): Extension {
  const typed = EditorView.inputHandler.of((view, from, to, text) => {
    const sel = view.state.selection.main;
    if (text !== " " || from !== to || !sel.empty || sel.head !== from) return false;
    const fix = fixAt(view, from, kind);
    if (!fix) return false;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      scrollIntoView: true,
      userEvent: "input.type",
    });
    applyFix(view, fix);
    return true;
  });
  const enter = Prec.high(
    keymap.of([
      {
        key: "Enter",
        run(view) {
          const sel = view.state.selection.main;
          if (!sel.empty) return false;
          const fix = fixAt(view, sel.head, kind);
          if (!fix) return false;
          view.state.facet(newlineCommand)(view);
          applyFix(view, fix);
          return true;
        },
      },
    ]),
  );
  return [typed, enter];
}

const squiggle = EditorView.baseTheme({
  ".cm-misspelled": {
    textDecoration: "underline wavy #e5484d",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
});

const cached = new Map<TextKind, Extension>();

/** The extension for a tab of this kind. The same object every time, so it can be compared. */
export function extensionFor(kind: TextKind): Extension {
  let ext = cached.get(kind);
  if (!ext) {
    const plugin = ViewPlugin.define((view) => new SpellPlugin(view, kind), {
      decorations: (p) => p.decorations,
    });
    ext = [plugin, autocorrect(kind), squiggle];
    cached.set(kind, ext);
  }
  return ext;
}

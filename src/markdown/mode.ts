/** Markdown mode. Lazy chunk: loaded only when a tab is (or is switched to) Markdown, so other tabs cost nothing.
 *  - `extension`: the editor part (highlighting, Enter / Tab for lists and tables, Ctrl+B / Ctrl+I, table
 *    auto-align), installed per tab through a compartment.
 *  - `MdUi`: the toolbar, the Source / Split / Preview switch and the preview pane (its own lazy chunk).
 *  The document is never changed except by Markdown-syntax edits typed or requested by the user. */
import "./markdown.css";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { HighlightStyle, Language, LanguageSupport, defineLanguageFacet, syntaxHighlighting } from "@codemirror/language";
import { type Extension, Prec } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { GFM, parser } from "@lezer/markdown";
import { type ContextItem, showContextMenu } from "../editor/contextmenu";
import { modal } from "../editor/dialog";
import { newlineCommand } from "../editor/newline";
import { makeLink, run, setHeading, toggleCode, toggleInline, toggleList, toggleQuote } from "./format";
import { listEnter, listTab, quoteEnter } from "./lists";
import type { Preview } from "./preview";
import {
  alignTable, cellAt, insertTable, needsAlign, parseSize, tableAtLine, tableEdit, tableEnter, tableTab,
} from "./tables";

export type MdView = "source" | "preview" | "split";

/* ---------- the editor extension ---------- */

/** Markdown with GitHub tables, strikethrough and task lists. Built from the Lezer parser directly: the
 *  `@codemirror/lang-markdown` package would also pull in the HTML, CSS and JavaScript languages. */
const language = new LanguageSupport(
  new Language(defineLanguageFacet({ commentTokens: { block: { open: "<!--", close: "-->" } } }), parser.configure([GFM]), [], "markdown"),
);

const highlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--accent)", fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--fg-dim)" },
  { tag: t.monospace, color: "var(--accent)" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.quote, color: "var(--fg-dim)", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.contentSeparator, t.meta], color: "var(--fg-dim)" },
  { tag: t.list, color: "var(--accent)" },
]);

/** Enter in Markdown: table row, list item, quote or code, in that order. */
function enter(view: EditorView): boolean {
  return tableEnter(view) || listEnter(view) || quoteEnter(view) || insertNewlineAndIndent(view);
}

/** Realigns a table a moment after the last edit inside it (never while typing fast, never mid-composition). */
const autoAlign = ViewPlugin.fromClass(
  class {
    timer = 0;
    update(u: ViewUpdate) {
      if (!u.docChanged || !u.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("input.paste") || tr.isUserEvent("delete"))) return;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        if (!u.view.composing && needsAlign(u.view)) alignTable(u.view);
      }, 700);
    }
    destroy() {
      clearTimeout(this.timer);
    }
  },
);

export const extension: Extension = [
  language,
  syntaxHighlighting(highlight),
  newlineCommand.of(enter),
  autoAlign,
  Prec.high(
    keymap.of([
      { key: "Mod-b", run: (v) => run(v, (s) => toggleInline(s, "**")) },
      { key: "Mod-i", run: (v) => run(v, (s) => toggleInline(s, "*")) },
      { key: "Enter", run: enter },
      { key: "Tab", run: (v) => tableTab(v, 1) || listTab(v, 1) },
      { key: "Shift-Tab", run: (v) => tableTab(v, -1) || listTab(v, -1) },
    ]),
  ),
];

/* ---------- toolbar, views, preview ---------- */

export interface MdHost {
  view(): EditorView;
  flash(text: string): void;
  /** The user picked another view in the toolbar. */
  setView(view: MdView): void;
}

interface Button {
  label: string;
  title: string;
  cls?: string;
  run(): void;
}

const VIEWS: { id: MdView; label: string; title: string }[] = [
  { id: "source", label: "Source", title: "Show the Markdown source only" },
  { id: "split", label: "Split", title: "Source and preview side by side" },
  { id: "preview", label: "Preview", title: "Show the rendered preview only" },
];

export class MdUi {
  private bar: HTMLElement | null = null;
  private pane: HTMLElement | null = null;
  private preview: Preview | null = null;
  private loading: Promise<void> | null = null;
  private current: MdView = "source";
  private key: object = this;
  private on = false;
  private timer = 0;
  private views = new Map<MdView, HTMLButtonElement>();
  private formatButtons: HTMLButtonElement[] = [];

  constructor(
    private app: HTMLElement,
    private work: HTMLElement,
    private host: MdHost,
  ) {}

  /** Shows (or hides) Markdown mode for the tab `key` in the given view. */
  sync(on: boolean, view: MdView, key: object): void {
    this.on = on;
    this.current = view;
    this.key = key;
    this.app.classList.toggle("md-on", on);
    this.app.classList.toggle("md-preview", on && view === "preview");
    this.app.classList.toggle("md-split", on && view === "split");
    if (!on) {
      if (this.bar) this.bar.hidden = true;
      this.preview?.clear();
      return;
    }
    this.ensureBar();
    this.bar!.hidden = false;
    for (const [id, b] of this.views) b.setAttribute("aria-pressed", String(id === view));
    for (const b of this.formatButtons) b.disabled = view === "preview";
    if (view === "source") {
      this.preview?.clear();
      return;
    }
    void this.ensurePreview().then(() => this.renderNow());
  }

  /** The document changed: refresh the preview after a short pause. */
  docChanged(): void {
    if (!this.on || this.current === "source" || !this.preview) return;
    clearTimeout(this.timer);
    const big = this.host.view().state.doc.length > 300_000;
    this.timer = window.setTimeout(() => this.renderNow(), big ? 700 : 180);
  }

  private renderNow(): void {
    if (!this.on || this.current === "source" || !this.preview) return;
    this.preview.render(this.host.view().state.doc.toString(), this.key);
  }

  private ensurePreview(): Promise<void> {
    this.loading ??= import("./preview").then(({ Preview }) => {
      this.pane = document.createElement("div");
      this.pane.id = "mdpreview";
      this.pane.tabIndex = 0;
      this.work.append(this.pane);
      this.preview = new Preview(this.pane, { flash: this.host.flash });
      // In Split view the preview follows the source's scroll position.
      this.host.view().scrollDOM.addEventListener("scroll", () => {
        if (!this.on || this.current !== "split" || !this.pane) return;
        const s = this.host.view().scrollDOM;
        const max = s.scrollHeight - s.clientHeight;
        if (max <= 0) return;
        this.pane.scrollTop = (s.scrollTop / max) * (this.pane.scrollHeight - this.pane.clientHeight);
      });
    });
    return this.loading;
  }

  private ensureBar(): void {
    if (this.bar) return;
    const bar = document.createElement("div");
    bar.id = "mdbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Markdown formatting");
    const v = () => this.host.view();
    const fmt = (spec: Parameters<typeof run>[1]) => () => void run(v(), spec);
    const buttons: (Button | null)[] = [
      { label: "B", title: "Bold (Ctrl+B)", cls: "b", run: fmt((s) => toggleInline(s, "**")) },
      { label: "I", title: "Italic (Ctrl+I)", cls: "i", run: fmt((s) => toggleInline(s, "*")) },
      { label: "S", title: "Strikethrough", cls: "s", run: fmt((s) => toggleInline(s, "~~")) },
      null,
      { label: "H", title: "Heading", run: () => this.headingMenu() },
      { label: "•", title: "Bulleted list", run: fmt((s) => toggleList(s, false)) },
      { label: "1.", title: "Numbered list (Tab and Shift+Tab nest items)", run: fmt((s) => toggleList(s, true)) },
      null,
      { label: "Link", title: "Link", run: fmt((s) => makeLink(s)) },
      { label: "</>", title: "Code (inline, or a block for several lines)", run: fmt((s) => toggleCode(s)) },
      { label: "❝", title: "Quote", run: fmt((s) => toggleQuote(s)) },
      { label: "Table", title: "Insert a table", run: () => void this.askTable() },
    ];
    for (const b of buttons) {
      if (!b) {
        const sep = document.createElement("span");
        sep.className = "sep";
        bar.append(sep);
        continue;
      }
      const el = document.createElement("button");
      el.textContent = b.label;
      el.title = b.title;
      el.setAttribute("aria-label", b.title);
      if (b.cls) el.className = b.cls;
      // Keep the editor's selection (a click on a button would collapse it).
      el.addEventListener("mousedown", (e) => e.preventDefault());
      el.addEventListener("click", () => b.run());
      bar.append(el);
      this.formatButtons.push(el);
    }
    const sp = document.createElement("span");
    sp.className = "sp";
    bar.append(sp);
    const seg = document.createElement("span");
    seg.className = "seg";
    for (const o of VIEWS) {
      const el = document.createElement("button");
      el.textContent = o.label;
      el.title = o.title;
      el.addEventListener("click", () => this.host.setView(o.id));
      seg.append(el);
      this.views.set(o.id, el);
    }
    bar.append(seg);
    this.app.insertBefore(bar, this.work);
    this.bar = bar;
  }

  private headingMenu(): void {
    const btn = [...(this.bar?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "H");
    const r = btn?.getBoundingClientRect();
    const items: ContextItem[] = [1, 2, 3, 4, 5, 6].map((n) => ({
      label: `Heading ${n}`,
      hint: "#".repeat(n),
      run: () => void run(this.host.view(), (s) => setHeading(s, n)),
    }));
    items.push({ label: "", sep: true }, { label: "Normal text", run: () => void run(this.host.view(), (s) => setHeading(s, 0)) });
    showContextMenu(r?.left ?? 8, (r?.bottom ?? 40) + 2, items, () => this.host.view().focus());
  }

  private async askTable(): Promise<void> {
    const r = await modal({
      message: "Insert a table. Size as rows x columns (the first row is the header):",
      input: "3x3",
      buttons: ["Insert", "Cancel"],
    });
    const view = this.host.view();
    if (r.button !== "Insert") return view.focus();
    const size = parseSize(r.value);
    if (!size) {
      this.host.flash("Type the size as rows x columns, for example 3x4.");
      return view.focus();
    }
    insertTable(view, size[0], size[1]);
    view.focus();
  }

  /** Right-click inside a table: row and column commands. Empty anywhere else. */
  contextItems(view: EditorView, x: number, y: number): ContextItem[] {
    if (!this.on) return [];
    const pos = view.posAtCoords({ x, y });
    if (pos === null) return [];
    const line = view.state.doc.lineAt(pos);
    const info = tableAtLine(view.state.doc, line.number);
    if (!info) return [];
    const col = cellAt(line.text, pos - line.from).cell;
    const edit = (op: Parameters<typeof tableEdit>[3]) => () => {
      tableEdit(view, info, col, op);
      view.focus();
    };
    const body = info.row >= 2;
    return [
      { label: "Insert row above", run: edit("rowAbove") },
      { label: "Insert row below", run: edit("rowBelow") },
      { label: "Delete row", disabled: !body, run: edit("deleteRow") },
      { label: "", sep: true },
      { label: "Insert column left", run: edit("colLeft") },
      { label: "Insert column right", run: edit("colRight") },
      { label: "Delete column", disabled: info.table.header.length <= 1, run: edit("deleteCol") },
      { label: "", sep: true },
      { label: "Align column left", run: edit("left") },
      { label: "Align column center", run: edit("center") },
      { label: "Align column right", run: edit("right") },
      { label: "Format table", run: edit("format") },
      { label: "", sep: true },
    ];
  }
}

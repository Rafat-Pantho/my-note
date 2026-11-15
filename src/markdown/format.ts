/** The toolbar's text edits: bold, italic, strikethrough, code, headings, lists, quote, link. Each one is a command
 *  on an editor view that produces ONE undoable change and writes only Markdown syntax (tested in format.test.ts
 *  against real editor state). */
import { EditorSelection, type EditorState, type SelectionRange, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { parseListLine } from "./lists.ts";

type Spec = TransactionSpec | null;

/* ---------- inline marks ---------- */

/** How many `ch` characters touch position `pos` going left (`dir` -1) or right (1). */
function runLength(state: EditorState, pos: number, dir: 1 | -1, ch: string): number {
  const doc = state.doc;
  let n = 0;
  while (n < 4) {
    const i = dir === 1 ? pos + n : pos - n - 1;
    if (i < 0 || i >= doc.length || doc.sliceString(i, i + 1) !== ch) break;
    n++;
  }
  return n;
}

/** The range a mark applies to: the selection, or the word at an empty caret. */
function target(state: EditorState, r: SelectionRange): { from: number; to: number } {
  if (!r.empty) return { from: r.from, to: r.to };
  const w = state.wordAt(r.head);
  return w ? { from: w.from, to: w.to } : { from: r.from, to: r.to };
}

/** Wraps the selection in `mark` (`**`, `*`, `~~`, `` ` ``), or removes the mark if it is already there. An empty
 *  caret outside a word inserts a pair and puts the caret between. `*` and `**` can be combined (`***x***`). */
export function toggleInline(state: EditorState, mark: string): Spec {
  const star = mark[0] === "*";
  const w = mark.length;
  return {
    ...state.changeByRange((range) => {
    const { from, to } = target(state, range);
    const text = state.doc.sliceString(from, to);
    // Already marked? Look at the characters just outside the range, and at the range's own ends.
    let outside = false;
    let inside = false;
    if (star) {
      const n = Math.min(runLength(state, from, -1, "*"), runLength(state, to, 1, "*"));
      outside = w === 1 ? n % 2 === 1 : n >= 2;
      if (!outside && text.length > 2 * w) {
        const lead = text.match(/^\*+/)?.[0].length ?? 0;
        const trail = text.match(/\*+$/)?.[0].length ?? 0;
        const n2 = Math.min(lead, trail);
        inside = w === 1 ? n2 % 2 === 1 : n2 >= 2;
      }
    } else {
      outside = from >= w && to + w <= state.doc.length &&
        state.doc.sliceString(from - w, from) === mark && state.doc.sliceString(to, to + w) === mark;
      inside = !outside && text.length >= 2 * w + 1 && text.startsWith(mark) && text.endsWith(mark);
    }
    if (outside) {
      return {
        changes: [{ from: from - w, to: from }, { from: to, to: to + w }],
        range: EditorSelection.range(from - w, to - w),
      };
    }
    if (inside) {
      return {
        changes: [{ from, to: from + w }, { from: to - w, to }],
        range: EditorSelection.range(from, to - 2 * w),
      };
    }
    if (from === to) {
      return { changes: { from, insert: mark + mark }, range: EditorSelection.cursor(from + w) };
    }
    return {
      changes: [{ from, insert: mark }, { from: to, insert: mark }],
      range: EditorSelection.range(from + w, to + w),
    };
    }),
    userEvent: "input.format",
  };
}

/* ---------- line prefixes ---------- */

/** The line numbers a command works on: every line the selection touches (a selection ending at the very start of
 *  a line does not include that line). */
function selectedLines(state: EditorState): number[] {
  const out = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    let b = state.doc.lineAt(r.to).number;
    if (!r.empty && b > a && state.doc.line(b).from === r.to) b--;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

const HEADING = /^(\s{0,3})(#{1,6})[ \t]+/u;

/** Sets the heading level of the selected lines (0 = plain paragraph). The same level again removes it. */
export function setHeading(state: EditorState, level: number): Spec {
  const lines = selectedLines(state).map((n) => state.doc.line(n));
  const nonEmpty = lines.filter((l) => l.text.trim() !== "");
  if (nonEmpty.length === 0) return null;
  const same = nonEmpty.every((l) => HEADING.exec(l.text)?.[2].length === level);
  const want = same ? 0 : level;
  const changes = nonEmpty.map((l) => {
    const m = HEADING.exec(l.text);
    const stripped = m ? m[0].length : 0;
    return { from: l.from, to: l.from + stripped, insert: want ? "#".repeat(want) + " " : "" };
  });
  return { changes, userEvent: "input.format" };
}

/** Bulleted or numbered list on the selected lines; if they all are one already, the markers come off. Existing
 *  indentation stays, another list type or a quote marker is replaced. */
export function toggleList(state: EditorState, ordered: boolean): Spec {
  const lines = selectedLines(state).map((n) => state.doc.line(n)).filter((l) => l.text.trim() !== "");
  if (lines.length === 0) {
    const l = state.doc.lineAt(state.selection.main.head);
    const mark = ordered ? "1. " : "- ";
    return { changes: { from: l.from, insert: l.text.match(/^\s*/u)![0] + mark, to: l.from + l.text.match(/^\s*/u)![0].length }, userEvent: "input.format" };
  }
  const items = lines.map((l) => parseListLine(l.text));
  const all = items.every((p) => p && p.ordered === ordered && !p.task);
  let n = 0;
  const changes = lines.map((l, i) => {
    const p = items[i];
    const indent = l.text.match(/^\s*/u)![0];
    const quote = /^\s*>\s?/u.exec(l.text);
    const stripTo = p ? p.indent.length + p.marker.length + p.gap.length : quote ? quote[0].length : indent.length;
    if (all) return { from: l.from + indent.length, to: l.from + stripTo, insert: "" };
    n++;
    return { from: l.from + indent.length, to: l.from + stripTo, insert: ordered ? `${n}. ` : "- " };
  });
  return { changes, userEvent: "input.format" };
}

/** Block quote on the selected lines (empty lines get a bare `>`); if all are quoted, the `> ` comes off. */
export function toggleQuote(state: EditorState): Spec {
  const lines = selectedLines(state).map((n) => state.doc.line(n));
  const quoted = (t: string) => /^\s{0,3}>/u.test(t);
  const all = lines.every((l) => quoted(l.text));
  const changes = lines.map((l) => {
    if (all) {
      const m = /^(\s{0,3})>[ ]?/u.exec(l.text)!;
      return { from: l.from + m[1].length, to: l.from + m[0].length, insert: "" };
    }
    return { from: l.from, insert: l.text.trim() === "" ? ">" : "> " };
  });
  return { changes, userEvent: "input.format" };
}

/* ---------- link and code ---------- */

/** `[text](url)` around the selection, with the part still to be typed selected: the address when there is a
 *  text, otherwise the text. A selection that already is an http(s) address becomes the link's address. */
export function makeLink(state: EditorState): Spec {
  const r = state.selection.main;
  const { from, to } = target(state, r);
  const text = state.doc.sliceString(from, to);
  if (/^https?:\/\/\S+$/iu.test(text)) {
    return {
      changes: { from, to, insert: `[](${text})` },
      selection: EditorSelection.cursor(from + 1),
      userEvent: "input.format",
    };
  }
  const url = "https://";
  const insert = `[${text}](${url})`;
  const urlFrom = from + 1 + text.length + 2;
  return {
    changes: { from, to, insert },
    selection: text ? EditorSelection.range(urlFrom, urlFrom + url.length) : EditorSelection.cursor(from + 1),
    userEvent: "input.format",
  };
}

/** Code: inline backticks for text inside one line, a fenced block for a selection over several lines. */
export function toggleCode(state: EditorState): Spec {
  const r = state.selection.main;
  const a = state.doc.lineAt(r.from);
  const b = state.doc.lineAt(r.to);
  if (a.number === b.number || (r.to === b.from && b.number === a.number + 1)) return toggleInline(state, "`");
  const last = r.to === b.from ? state.doc.line(b.number - 1) : b;
  return {
    changes: [
      { from: a.from, insert: "```\n" },
      { from: last.to, insert: "\n```" },
    ],
    userEvent: "input.format",
  };
}

/* ---------- applying ---------- */

/** Runs one of the commands above on a view: one transaction, one undo step. */
export function run(view: EditorView, spec: (s: EditorState) => Spec): boolean {
  const s = spec(view.state);
  if (!s) return false;
  view.dispatch({ ...s, scrollIntoView: true });
  view.focus();
  return true;
}

/** Markdown lists: Enter continues an item, Enter on an empty item ends it, Tab / Shift+Tab nest and un-nest.
 *  The line logic is pure (tested in lists.test.ts); the commands at the bottom apply it to an editor view. */
import type { EditorView } from "@codemirror/view";
import { inFenceAt } from "../editor/tokenize.ts";

export interface ListLine {
  indent: string;
  /** "-", "*", "+", or the number with its delimiter ("3." / "3)"). */
  marker: string;
  ordered: boolean;
  num: number;
  /** Spaces between the marker and the text. */
  gap: string;
  /** "[ ] " or "[x] " for a task item, else "". */
  task: string;
  text: string;
  /** Column where the item's text starts. */
  textStart: number;
}

const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/u;
const EMPTY_MARKER = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]*$/u; // "-" with nothing after it

export function parseListLine(line: string): ListLine | null {
  // A thematic break ("- - -", "***") is not an item.
  if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line)) return null;
  let m = ITEM.exec(line);
  if (!m) {
    m = EMPTY_MARKER.exec(line);
    if (!m) return null;
    m = [m[0], m[1], m[2], " ", "", ""] as unknown as RegExpExecArray;
  }
  const [, indent, marker, gap, task = "", text] = m;
  const ordered = /\d/.test(marker);
  const textStart = indent.length + marker.length + gap.length + task.length;
  return { indent, marker, ordered, num: ordered ? parseInt(marker, 10) : 0, gap, task, text, textStart };
}

/** The marker of the item that follows `l`: the same bullet, or the next number; a task item starts unchecked. */
export function nextMarker(l: ListLine): string {
  const m = l.ordered ? `${l.num + 1}${l.marker.slice(-1)}` : l.marker;
  return `${l.indent}${m}${l.gap}${l.task ? "[ ] " : ""}`;
}

/** How far a nested item is indented: the width of its own marker and gap (2 for "- ", 3 for "1. "). */
export const nestWidth = (l: ListLine): number => l.marker.length + Math.max(1, l.gap.length);

export type EnterAction =
  | { type: "continue"; insert: string }
  /** Replace [from, to) of the line (columns) with `insert`: removes the empty item's marker, or un-nests it. */
  | { type: "end"; from: number; to: number; insert: string };

/** What Enter does with the caret at `col` on `line`, or null when it is not a list item (or the caret is in
 *  the marker). */
export function enterAction(line: string, col: number): EnterAction | null {
  const l = parseListLine(line);
  if (!l || col <= l.indent.length + l.marker.length) return null; // not an item, or the caret is in the marker
  if (col < l.textStart && l.text.length > 0) return null;
  if (l.text.trim() === "" && col >= line.trimEnd().length) {
    // An empty item ends the list; a nested one first steps out one level.
    if (l.indent.length > 0) {
      const cut = Math.min(l.indent.length, nestWidth(l));
      return { type: "end", from: 0, to: cut, insert: "" };
    }
    return { type: "end", from: 0, to: line.length, insert: "" };
  }
  return { type: "continue", insert: `\n${nextMarker(l)}` };
}

/** The line after indenting (dir 1) or un-indenting (dir -1) an item; null if it is not an item or cannot move. */
export function shiftItem(line: string, dir: 1 | -1): string | null {
  const l = parseListLine(line);
  if (!l) return null;
  if (dir === 1) return " ".repeat(nestWidth(l)) + line;
  if (line.startsWith("\t")) return line.slice(1);
  const lead = l.indent.length;
  if (lead === 0) return null;
  return line.slice(Math.min(lead, nestWidth(l)));
}

/** Enter in a block quote: the next line continues the quote; Enter on an empty quote line ends it. */
export function quoteAction(line: string, col: number): EnterAction | null {
  const m = /^(\s{0,3}(?:>[ ]?)+)(.*)$/u.exec(line);
  if (!m || col < m[1].length) return null;
  const prefix = m[1].replace(/>(?=>)/gu, "> ").replace(/>$/u, "> ");
  if (m[2].trim() === "" && col >= line.trimEnd().length) return { type: "end", from: 0, to: line.length, insert: "" };
  return { type: "continue", insert: `\n${prefix}` };
}

/* ---------- editor commands ---------- */

const lineText = (view: EditorView) => (n: number) => view.state.doc.line(n).text;

/** Enter: continue the list, or end it on an empty item. False (do nothing) elsewhere. */
export function listEnter(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (inFenceAt(lineText(view), line.number)) return false;
  const act = enterAction(line.text, sel.head - line.from);
  if (!act) return false;
  if (act.type === "continue") {
    view.dispatch({
      changes: { from: sel.head, insert: act.insert },
      selection: { anchor: sel.head + act.insert.length },
      scrollIntoView: true,
      userEvent: "input",
    });
  } else {
    view.dispatch({
      changes: { from: line.from + act.from, to: line.from + act.to, insert: act.insert },
      selection: { anchor: line.from + Math.max(0, sel.head - line.from - (act.to - act.from)) },
      userEvent: "input",
    });
  }
  return true;
}

/** Enter in a block quote (see `quoteAction`). False elsewhere. */
export function quoteEnter(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (inFenceAt(lineText(view), line.number)) return false;
  const act = quoteAction(line.text, sel.head - line.from);
  if (!act) return false;
  if (act.type === "continue") {
    view.dispatch({
      changes: { from: sel.head, insert: act.insert },
      selection: { anchor: sel.head + act.insert.length },
      scrollIntoView: true,
      userEvent: "input",
    });
  } else {
    view.dispatch({
      changes: { from: line.from + act.from, to: line.from + act.to, insert: act.insert },
      selection: { anchor: line.from },
      userEvent: "input",
    });
  }
  return true;
}

/** Tab / Shift+Tab on list items (every selected line that is an item). False when the caret line is not one. */
export function listTab(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const first = state.doc.lineAt(sel.from);
  const last = state.doc.lineAt(sel.to);
  if (inFenceAt(lineText(view), first.number)) return false;
  const changes: { from: number; to: number; insert: string }[] = [];
  let moved = false;
  for (let n = first.number; n <= last.number; n++) {
    const line = state.doc.line(n);
    const next = shiftItem(line.text, dir);
    if (next === null) {
      if (n === first.number && !parseListLine(line.text)) return false;
      continue;
    }
    moved = true;
    changes.push({ from: line.from, to: line.to, insert: next });
  }
  // On an item that cannot move (Shift+Tab at the top level) the key does nothing, but it is still ours.
  if (moved) view.dispatch({ changes, userEvent: dir === 1 ? "input.indent" : "delete.dedent" });
  return true;
}

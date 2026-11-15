/** GitHub-style pipe tables: find, parse, align, add and remove rows and columns. The file always holds plain
 *  pipe-table Markdown (`| a | b |` with a `| --- | --- |` row); nothing else is ever written.
 *  The model and text functions are pure (tested in tables.test.ts); the commands at the bottom apply them to an
 *  editor view. */
import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { inFenceAt } from "../editor/tokenize.ts";

export type Align = "none" | "left" | "center" | "right";

export interface Table {
  header: string[];
  aligns: Align[];
  /** Body rows. */
  rows: string[][];
}

/** Lines `start` (header) to `end` of a block; the delimiter row is `start + 1`. */
export interface Span {
  start: number;
  end: number;
}

/* ---------- text <-> model ---------- */

/** Where the unescaped pipes of a line are. */
function pipeColumns(line: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "|") out.push(i);
  }
  return out;
}

export interface CellSpan {
  /** Whole text between two pipes. */
  segStart: number;
  segEnd: number;
  /** The trimmed content. */
  start: number;
  end: number;
}

/** The cells of a row with their columns (leading and trailing pipes are optional in the source). */
export function cellSpans(line: string): CellSpan[] {
  const pipes = pipeColumns(line);
  const bounds: [number, number][] = [];
  let prev = -1;
  for (const p of pipes) {
    bounds.push([prev + 1, p]);
    prev = p;
  }
  bounds.push([prev + 1, line.length]);
  if (pipes.length > 0) {
    // A pipe at the very start or end of the row does not open an empty cell.
    if (line.slice(0, pipes[0]).trim() === "") bounds.shift();
    if (bounds.length > 0 && line.slice(pipes[pipes.length - 1] + 1).trim() === "") bounds.pop();
  }
  return bounds.map(([a, b]) => {
    const seg = line.slice(a, b);
    const lead = seg.length - seg.trimStart().length;
    const content = seg.trim();
    const start = content ? a + lead : Math.min(a + 1, b);
    return { segStart: a, segEnd: b, start, end: content ? start + content.length : start };
  });
}

export function splitRow(line: string): string[] {
  return cellSpans(line).map((c) => line.slice(c.start, c.end));
}

const DELIM_CELL = /^:?-+:?$/u;

export function isDelimiterRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
}

function alignOf(cell: string): Align {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : "none";
}

const isRowLine = (s: string) => s.trim() !== "" && s.includes("|");

/** The table that line `i` belongs to, among `lines`; null if it is not part of a table. A table is a header
 *  row, a delimiter row with the same number of cells, and the pipe rows after it. */
export function findTable(lines: string[], i: number): Span | null {
  if (i < 0 || i >= lines.length || !isRowLine(lines[i])) return null;
  let a = i;
  while (a > 0 && isRowLine(lines[a - 1])) a--;
  let b = i;
  while (b < lines.length - 1 && isRowLine(lines[b + 1])) b++;
  for (let d = a + 1; d <= b; d++) {
    if (isDelimiterRow(lines[d]) && splitRow(lines[d - 1]).length === splitRow(lines[d]).length) {
      return i >= d - 1 ? { start: d - 1, end: b } : null;
    }
  }
  return null;
}

export function parseTable(lines: string[], span: Span): Table {
  const header = splitRow(lines[span.start]);
  const aligns = splitRow(lines[span.start + 1]).map(alignOf);
  const rows = lines.slice(span.start + 2, span.end + 1).map(splitRow);
  return normalize({ header, aligns, rows });
}

/** Every row gets the same number of cells (missing ones are empty). */
function normalize(t: Table): Table {
  const n = Math.max(1, t.header.length, t.aligns.length, ...t.rows.map((r) => r.length));
  const fill = <T>(a: T[], v: T) => Array.from({ length: n }, (_, i) => (i < a.length ? a[i] : v));
  return { header: fill(t.header, ""), aligns: fill(t.aligns, "none" as Align), rows: t.rows.map((r) => fill(r, "")) };
}

/** Columns a character takes in a monospace font: 2 for East Asian wide and emoji, 0 for combining marks. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x200c || c === 0x200d || /\p{M}/u.test(ch)) continue;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(cell: string, width: number, align: Align): string {
  const gap = Math.max(0, width - displayWidth(cell));
  if (align === "right") return " ".repeat(gap) + cell;
  if (align === "center") return " ".repeat(Math.floor(gap / 2)) + cell + " ".repeat(Math.ceil(gap / 2));
  return cell + " ".repeat(gap);
}

function delimiter(width: number, align: Align): string {
  if (align === "center") return `:${"-".repeat(width - 2)}:`;
  if (align === "left") return `:${"-".repeat(width - 1)}`;
  if (align === "right") return `${"-".repeat(width - 1)}:`;
  return "-".repeat(width);
}

/** The aligned text of a table: every column as wide as its widest cell (at least 3), pipes lined up. */
export function formatTable(table: Table): string[] {
  const t = normalize(table);
  const widths = t.header.map((h, c) =>
    Math.max(3, displayWidth(h), ...t.rows.map((r) => displayWidth(r[c]))),
  );
  const row = (cells: string[]) => `| ${cells.map((x, c) => pad(x, widths[c], t.aligns[c])).join(" | ")} |`;
  return [
    row(t.header),
    `| ${widths.map((w, c) => delimiter(w, t.aligns[c])).join(" | ")} |`,
    ...t.rows.map(row),
  ];
}

/** An empty table of `rows` rows (the first is the header, so at least 2) by `cols` columns. */
export function newTable(rows: number, cols: number): Table {
  const c = Math.min(30, Math.max(1, Math.floor(cols)));
  const r = Math.min(200, Math.max(2, Math.floor(rows)));
  return {
    header: Array.from({ length: c }, (_, i) => `Header ${i + 1}`),
    aligns: Array.from({ length: c }, () => "none" as Align),
    rows: Array.from({ length: r - 1 }, () => Array.from({ length: c }, () => "")),
  };
}

/** "3x4", "3 x 4", "3,4" or "3 4" -> [rows, columns]; null if it is not two numbers. */
export function parseSize(text: string): [number, number] | null {
  const m = /^\s*(\d{1,3})\s*(?:[x×,*]|\s)\s*(\d{1,3})\s*$/iu.exec(text);
  if (!m) return null;
  const rows = parseInt(m[1], 10);
  const cols = parseInt(m[2], 10);
  return rows >= 1 && cols >= 1 ? [rows, cols] : null;
}

/* ---------- edits on the model (`row` counts body rows from 0; `col` columns from 0) ---------- */

export const insertRow = (t: Table, at: number): Table => {
  const rows = t.rows.map((r) => r.slice());
  rows.splice(Math.max(0, Math.min(at, rows.length)), 0, t.header.map(() => ""));
  return { ...t, rows };
};

export const deleteRow = (t: Table, at: number): Table => ({ ...t, rows: t.rows.filter((_, i) => i !== at) });

export const insertColumn = (t: Table, at: number): Table => {
  const i = Math.max(0, Math.min(at, t.header.length));
  const put = <T>(a: T[], v: T) => [...a.slice(0, i), v, ...a.slice(i)];
  return { header: put(t.header, ""), aligns: put(t.aligns, "none" as Align), rows: t.rows.map((r) => put(r, "")) };
};

/** Removes a column; the last remaining column cannot be removed. */
export const deleteColumn = (t: Table, at: number): Table => {
  if (t.header.length <= 1) return t;
  const cut = <T>(a: T[]) => a.filter((_, i) => i !== at);
  return { header: cut(t.header), aligns: cut(t.aligns), rows: t.rows.map(cut) };
};

export const setAlign = (t: Table, col: number, a: Align): Table => ({
  ...t,
  aligns: t.aligns.map((x, i) => (i === col ? a : x)),
});

/** Which cell a column in a row is in, and how far into its text: used to put the caret back after realigning. */
export function cellAt(line: string, col: number): { cell: number; offset: number } {
  const spans = cellSpans(line);
  if (spans.length === 0) return { cell: 0, offset: 0 };
  let cell = spans.findIndex((s) => col <= s.segEnd);
  if (cell < 0) cell = spans.length - 1;
  const s = spans[cell];
  return { cell, offset: Math.max(0, Math.min(col - s.start, s.end - s.start)) };
}

/* ---------- editor side ---------- */

export interface TableInfo {
  span: Span;
  /** Document line numbers (1-based) of the first and last line. */
  first: number;
  last: number;
  table: Table;
  /** 0 = header, 1 = delimiter row, 2.. = body rows. */
  row: number;
}

const MAX_BLOCK_LINES = 1500;

/** The table around document line `lineNumber`, if there is one (not inside a code fence). */
export function tableAtLine(doc: Text, lineNumber: number): TableInfo | null {
  if (!isRowLine(doc.line(lineNumber).text)) return null;
  let a = lineNumber;
  while (a > 1 && lineNumber - a < MAX_BLOCK_LINES && isRowLine(doc.line(a - 1).text)) a--;
  let b = lineNumber;
  while (b < doc.lines && b - lineNumber < MAX_BLOCK_LINES && isRowLine(doc.line(b + 1).text)) b++;
  const lines: string[] = [];
  for (let n = a; n <= b; n++) lines.push(doc.line(n).text);
  const span = findTable(lines, lineNumber - a);
  if (!span || inFenceAt((n) => doc.line(n).text, a + span.start)) return null;
  const table = parseTable(lines, span);
  return {
    span,
    first: a + span.start,
    last: a + span.end,
    table,
    row: lineNumber - (a + span.start),
  };
}

/** Replaces the table with `next` (aligned). `focus` = which cell gets the caret (row 0 header, 1.. body); without
 *  it the caret stays in the same cell at the same offset. Returns false if nothing would change. */
function apply(view: EditorView, info: TableInfo, next: Table, focus?: { row: number; col: number }): boolean {
  const { state } = view;
  const doc = state.doc;
  const from = doc.line(info.first).from;
  const to = doc.line(info.last).to;
  const lines = formatTable(next);
  const text = lines.join("\n");
  const head = state.selection.main.from;
  let target: { row: number; col: number; offset: number | null };
  if (focus) target = { ...focus, offset: null };
  else {
    const ln = doc.lineAt(head);
    const at = cellAt(ln.text, head - ln.from);
    target = { row: Math.max(0, info.row - 1), col: at.cell, offset: at.offset };
  }
  const idx = target.row === 0 ? 0 : target.row + 1; // skip the delimiter row
  const line = lines[Math.min(idx, lines.length - 1)];
  const spans = cellSpans(line);
  const s = spans[Math.min(target.col, spans.length - 1)];
  const lineStart = from + lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0);
  const anchor = target.offset === null ? lineStart + s.start : lineStart + s.start + Math.min(target.offset, s.end - s.start);
  const head2 = target.offset === null ? lineStart + s.end : anchor;
  if (text === doc.sliceString(from, to) && target.offset !== null) return false;
  view.dispatch({
    changes: text === doc.sliceString(from, to) ? undefined : { from, to, insert: text },
    selection: { anchor, head: head2 },
    scrollIntoView: true,
    userEvent: "input.table",
  });
  return true;
}

/** The table around the selection, if the selection (a caret, or a cell's text) is inside one line of it. */
const infoAtCaret = (view: EditorView): TableInfo | null => {
  const { doc, selection } = view.state;
  const sel = selection.main;
  const line = doc.lineAt(sel.from);
  return line.number === doc.lineAt(sel.to).number ? tableAtLine(doc, line.number) : null;
};

/** Realigns the table the caret is in. True if the text changed. */
export function alignTable(view: EditorView): boolean {
  const info = infoAtCaret(view);
  return info ? apply(view, info, info.table) : false;
}

/** The table at the caret is out of line (it has been edited): used to decide whether to realign. */
export function needsAlign(view: EditorView): boolean {
  const info = infoAtCaret(view);
  if (!info) return false;
  const doc = view.state.doc;
  return formatTable(info.table).join("\n") !== doc.sliceString(doc.line(info.first).from, doc.line(info.last).to);
}

/** Tab / Shift+Tab: next / previous cell; Tab in the last cell adds a row. False outside a table. */
export function tableTab(view: EditorView, dir: 1 | -1): boolean {
  const info = infoAtCaret(view);
  if (!info) return false;
  const from = view.state.selection.main.from;
  const ln = view.state.doc.lineAt(from);
  const { cell } = cellAt(ln.text, from - ln.from);
  const cols = info.table.header.length;
  let row = Math.max(0, info.row - 1); // 0 header, 1.. body
  let col = Math.min(cell, cols - 1);
  let table = info.table;
  if (dir === 1) {
    if (col + 1 < cols) col++;
    else {
      col = 0;
      if (row + 1 > table.rows.length) table = insertRow(table, table.rows.length);
      row++;
    }
  } else if (col > 0) col--;
  else if (row > 0) {
    row--;
    col = cols - 1;
  }
  apply(view, info, table, { row, col });
  return true;
}

/** Enter in a row: a new row below (below the header: the first body row). Enter in an empty last row removes it
 *  and leaves the table. False outside a table. */
export function tableEnter(view: EditorView): boolean {
  const info = infoAtCaret(view);
  if (!info) return false;
  const t = info.table;
  const k = Math.max(0, info.row - 1);
  const lastRow = t.rows.length > 0 && k === t.rows.length;
  if (lastRow && t.rows[k - 1].every((c) => c === "")) {
    const doc = view.state.doc;
    const next = deleteRow(t, k - 1);
    const from = doc.line(info.first).from;
    const to = doc.line(info.last).to;
    const text = formatTable(next).join("\n") + "\n";
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      scrollIntoView: true,
      userEvent: "input.table",
    });
    return true;
  }
  apply(view, info, insertRow(t, k), { row: k + 1, col: 0 });
  return true;
}

/** Inserts a `rows` by `cols` table after the current line (with a blank line before and after it) and selects
 *  the first header cell. */
export function insertTable(view: EditorView, rows: number, cols: number): void {
  const { state } = view;
  const doc = state.doc;
  const ln = doc.lineAt(state.selection.main.head);
  const empty = ln.text.trim() === "";
  const at = empty ? ln.from : ln.to;
  const before = empty ? "" : "\n\n";
  const lines = formatTable(newTable(rows, cols));
  const nextEmpty = ln.number >= doc.lines || doc.line(ln.number + 1).text.trim() === "";
  const text = before + lines.join("\n") + (empty && nextEmpty && ln.number < doc.lines ? "" : "\n");
  const first = cellSpans(lines[0])[0];
  const start = at + before.length + first.start;
  view.dispatch({
    changes: { from: at, to: empty ? ln.to : at, insert: text },
    selection: { anchor: start, head: at + before.length + first.end },
    scrollIntoView: true,
    userEvent: "input.table",
  });
}

/** Table edits for the context menu, for the cell at `col` of row `row` (0 header, 1.. body, 1 delimiter -> header). */
export function tableEdit(
  view: EditorView,
  info: TableInfo,
  col: number,
  op: "rowAbove" | "rowBelow" | "deleteRow" | "colLeft" | "colRight" | "deleteCol" | "left" | "center" | "right" | "format",
): void {
  const t = info.table;
  const k = Math.max(0, info.row - 1); // 0 header, 1.. body
  const c = Math.min(col, t.header.length - 1);
  switch (op) {
    case "rowAbove": // above the header means the first body row
      apply(view, info, insertRow(t, Math.max(0, k - 1)), { row: Math.max(1, k), col: c });
      break;
    case "rowBelow":
      apply(view, info, insertRow(t, k), { row: k + 1, col: c });
      break;
    case "deleteRow":
      if (k > 0) apply(view, info, deleteRow(t, k - 1), { row: Math.min(k, t.rows.length - 1), col: c });
      break;
    case "colLeft":
      apply(view, info, insertColumn(t, c), { row: k, col: c });
      break;
    case "colRight":
      apply(view, info, insertColumn(t, c + 1), { row: k, col: c + 1 });
      break;
    case "deleteCol":
      apply(view, info, deleteColumn(t, c), { row: k, col: Math.max(0, Math.min(c, t.header.length - 2)) });
      break;
    case "format":
      apply(view, info, t, { row: k, col: c });
      break;
    default:
      apply(view, info, setAlign(t, c, op), { row: k, col: c });
  }
}

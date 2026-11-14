/** What an AI action works on, and whether that text is still what it was. Pure: no DOM, no CodeMirror
 *  runtime (only structural types), so it is covered by node tests. */

/** The few things we need from a CodeMirror `Text`. */
export interface DocLike {
  readonly length: number;
  sliceString(from: number, to: number): string;
}

/** The few things we need from a CodeMirror `ChangeSet`/`ChangeDesc`. */
export interface Mapper {
  mapPos(pos: number, assoc?: number): number;
}

export interface Scope {
  /** "selection" when the main selection is non-empty, otherwise the whole file. */
  kind: "selection" | "file";
  from: number;
  to: number;
  text: string;
  words: number;
  /** Shown as a badge, e.g. "Selection, 123 words" or "Whole file, 1,234 words". */
  label: string;
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/g;

/** Words separated by whitespace; each Chinese/Japanese/Korean character counts as one (they have no spaces). */
export function countWords(text: string): number {
  return (text.replace(CJK, " x ").match(/\S+/g) ?? []).length;
}

export function describeScope(kind: Scope["kind"], words: number): string {
  const n = `${words.toLocaleString("en-US")} word${words === 1 ? "" : "s"}`;
  return `${kind === "selection" ? "Selection" : "Whole file"}, ${n}`;
}

/** Selection rule: if the MAIN selection range is not empty, use exactly that; otherwise the whole file.
 *  Other ranges of a multi-selection are ignored. */
export function resolveScope(doc: DocLike, main: { from: number; to: number }): Scope {
  const from = Math.min(main.from, main.to);
  const to = Math.max(main.from, main.to);
  const useSelection = to > from;
  const range = useSelection ? { from, to } : { from: 0, to: doc.length };
  const text = doc.sliceString(range.from, range.to);
  const words = countWords(text);
  const kind = useSelection ? "selection" : "file";
  return { kind, ...range, text, words, label: describeScope(kind, words) };
}

/** Follows a range through later edits. Text typed exactly at either edge stays outside the range. */
export function mapRange(r: { from: number; to: number }, m: Mapper): { from: number; to: number } {
  const from = m.mapPos(r.from, 1);
  return { from, to: Math.max(from, m.mapPos(r.to, -1)) };
}

/** True if the text in `range` is no longer `original`: the result no longer fits what was sent. */
export function sourceChanged(doc: DocLike, range: { from: number; to: number }, original: string): boolean {
  if (range.to > doc.length) return true;
  return doc.sliceString(range.from, range.to) !== original;
}

/** Has the text this result was made from changed? A selection is followed through edits (`range` is its
 *  mapped position); for the whole file ANY change counts, including text typed at the very end. */
export function isStale(
  kind: Scope["kind"],
  doc: DocLike,
  range: { from: number; to: number },
  original: string,
): boolean {
  if (kind === "file") return doc.length !== original.length || doc.sliceString(0, doc.length) !== original;
  return sourceChanged(doc, range, original);
}

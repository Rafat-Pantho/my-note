/** Splits text into the words that are worth spell-checking. Pure: no DOM, no IPC (tested in tokenize.test.ts).
 *
 *  A word is a run of letters (with combining marks and joiners), with apostrophes and hyphens between
 *  letters ("don't", "well-known"). Left out on purpose, because a dictionary cannot judge them:
 *  words with digits or underscores, single letters, ALL-CAPS acronyms, camelCase and mixed case
 *  (iPhone), anything inside a URL, e-mail address or file path, and in Markdown code spans, fenced
 *  blocks, link targets and HTML tags. */

export interface Word {
  from: number;
  to: number;
  text: string;
}

export interface TokenizeOptions {
  markdown?: boolean;
  /** The text starts inside a fenced code block (Markdown only). */
  inFence?: boolean;
}

const L = "\\p{L}\\p{M}\\u200C\\u200D";
/** A letter group, then optionally (apostrophe or hyphen) and more letters. Digits and `_` are matched too so a
 *  run like "abc123" is one candidate that gets rejected, not a word "abc" followed by "123". */
const CANDIDATE = new RegExp(`[${L}\\p{N}_]+(?:['’-][${L}\\p{N}_]+)*`, "gu");

const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)[^\s<>"']+/giu;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;
const WIN_PATH = /(?:[A-Za-z]:|\\\\)[\\/][^\s"'<>|]*/gu;
const INLINE_CODE = /(`+)(?:(?!\1)[^])*?\1/gu;
const LINK_TARGET = /\]\([^)\s]*(?:\s+"[^"]*")?\)/gu;
const HTML_TAG = /<\/?[A-Za-z][^>\n]*>/gu;
const REF_DEF = /^\s{0,3}\[[^\]]+\]:\s+\S+/u;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;

/** Characters that glue a word to something that is not prose (a path, a handle, a query, a number). */
const GLUE_BEFORE = new Set(["/", "\\", "@", "#", "$", "%", "=", "~", "&"]);
const GLUE_AFTER = new Set(["/", "\\", "@", "%", "=", "~"]);
const ALNUM = /[\p{L}\p{N}]/u;

/** Whether a candidate is worth checking by itself (before looking at its surroundings). */
export function isCheckable(w: string): boolean {
  if (/[\p{N}_]/u.test(w)) return false;
  const letters = w.replace(/[^\p{L}]/gu, "");
  if ([...letters].length < 2) return false;
  if (letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return false; // NASA, HTTP
  if (/\p{Ll}\p{Lu}/u.test(w)) return false; // camelCase, iPhone, McDonald
  return true;
}

function skipRanges(line: string, markdown: boolean): [number, number][] {
  const out: [number, number][] = [];
  const scan = (re: RegExp) => {
    re.lastIndex = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) out.push([m.index, m.index + m[0].length]);
  };
  scan(URL_LIKE);
  scan(EMAIL);
  scan(WIN_PATH);
  if (markdown) {
    scan(INLINE_CODE);
    scan(LINK_TARGET);
    scan(HTML_TAG);
    const ref = REF_DEF.exec(line);
    if (ref) out.push([0, ref[0].length]);
  }
  return out;
}

/** The words of one line. `base` is the document offset of the line start. */
function lineWords(line: string, base: number, markdown: boolean, out: Word[]): void {
  const skips = skipRanges(line, markdown);
  CANDIDATE.lastIndex = 0;
  for (let m = CANDIDATE.exec(line); m; m = CANDIDATE.exec(line)) {
    const s = m.index;
    const e = s + m[0].length;
    if (skips.some(([a, b]) => s < b && e > a)) continue;
    if (!isCheckable(m[0])) continue;
    const prev = line[s - 1];
    const next = line[e];
    if ((prev && GLUE_BEFORE.has(prev)) || (next && GLUE_AFTER.has(next))) continue;
    // "name.ext" and "end.Start": a dot with a letter or digit on both sides is not a sentence end.
    if (next === "." && line[e + 1] && ALNUM.test(line[e + 1])) continue;
    if (prev === "." && s >= 2 && ALNUM.test(line[s - 2])) continue;
    out.push({ from: base + s, to: base + e, text: m[0] });
  }
}

/** The words in `text`, which must start at the start of a line. Offsets are `base` + position. */
export function tokenize(text: string, base = 0, opts: TokenizeOptions = {}): Word[] {
  const out: Word[] = [];
  const markdown = !!opts.markdown;
  let inFence = markdown && !!opts.inFence;
  let pos = 0;
  while (pos <= text.length) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end);
    if (markdown && FENCE.test(line)) inFence = !inFence;
    else if (!inFence) lineWords(line, base + pos, markdown, out);
    pos = end + 1;
  }
  return out;
}

/** Whether the line `lineNumber` (1-based) of a document is inside a fenced code block, given a function that
 *  reads a line. Looks back at most `maxLines` lines: a fence further away is assumed closed. */
export function inFenceAt(lineAt: (n: number) => string, lineNumber: number, maxLines = 5000): boolean {
  let open = false;
  for (let n = Math.max(1, lineNumber - maxLines); n < lineNumber; n++) {
    if (FENCE.test(lineAt(n))) open = !open;
  }
  return open;
}

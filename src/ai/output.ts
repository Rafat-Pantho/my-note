/** Cleaning what the model returns: reasoning blocks, wrappers, line endings and edge whitespace. Pure. */

const OPEN = /^<(think|thinking|thought|reasoning)>/i;
const NAMES = ["think", "thinking", "thought", "reasoning"];
/** Longest opening tag, to know how much we might still be waiting for. */
const OPEN_MAX = 11; // "<reasoning>" and "<thinking>" are the longest

/** Could `s` (already left-trimmed, lower-cased) still become an opening tag with more text? */
function maybeOpenTag(s: string): boolean {
  return s.length < OPEN_MAX && NAMES.some((n) => `<${n}>`.startsWith(s));
}

/** Removes reasoning blocks (`<think>...</think>` and friends) that some models stream before their answer.
 *  Works on a stream: tags may be split across chunks. Only blocks at the very start of the reply are removed
 *  (that is where reasoning models put them), so a document that legitimately contains such a tag later is
 *  left alone. `push` returns the text that is safe to show; `end` flushes at the end of the stream. */
export class ThinkStripper {
  private phase: "start" | "thinking" | "body" = "start";
  private buf = "";
  private close = "";
  private afterThink = false;

  /** True while the model is inside a reasoning block (nothing is shown yet). */
  get thinking(): boolean {
    return this.phase === "thinking";
  }

  push(chunk: string): string {
    if (this.phase === "body") return chunk;
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (this.phase === "thinking") {
        const i = this.buf.toLowerCase().indexOf(this.close);
        if (i < 0) {
          this.buf = this.buf.slice(-this.close.length); // reasoning is dropped; keep a possible partial tag
          return out;
        }
        this.buf = this.buf.slice(i + this.close.length);
        this.phase = "start";
        this.afterThink = true;
        continue;
      }
      if (this.phase === "body") {
        out += this.buf;
        this.buf = "";
        return out;
      }
      // start: decide whether the reply opens with a reasoning block
      const trimmed = this.buf.trimStart();
      const m = OPEN.exec(trimmed);
      if (m) {
        this.phase = "thinking";
        this.close = `</${m[1].toLowerCase()}>`;
        this.buf = trimmed.slice(m[0].length);
        continue;
      }
      if (trimmed === "" || maybeOpenTag(trimmed.toLowerCase())) return out; // undecided: wait for more
      this.phase = "body";
      this.buf = this.afterThink ? trimmed : this.buf;
    }
  }

  /** End of stream: flush a held-back partial tag as text; an unclosed reasoning block yields nothing. */
  end(): string {
    if (this.phase === "thinking") return "";
    const rest = this.phase === "start" && this.afterThink ? this.buf.trimStart() : this.buf;
    this.buf = "";
    this.phase = "body";
    return rest;
  }
}

/** Cleans a complete reply: line endings (the editor uses `\n`), a stray <text> wrapper the model echoed,
 *  and a code fence around the whole reply when the input had none. */
export function cleanResult(raw: string, input: string): string {
  let s = raw.replace(/\r\n?/g, "\n");
  const wrapped = /^\s*<text>\n?([\s\S]*?)\n?<\/text>\s*$/i.exec(s);
  if (wrapped) s = wrapped[1];
  if (!input.includes("```")) {
    const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/.exec(s);
    if (fenced) s = fenced[1];
  }
  return s;
}

/** Gives `result` the same leading and trailing whitespace as `input`, so replacing a selection does not eat
 *  or add a trailing newline or space. */
export function matchWhitespace(result: string, input: string): string {
  const blank = input.trim() === "";
  const lead = blank ? "" : /^\s*/.exec(input)![0];
  const trail = blank ? "" : /\s*$/.exec(input)![0];
  return lead + result.trim() + trail;
}

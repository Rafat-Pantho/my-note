import assert from "node:assert/strict";
import { test } from "node:test";
import { TYPOS, correctionAt, matchCase } from "./autocorrect.ts";

/** Types `before` and presses Space: what would change at the end of it. */
const fix = (before: string, ctx = {}) => {
  const c = correctionAt(before, before.length, ctx);
  return c ? before.slice(0, c.from) + c.insert + before.slice(c.to) : null;
};

test("a typo at the caret is replaced; the rest of the line is untouched", () => {
  assert.equal(fix("I saw teh"), "I saw the");
  assert.equal(fix("recieve"), "receive");
  assert.equal(fix("dont"), "don't");
  assert.equal(fix("alot"), "a lot");
  assert.equal(fix("fine words only"), null);
});

test("capitalization follows the typo", () => {
  assert.equal(fix("Teh"), "The");
  assert.equal(fix("TEH"), "THE");
  assert.equal(fix("Alot"), "A lot");
  assert.equal(fix("tEh"), null, "mixed case is left alone");
  assert.equal(matchCase("Dont", "don't"), "Don't");
});

test("curly apostrophes are understood", () => {
  assert.equal(fix("they\u2019re ok but doesn\u2019t"), null); // already right
  assert.equal(fix("He said \u2018teh"), "He said \u2018the");
  assert.equal(fix("\u2019cause teh"), "\u2019cause the");
});

test("only the word just before the caret counts, and it must be the whole word", () => {
  assert.equal(fix("teh cat sat"), null);
  assert.equal(fix("xteh"), null);
  assert.equal(correctionAt("teh cat", 3)?.insert, "the", "caret right after the word in the middle of a line");
  assert.equal(correctionAt("teh cat", 2), null, "caret inside the typo is not a whole word");
});

test("never inside URLs, e-mail addresses, paths or identifiers", () => {
  for (const s of [
    "http://x.com/teh", "see https://exmple.com?q=teh", "www.teh", "bob@teh", "a/teh", "C:\\temp\\teh",
    "file.teh", "snake_teh", "_teh", "$teh", "#teh", "@teh", "-teh", "x.teh",
  ]) {
    assert.equal(fix(s), null, s);
  }
  assert.equal(fix("(teh"), "(the", "an opening bracket is fine");
  assert.equal(fix('"teh'), '"the');
  assert.equal(fix("*teh"), "*the");
  assert.equal(fix("see http://x.com teh"), "see http://x.com the", "a URL earlier in the line does not matter");
});

test("Markdown: never in code spans, fences or indented code", () => {
  const md = { markdown: true };
  assert.equal(fix("use `teh", md), null);
  assert.equal(fix("use `a` and teh", md), "use `a` and the");
  assert.equal(fix("teh", { ...md, inFence: true }), null);
  assert.equal(fix("    teh", md), null);
  assert.equal(fix("\tteh", md), null);
  assert.equal(fix("- teh", md), "- the");
  assert.equal(fix("a ` b teh", md), null, "an unclosed backtick before the word: inside a code span");
  assert.equal(fix("a ` b teh", {}), "a ` b the", "plain text has no code spans");
  assert.equal(fix("use `teh", {}), null, "a backtick right before the word is never prose");
});

test("words the user kept are never changed", () => {
  assert.equal(fix("teh", { keep: (w: string) => w === "teh" }), null);
  assert.equal(fix("teh", { keep: (w: string) => w === "other" }), "the");
});

test("real words that can be a typo are corrected only in lower case", () => {
  assert.equal(fix("cant"), "can't");
  assert.equal(fix("Cant"), null);
  assert.equal(fix("CANT"), null);
  assert.equal(fix("wont"), "won't");
  assert.equal(fix("ive"), "I've");
});

test("the list itself is sane", () => {
  for (const [typo, right] of Object.entries(TYPOS)) {
    assert.equal(typo, typo.toLowerCase(), typo);
    assert.notEqual(typo, right, typo);
    assert.ok(typo.length >= 3, `${typo}: shorter words are never corrected`);
    assert.ok(!(right in TYPOS), `${typo} -> ${right} would chain`);
  }
  assert.ok(Object.keys(TYPOS).length > 100);
  assert.equal(correctionAt("constructor", 11), null, "prototype names are not typos");
});

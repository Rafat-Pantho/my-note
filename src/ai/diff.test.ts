import assert from "node:assert/strict";
import { test } from "node:test";
import { type DiffOp, diffStats, diffWords, tokenize } from "./diff.ts";

const side = (ops: DiffOp[], keep: DiffOp["t"][]) =>
  ops.filter((o) => keep.includes(o.t)).map((o) => o.s).join("");

/** The defining property: eq+del rebuilds `a`, eq+ins rebuilds `b`. */
function roundTrip(a: string, b: string): DiffOp[] {
  const ops = diffWords(a, b);
  assert.equal(side(ops, ["eq", "del"]), a, "original");
  assert.equal(side(ops, ["eq", "ins"]), b, "result");
  for (let i = 1; i < ops.length; i++) assert.notEqual(ops[i].t, ops[i - 1].t, "runs are merged");
  return ops;
}

test("identical and empty inputs", () => {
  assert.deepEqual(diffWords("same text", "same text"), [{ t: "eq", s: "same text" }]);
  assert.deepEqual(diffWords("", ""), []);
  assert.deepEqual(diffWords("", "new"), [{ t: "ins", s: "new" }]);
  assert.deepEqual(diffWords("old", ""), [{ t: "del", s: "old" }]);
});

test("a changed word is a delete then an insert", () => {
  const ops = roundTrip("the quick brown fox", "the slow brown fox");
  assert.deepEqual(ops, [
    { t: "eq", s: "the " },
    { t: "del", s: "quick" },
    { t: "ins", s: "slow" },
    { t: "eq", s: " brown fox" },
  ]);
});

test("insertions and deletions in the middle", () => {
  assert.deepEqual(roundTrip("a b d", "a b c d"), [
    { t: "eq", s: "a b " },
    { t: "ins", s: "c " },
    { t: "eq", s: "d" },
  ]);
  assert.deepEqual(roundTrip("a b c d", "a b d"), [
    { t: "eq", s: "a b " },
    { t: "del", s: "c " },
    { t: "eq", s: "d" },
  ]);
});

test("punctuation is its own token, so a comma change does not mark the word", () => {
  assert.deepEqual(tokenize("Hello, world!"), ["Hello", ",", " ", "world", "!"]);
  assert.deepEqual(roundTrip("Hello world", "Hello, world"), [
    { t: "eq", s: "Hello" },
    { t: "ins", s: "," },
    { t: "eq", s: " world" },
  ]);
});

test("whitespace and non-Latin text survive", () => {
  roundTrip("line one\nline two\n", "line one\n\nline 2\n");
  roundTrip("Привет мир", "Привет, новый мир");
  roundTrip("日本語のテキスト", "日本語の文章");
});

test("an unrelated rewrite", () => {
  roundTrip("alpha beta gamma delta", "one two three");
});

test("stats count words, not punctuation or spaces", () => {
  const ops = diffWords("the quick brown fox", "the slow, brown cat jumps");
  const s = diffStats(ops);
  assert.deepEqual(s, { added: 3, removed: 2 }); // +slow +cat +jumps  -quick -fox
});

test("random edits always round-trip", () => {
  let seed = 12345;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const words = ["a", "bb", "ccc", "the", "of", ",", ".", "\n", "x1", "é"];
  const make = (n: number) => Array.from({ length: n }, () => words[rnd(words.length)]).join(" ");
  for (let i = 0; i < 60; i++) {
    const a = make(rnd(40));
    const chars = a.split(" ");
    for (let j = 0; j < rnd(6); j++) chars.splice(rnd(chars.length + 1), rnd(3), words[rnd(words.length)]);
    roundTrip(a, chars.join(" "));
  }
});

test("a big, very different pair falls back to a coarse replacement instead of hanging", () => {
  const a = Array.from({ length: 4000 }, (_, i) => `a${i}`).join(" ");
  const b = Array.from({ length: 4000 }, (_, i) => `b${i}`).join(" ");
  const t0 = Date.now();
  const ops = roundTrip(a, b);
  assert.ok(Date.now() - t0 < 3000, "finishes quickly");
  assert.deepEqual(ops.map((o) => o.t), ["del", "ins"]);
});

test("a long text with a few edits is still an exact diff", () => {
  const words = Array.from({ length: 3000 }, (_, i) => `w${i}`);
  const edited = [...words];
  edited[10] = "CHANGED";
  edited.splice(1500, 0, "extra");
  edited.splice(2000, 3);
  const ops = roundTrip(words.join(" "), edited.join(" "));
  assert.ok(ops.length <= 12, `few runs, got ${ops.length}`);
});

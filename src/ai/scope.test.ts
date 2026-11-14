import assert from "node:assert/strict";
import { test } from "node:test";
import { ChangeSet, Text } from "@codemirror/state";
import { countWords, describeScope, isStale, mapRange, resolveScope, sourceChanged } from "./scope.ts";

const doc = (s: string) => Text.of(s.split("\n"));

test("selection wins when the main selection is not empty", () => {
  const d = doc("one two three\nfour five");
  const s = resolveScope(d, { from: 4, to: 13 });
  assert.equal(s.kind, "selection");
  assert.equal(s.text, "two three");
  assert.deepEqual([s.from, s.to], [4, 13]);
  assert.equal(s.label, "Selection, 2 words");
});

test("no selection means the whole file", () => {
  const d = doc("one two three\nfour five");
  const s = resolveScope(d, { from: 6, to: 6 });
  assert.equal(s.kind, "file");
  assert.equal(s.text, "one two three\nfour five");
  assert.deepEqual([s.from, s.to], [0, d.length]);
  assert.equal(s.label, "Whole file, 5 words");
});

test("a backwards selection is normalized; a whitespace-only selection still counts as a selection", () => {
  const d = doc("a   b");
  const back = resolveScope(d, { from: 5, to: 2 });
  assert.deepEqual([back.kind, back.from, back.to, back.text], ["selection", 2, 5, "  b"]);
  const ws = resolveScope(d, { from: 1, to: 4 });
  assert.deepEqual([ws.kind, ws.words, ws.label], ["selection", 0, "Selection, 0 words"]);
});

test("an empty file is the whole file with zero words", () => {
  const s = resolveScope(doc(""), { from: 0, to: 0 });
  assert.deepEqual([s.kind, s.text, s.words, s.label], ["file", "", 0, "Whole file, 0 words"]);
});

test("word counts and badge wording", () => {
  assert.equal(countWords("  hello   world \n again "), 3);
  assert.equal(countWords(""), 0);
  assert.equal(countWords("日本語のテキスト"), 8, "each CJK character counts as a word");
  assert.equal(describeScope("selection", 1), "Selection, 1 word");
  assert.equal(describeScope("file", 1234), "Whole file, 1,234 words");
});

test("a range follows edits before and after it, and stays put for typing at its edges", () => {
  const d = doc("0123456789");
  const range = { from: 3, to: 6 }; // "345"
  const through = (from: number, to: number, insert: string) =>
    mapRange(range, ChangeSet.of({ from, to, insert }, d.length));
  assert.deepEqual(through(0, 0, "XX"), { from: 5, to: 8 }, "insert before");
  assert.deepEqual(through(8, 8, "XX"), { from: 3, to: 6 }, "insert after");
  assert.deepEqual(through(3, 3, "XX"), { from: 5, to: 8 }, "typing at the start stays outside");
  assert.deepEqual(through(6, 6, "XX"), { from: 3, to: 6 }, "typing at the end stays outside");
  assert.deepEqual(through(0, 9, ""), { from: 0, to: 0 }, "deleted around it collapses");
});

test("source change detection: only edits that touch the sent text count", () => {
  const original = "345";
  const before = doc("0123456789");
  const range = { from: 3, to: 6 };
  assert.equal(sourceChanged(before, range, original), false);
  // an edit elsewhere moves the range but not its text
  const cs = ChangeSet.of({ from: 0, to: 0, insert: "ab" }, before.length);
  const after = cs.apply(before);
  assert.equal(sourceChanged(after, mapRange(range, cs), original), false);
  // an edit inside changes it
  const cs2 = ChangeSet.of({ from: 4, to: 5, insert: "X" }, before.length);
  assert.equal(sourceChanged(cs2.apply(before), mapRange(range, cs2), original), true);
  // a range past the end of the document is changed by definition
  assert.equal(sourceChanged(doc("01"), { from: 3, to: 6 }, original), true);
});

test("isStale: a whole-file result is stale after ANY change, even typing at the very end", () => {
  const original = "one two";
  const d = doc(original);
  assert.equal(isStale("file", d, { from: 0, to: 7 }, original), false);
  const cs = ChangeSet.of({ from: 7, to: 7, insert: "!" }, d.length);
  assert.equal(isStale("file", cs.apply(d), mapRange({ from: 0, to: 7 }, cs), original), true);
  // the same edit does not make a SELECTION result stale unless it touches the selected text
  assert.equal(isStale("selection", cs.apply(d), mapRange({ from: 0, to: 3 }, cs), "one"), false);
});

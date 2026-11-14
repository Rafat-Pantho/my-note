import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@codemirror/state";
import { type Placement, planChange } from "./apply.ts";

const doc = (s: string) => Text.of(s.split("\n"));
/** Applies a plan to a string, for readable expectations. */
function apply(text: string, scope: [number, number], placement: Placement, result: string, cursor = 0) {
  const p = planChange(doc(text), { from: scope[0], to: scope[1] }, placement, result, cursor);
  return text.slice(0, p.from) + p.insert + text.slice(p.to);
}

test("replace swaps the scope's text", () => {
  assert.equal(apply("one two three", [4, 7], "replace", "2"), "one 2 three");
  assert.equal(apply("whole", [0, 5], "replace", "all new"), "all new");
});

test("below: after the line that holds the end of the selection, with a blank line between", () => {
  assert.equal(apply("first\nsecond\nthird", [0, 3], "below", "S"), "first\n\nS\n\nsecond\nthird");
  assert.equal(apply("first\nsecond\nthird", [8, 10], "below", "S"), "first\nsecond\n\nS\n\nthird");
});

test("below: a selection that ends right after a line break belongs to that line", () => {
  assert.equal(apply("first\nsecond\nthird", [0, 6], "below", "S"), "first\n\nS\n\nsecond\nthird");
});

test("below: at the end of the file, with or without a final newline, and in an empty file", () => {
  assert.equal(apply("one\ntwo", [0, 7], "below", "S"), "one\ntwo\n\nS");
  assert.equal(apply("one\ntwo\n", [0, 8], "below", "S"), "one\ntwo\n\nS");
  assert.equal(apply("", [0, 0], "below", "S\n\n"), "S", "trailing newlines of the reply are dropped");
});

test("append continues the text, adding a space only when needed", () => {
  assert.equal(apply("The cat sat", [0, 11], "append", "on the mat."), "The cat sat on the mat.");
  assert.equal(apply("The cat sat ", [0, 12], "append", "on the mat."), "The cat sat on the mat.");
  assert.equal(apply("Wait", [0, 4], "append", ", what?"), "Wait, what?");
  assert.equal(apply("Line", [0, 4], "append", "\nNext line"), "Line\nNext line");
  assert.equal(apply("", [0, 0], "append", "Start"), "Start");
  assert.equal(apply("ab cd ef", [3, 5], "append", "gh"), "ab cd gh ef");
});

test("cursor inserts at the given position, clamped into the document", () => {
  assert.equal(apply("abcdef", [0, 6], "cursor", "-", 3), "abc-def");
  assert.equal(apply("abc", [0, 3], "cursor", "-", 99), "abc-");
  assert.equal(apply("abc", [0, 3], "cursor", "-", -5), "-abc");
});

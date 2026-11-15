import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTRA_CONTROL_CHARS, controlLabel } from "./controlchars.ts";

test("joiners and bidi marks have readable names", () => {
  assert.equal(controlLabel(0x200d), "ZWJ");
  assert.equal(controlLabel(0x200c), "ZWNJ");
  assert.equal(controlLabel(0x200e), "LRM");
  assert.equal(controlLabel(0x200f), "RLM");
  assert.equal(controlLabel(0x202e), "RLO");
});

test("other controls fall back to the code point", () => {
  assert.equal(controlLabel(0x01), "U+0001");
  assert.equal(controlLabel(0x9f), "U+009F");
});

test("the extra list adds exactly what CodeMirror's default misses", () => {
  for (const c of [0x200c, 0x200d, 0x202a, 0x202b, 0x202c, 0x2068, 0x2060, 0x2064]) {
    assert.ok(EXTRA_CONTROL_CHARS.test(String.fromCharCode(c)), c.toString(16));
  }
  assert.ok(!EXTRA_CONTROL_CHARS.test("a"));
  assert.ok(!EXTRA_CONTROL_CHARS.test("ক")); // Bengali letters are never touched
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { ThinkStripper, cleanResult, matchWhitespace } from "./output.ts";

/** Feeds `s` in pieces of `step` characters and returns everything shown. */
function run(s: string, step: number): { shown: string; thinking: boolean } {
  const t = new ThinkStripper();
  let shown = "";
  let thinking = false;
  for (let i = 0; i < s.length; i += step) {
    shown += t.push(s.slice(i, i + step));
    thinking ||= t.thinking;
  }
  return { shown: shown + t.end(), thinking };
}

const everyStep = (s: string, want: string) => {
  for (const step of [s.length || 1, 1, 2, 3, 5, 7]) assert.equal(run(s, step).shown, want, `step ${step}`);
};

test("a leading think block is removed, however the stream is split", () => {
  everyStep("<think>let me consider\nthe options</think>\n\nThe answer.", "The answer.");
  everyStep("<think></think>Hi", "Hi");
  everyStep("  <thinking>x</thinking>  Hello there", "Hello there");
  everyStep("<reasoning>a</reasoning><think>b</think>Done", "Done");
  everyStep("<THINK>x</THINK>ok", "ok");
});

test("text without reasoning passes through untouched, including leading whitespace", () => {
  everyStep("Plain reply", "Plain reply");
  everyStep("  indented start", "  indented start");
  everyStep("<b>bold</b> is not reasoning", "<b>bold</b> is not reasoning");
  everyStep("<thinker> is not a tag we know", "<thinker> is not a tag we know");
  everyStep("", "");
});

test("only a block at the very start is removed: a later tag in the document stays", () => {
  everyStep("Intro <think>kept</think> outro", "Intro <think>kept</think> outro");
});

test("an unclosed reasoning block yields nothing, and reports that the model is thinking", () => {
  const r = run("<think>never finishes and no answer", 4);
  assert.equal(r.shown, "");
  assert.equal(r.thinking, true);
});

test("a partial tag at the very end of the stream is real text", () => {
  everyStep("<thi", "<thi");
  everyStep("<", "<");
});

test("closing tag split across chunks", () => {
  const t = new ThinkStripper();
  assert.equal(t.push("<think>abc</thi"), "");
  assert.equal(t.push("nk>\nAnswer"), "Answer");
  assert.equal(t.push(" more"), " more");
  assert.equal(t.end(), "");
});

test("cleanResult: line endings, echoed wrapper, fences", () => {
  assert.equal(cleanResult("a\r\nb\rc", "x"), "a\nb\nc");
  assert.equal(cleanResult("<text>\nHello\n</text>", "x"), "Hello");
  assert.equal(cleanResult("```\nHello\nworld\n```", "plain"), "Hello\nworld");
  assert.equal(cleanResult("```text\nHello\n```\n", "plain"), "Hello");
  // the input had fences: the reply's fences are part of the content
  assert.equal(cleanResult("```js\nlet a;\n```", "```js\nvar a;\n```"), "```js\nlet a;\n```");
  // a fence that does not wrap the whole reply stays
  assert.equal(cleanResult("Before\n```\ncode\n```\nAfter", "plain"), "Before\n```\ncode\n```\nAfter");
});

test("matchWhitespace keeps the input's leading and trailing whitespace", () => {
  assert.equal(matchWhitespace("Hi", "  Hello world\n"), "  Hi\n");
  assert.equal(matchWhitespace("\n\nHi\n\n", "Hello"), "Hi");
  assert.equal(matchWhitespace("Hi", "Hello "), "Hi ");
  assert.equal(matchWhitespace("Hi there", ""), "Hi there");
  assert.equal(matchWhitespace("Hi", "   "), "Hi", "an all-whitespace input adds no padding");
});

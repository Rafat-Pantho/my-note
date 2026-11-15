import assert from "node:assert/strict";
import { test } from "node:test";
import { inFenceAt, isCheckable, tokenize } from "./tokenize.ts";

const words = (text: string, opts = {}) => tokenize(text, 0, opts).map((w) => w.text);

test("plain words, with offsets that point at the words", () => {
  const text = "This is a tset.\nSecond line";
  const t = tokenize(text, 100);
  assert.deepEqual(t.map((w) => w.text), ["This", "is", "tset", "Second", "line"]); // "a" is a single letter
  for (const w of t) assert.equal(text.slice(w.from - 100, w.to - 100), w.text);
});

test("apostrophes and hyphens inside a word stay in it; at the edges they do not", () => {
  assert.deepEqual(words("don't well-known rock'n'roll"), ["don't", "well-known", "rock'n'roll"]);
  assert.deepEqual(words("don\u2019t"), ["don\u2019t"]);
  assert.deepEqual(words("'quoted' -flag --other word-"), ["quoted", "flag", "other", "word"]);
});

test("words with digits or underscores, single letters, acronyms and camelCase are skipped", () => {
  assert.deepEqual(words("abc123 3rd snake_case x NASA HTTP2 camelCase iPhone McDonald Normal"), ["Normal"]);
  assert.equal(isCheckable("hello"), true);
  assert.equal(isCheckable("Hello"), true);
  assert.equal(isCheckable("HELLO"), false);
  assert.equal(isCheckable("ab"), true);
  assert.equal(isCheckable("a"), false);
});

test("URLs, e-mail addresses and paths are not checked", () => {
  assert.deepEqual(words("see https://exmple.com/pagee?x=1 now"), ["see", "now"]);
  assert.deepEqual(words("write to jon.smyth@exmple.org please"), ["write", "to", "please"]);
  assert.deepEqual(words("open C:\\Usrs\\Bob\\file.txt and www.exmple.com ok"), ["open", "and", "ok"]);
  assert.deepEqual(words("in /usr/locl/bin and ~/dcs/note"), ["in", "and"]);
  assert.deepEqual(words("file.txt end.Start done."), ["done"]); // name.ext and run-together sentences
});

test("a sentence-ending dot is not glue", () => {
  assert.deepEqual(words("Hello world. Next sentence.Maybe"), ["Hello", "world", "Next"]);
});

test("Bengali and other scripts are tokenized whole (marks and joiners stay in the word)", () => {
  assert.deepEqual(words("বিশ্ববিদ্যালয় আমি"), ["বিশ্ববিদ্যালয়", "আমি"]);
  assert.deepEqual(words("ক্\u200Dষ"), ["ক্\u200Dষ"]);
});

test("Markdown: code spans, fences, link targets, HTML tags and reference links are skipped", () => {
  const md = { markdown: true };
  assert.deepEqual(words("use `somefunc` here", md), ["use", "here"]);
  assert.deepEqual(words("use ``a`b tset`` here", md), ["use", "here"]);
  assert.deepEqual(words('a [link txt](http://exmple.com/pth "titel") b', md), ["link", "txt"]);
  assert.deepEqual(words('<span clas="x">word</span>', md), ["word"]);
  assert.deepEqual(words("[ref]: http://exmple.com/x\nafter", md), ["after"]);
  assert.deepEqual(words("before\n```js\nconst tset = 1\n```\nafter", md), ["before", "after"]);
  assert.deepEqual(words("~~~\nhidden wrds\n~~~\nshown", md), ["shown"]);
  // the same text as plain text: backticks mean nothing
  assert.deepEqual(words("use `somefunc` here"), ["use", "somefunc", "here"]);
});

test("a chunk can start inside a fence", () => {
  assert.deepEqual(words("inside wrds\n```\nout", { markdown: true, inFence: true }), ["out"]);
  const lines = ["text", "```", "code", "more code", "```", "text"];
  const at = (n: number) => lines[n - 1];
  assert.equal(inFenceAt(at, 1), false);
  assert.equal(inFenceAt(at, 3), true);
  assert.equal(inFenceAt(at, 4), true);
  assert.equal(inFenceAt(at, 6), false);
  assert.equal(inFenceAt(at, 4, 1), false, "a fence beyond the look-back is assumed closed");
});

test("empty text and blank lines are fine", () => {
  assert.deepEqual(words(""), []);
  assert.deepEqual(words("\n\n  \n"), []);
});

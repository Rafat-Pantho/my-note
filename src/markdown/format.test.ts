import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeView, show } from "./fakeview.ts";
import { makeLink, run, setHeading, toggleCode, toggleInline, toggleList, toggleQuote } from "./format.ts";

const sel = (doc: string, from: number, to: number) => fakeView(doc, { anchor: from, head: to });

test("bold wraps the selection and unwraps it again", () => {
  const v = sel("a word b", 2, 6);
  run(v, (s) => toggleInline(s, "**"));
  assert.equal(show(v), "a **[word]** b");
  run(v, (s) => toggleInline(s, "**"));
  assert.equal(show(v), "a [word] b");
});

test("a caret inside a word formats the word; a caret outside a word inserts a pair", () => {
  let v = fakeView("a wo|rd b");
  run(v, (s) => toggleInline(s, "*"));
  assert.equal(v.state.doc.toString(), "a *word* b");
  v = fakeView("a |");
  run(v, (s) => toggleInline(s, "**"));
  assert.equal(show(v), "a **|**");
});

test("italic and bold combine and come off independently", () => {
  const v = sel("word", 0, 4);
  run(v, (s) => toggleInline(s, "**"));
  run(v, (s) => toggleInline(s, "*"));
  assert.equal(v.state.doc.toString(), "***word***");
  run(v, (s) => toggleInline(s, "**"));
  assert.equal(v.state.doc.toString(), "*word*");
  run(v, (s) => toggleInline(s, "*"));
  assert.equal(v.state.doc.toString(), "word");
});

test("italic on bold text adds a star pair instead of breaking the bold", () => {
  const v = sel("**word**", 2, 6);
  run(v, (s) => toggleInline(s, "*"));
  assert.equal(v.state.doc.toString(), "***word***");
});

test("selecting the marks themselves also toggles", () => {
  const v = sel("**word**", 0, 8);
  run(v, (s) => toggleInline(s, "**"));
  assert.equal(v.state.doc.toString(), "word");
});

test("strikethrough and inline code", () => {
  let v = sel("x gone y", 2, 6);
  run(v, (s) => toggleInline(s, "~~"));
  assert.equal(v.state.doc.toString(), "x ~~gone~~ y");
  run(v, (s) => toggleInline(s, "~~"));
  assert.equal(v.state.doc.toString(), "x gone y");
  v = sel("call f now", 5, 6);
  run(v, (s) => toggleCode(s));
  assert.equal(v.state.doc.toString(), "call `f` now");
});

test("a selection over several lines becomes a fenced code block", () => {
  const v = sel("a\nb\nc", 0, 3);
  run(v, (s) => toggleCode(s));
  assert.equal(v.state.doc.toString(), "```\na\nb\n```\nc");
});

test("headings: set, change, remove, and plain text", () => {
  let v = fakeView("title|");
  run(v, (s) => setHeading(s, 2));
  assert.equal(v.state.doc.toString(), "## title");
  run(v, (s) => setHeading(s, 3));
  assert.equal(v.state.doc.toString(), "### title");
  run(v, (s) => setHeading(s, 3));
  assert.equal(v.state.doc.toString(), "title", "the same level again removes it");
  v = fakeView("# title|");
  run(v, (s) => setHeading(s, 0));
  assert.equal(v.state.doc.toString(), "title");
  v = sel("a\nb", 0, 3);
  run(v, (s) => setHeading(s, 1));
  assert.equal(v.state.doc.toString(), "# a\n# b");
  assert.equal(setHeading(fakeView("|").state, 1), null, "an empty line is left alone");
});

test("bulleted and numbered lists on selected lines, and back", () => {
  let v = sel("a\nb\n\nc", 0, 6);
  run(v, (s) => toggleList(s, false));
  assert.equal(v.state.doc.toString(), "- a\n- b\n\n- c");
  run(v, (s) => toggleList(s, false));
  assert.equal(v.state.doc.toString(), "a\nb\n\nc");
  v = sel("a\nb\nc", 0, 5);
  run(v, (s) => toggleList(s, true));
  assert.equal(v.state.doc.toString(), "1. a\n2. b\n3. c");
  run(v, (s) => toggleList(s, false));
  assert.equal(v.state.doc.toString(), "- a\n- b\n- c", "another list type is replaced");
  v = fakeView("  nested|");
  run(v, (s) => toggleList(s, false));
  assert.equal(v.state.doc.toString(), "  - nested", "indentation is kept");
  v = fakeView("|");
  run(v, (s) => toggleList(s, true));
  assert.equal(v.state.doc.toString(), "1. ");
});

test("quote on and off, empty lines get a bare marker", () => {
  const v = sel("a\n\nb", 0, 4);
  run(v, (s) => toggleQuote(s));
  assert.equal(v.state.doc.toString(), "> a\n>\n> b");
  run(v, (s) => toggleQuote(s));
  assert.equal(v.state.doc.toString(), "a\n\nb");
});

test("link: text selected -> the address is selected; an address selected -> it becomes the target", () => {
  let v = sel("see site now", 4, 8);
  run(v, (s) => makeLink(s));
  assert.equal(v.state.doc.toString(), "see [site](https://) now");
  assert.equal(show(v), "see [site]([https://]) now");
  v = sel("go https://example.com/x", 3, 24);
  run(v, (s) => makeLink(s));
  assert.equal(v.state.doc.toString(), "go [](https://example.com/x)");
  assert.equal(v.state.selection.main.head, 4);
  v = fakeView("|");
  run(v, (s) => makeLink(s));
  assert.equal(show(v), "[|](https://)");
});

test("only Markdown syntax is ever written", () => {
  const v = sel("some text here", 0, 14);
  for (const f of [(s: never) => toggleInline(s, "**"), (s: never) => toggleList(s, false), (s: never) => toggleQuote(s), (s: never) => setHeading(s, 2)]) {
    run(v, f as never);
  }
  assert.ok(!/<|&[a-z]+;| /.test(v.state.doc.toString()), v.state.doc.toString());
});

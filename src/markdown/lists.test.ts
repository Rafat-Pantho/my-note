import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeView, show } from "./fakeview.ts";
import { enterAction, listEnter, listTab, nestWidth, nextMarker, parseListLine, shiftItem } from "./lists.ts";

test("list items are recognised, thematic breaks and plain text are not", () => {
  assert.equal(parseListLine("- item")?.text, "item");
  assert.equal(parseListLine("  * item")?.indent, "  ");
  assert.equal(parseListLine("+ item")?.marker, "+");
  assert.equal(parseListLine("12. twelve")?.num, 12);
  assert.equal(parseListLine("3) three")?.marker, "3)");
  assert.equal(parseListLine("- [ ] todo")?.task, "[ ] ");
  assert.equal(parseListLine("- [x] done")?.text, "done");
  assert.ok(parseListLine("-"));
  for (const no of ["plain", "---", "***", "- - -", "* * *", "-x", "1.x", "#1 not a list", "", "> quote"]) {
    assert.equal(parseListLine(no), null, no);
  }
});

test("Enter continues a bullet list with the same marker and indent", () => {
  assert.deepEqual(enterAction("- one", 5), { type: "continue", insert: "\n- " });
  assert.deepEqual(enterAction("* one", 5), { type: "continue", insert: "\n* " });
  assert.deepEqual(enterAction("    - nested", 12), { type: "continue", insert: "\n    - " });
});

test("Enter continues a numbered list with the next number and the same delimiter", () => {
  assert.deepEqual(enterAction("1. one", 6), { type: "continue", insert: "\n2. " });
  assert.deepEqual(enterAction("9. nine", 7), { type: "continue", insert: "\n10. " });
  assert.deepEqual(enterAction("3) three", 8), { type: "continue", insert: "\n4) " });
  assert.deepEqual(enterAction("  2. nested", 11), { type: "continue", insert: "\n  3. " });
});

test("a task item continues as an unchecked task", () => {
  assert.deepEqual(enterAction("- [x] done", 10), { type: "continue", insert: "\n- [ ] " });
  assert.deepEqual(enterAction("- [ ] todo", 10), { type: "continue", insert: "\n- [ ] " });
});

test("Enter in the middle of an item splits it (the new marker goes at the caret)", () => {
  assert.deepEqual(enterAction("- hello world", 7), { type: "continue", insert: "\n- " });
});

test("Enter on an empty item ends the list", () => {
  assert.deepEqual(enterAction("- ", 2), { type: "end", from: 0, to: 2, insert: "" });
  assert.deepEqual(enterAction("1. ", 3), { type: "end", from: 0, to: 3, insert: "" });
  assert.deepEqual(enterAction("- [ ] ", 6), { type: "end", from: 0, to: 6, insert: "" });
  assert.deepEqual(enterAction("-   ", 4), { type: "end", from: 0, to: 4, insert: "" });
});

test("Enter on an empty nested item steps out one level first", () => {
  assert.deepEqual(enterAction("  - ", 4), { type: "end", from: 0, to: 2, insert: "" });
  assert.deepEqual(enterAction("   1. ", 6), { type: "end", from: 0, to: 3, insert: "" });
});

test("Enter in the marker or outside a list is left to the editor", () => {
  assert.equal(enterAction("- item", 0), null);
  assert.equal(enterAction("- item", 1), null);
  assert.equal(enterAction("1. item", 2), null);
  assert.equal(enterAction("plain text", 5), null);
  assert.equal(enterAction("> quote", 7), null);
  assert.equal(enterAction("", 0), null);
});

test("nested indentation follows the marker width", () => {
  assert.equal(nestWidth(parseListLine("- a")!), 2);
  assert.equal(nestWidth(parseListLine("1. a")!), 3);
  assert.equal(nestWidth(parseListLine("10. a")!), 4);
  assert.equal(shiftItem("- a", 1), "  - a");
  assert.equal(shiftItem("1. a", 1), "   1. a");
  assert.equal(shiftItem("  - a", -1), "- a");
  assert.equal(shiftItem("   1. a", -1), "1. a");
  assert.equal(shiftItem("- a", -1), null, "cannot go further out");
  assert.equal(shiftItem("\t- a", -1), "- a");
  assert.equal(shiftItem("text", 1), null);
  assert.equal(nextMarker(parseListLine("  1. a")!), "  2. ");
});

const editor = (doc: string) => fakeView(doc);

test("the Enter command continues, ends, and leaves other lines alone", () => {
  let v = editor("- one|");
  assert.equal(listEnter(v), true);
  assert.equal(show(v), "- one\n- |");
  assert.equal(listEnter(v), true); // empty item: the list ends
  assert.equal(show(v), "- one\n|");
  assert.equal(listEnter(v), false);

  v = editor("1. a\n2. b|");
  listEnter(v);
  assert.equal(show(v), "1. a\n2. b\n3. |");

  v = editor("- a\n  - |");
  listEnter(v);
  assert.equal(show(v), "- a\n- |", "empty nested item steps out");
  listEnter(v);
  assert.equal(show(v), "- a\n|");
});

test("Enter inside a fenced code block is not a list", () => {
  const v = editor("```\n- not a list|\n```");
  assert.equal(listEnter(v), false);
});

test("Tab and Shift+Tab nest and un-nest, over several lines, in one change", () => {
  let v = editor("- a\n- b|");
  assert.equal(listTab(v, 1), true);
  assert.equal(v.state.doc.toString(), "- a\n  - b");
  assert.equal(listTab(v, -1), true);
  assert.equal(v.state.doc.toString(), "- a\n- b");
  assert.equal(listTab(v, -1), true, "Shift+Tab at the top level does nothing but is still handled");
  assert.equal(v.state.doc.toString(), "- a\n- b");

  v = fakeView("- a\n- b\ntext", { anchor: 0, head: 7 });
  listTab(v, 1);
  assert.equal(v.state.doc.toString(), "  - a\n  - b\ntext");

  v = editor("plain|");
  assert.equal(listTab(v, 1), false, "not a list: Tab is left to the editor");
});

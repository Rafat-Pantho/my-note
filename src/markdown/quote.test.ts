import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeView, show } from "./fakeview.ts";
import { quoteAction, quoteEnter } from "./lists.ts";

test("Enter in a block quote continues it; on an empty quote line it ends it", () => {
  assert.deepEqual(quoteAction("> hello", 7), { type: "continue", insert: "\n> " });
  assert.deepEqual(quoteAction(">hello", 6), { type: "continue", insert: "\n> " });
  assert.deepEqual(quoteAction("> > nested", 10), { type: "continue", insert: "\n> > " });
  assert.deepEqual(quoteAction("> ", 2), { type: "end", from: 0, to: 2, insert: "" });
  assert.deepEqual(quoteAction(">", 1), { type: "end", from: 0, to: 1, insert: "" });
  assert.equal(quoteAction("plain", 5), null);
  assert.equal(quoteAction("> hello", 0), null, "caret before the marker");
});

test("the quote command edits the document", () => {
  const v = fakeView("> one|");
  assert.equal(quoteEnter(v), true);
  assert.equal(show(v), "> one\n> |");
  assert.equal(quoteEnter(v), true);
  assert.equal(show(v), "> one\n|");
  assert.equal(quoteEnter(v), false);
});

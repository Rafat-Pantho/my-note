import assert from "node:assert/strict";
import { test } from "node:test";
import { FILE_TYPES, fileTypeOf, spellKindFor } from "./spelltypes.ts";

test("file types from the path", () => {
  assert.equal(fileTypeOf(null), "untitled");
  assert.equal(fileTypeOf("C:\\notes\\todo.txt"), "text");
  assert.equal(fileTypeOf("/home/a/README"), "text");
  assert.equal(fileTypeOf("README.MD"), "markdown");
  assert.equal(fileTypeOf("a.markdown"), "markdown");
  assert.equal(fileTypeOf("index.html"), "web");
  assert.equal(fileTypeOf("config.JSON"), "data");
  assert.equal(fileTypeOf("run.log"), "data");
  assert.equal(fileTypeOf("main.rs"), "code");
  assert.equal(fileTypeOf("Makefile"), "code");
  assert.equal(fileTypeOf(".gitignore"), "data");
  assert.equal(fileTypeOf("photo.xyz"), "other");
  assert.equal(fileTypeOf("dir.d/file"), "text", "a dot in a folder name is not an extension");
});

test("the default switches: plain text, Markdown and untitled on, everything else off", () => {
  const defaults: Record<string, boolean> = {
    untitled: true, text: true, markdown: true, web: false, data: false, code: false, other: false,
  };
  assert.deepEqual(FILE_TYPES.map((t) => t.id).sort(), Object.keys(defaults).sort());
  assert.equal(spellKindFor(null, defaults), "text");
  assert.equal(spellKindFor("a.txt", defaults), "text");
  assert.equal(spellKindFor("a.md", defaults), "markdown");
  assert.equal(spellKindFor("a.py", defaults), null);
  assert.equal(spellKindFor("a.json", defaults), null);
  assert.equal(spellKindFor("a.py", { ...defaults, code: true }), "text");
  assert.equal(spellKindFor("a.md", { ...defaults, markdown: false }), null);
  assert.equal(spellKindFor("a.txt", {}), null);
});

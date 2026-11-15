import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SPELL_EXTENSIONS as D, NO_EXTENSION, extensionOf, parseExtensions, spellKindFor } from "./spelltypes.ts";

const on = { untitled: true };

test("extension of a path", () => {
  assert.equal(extensionOf("C:\\notes\\todo.TXT"), "txt");
  assert.equal(extensionOf("/home/a/README"), NO_EXTENSION);
  assert.equal(extensionOf("a.tar.gz"), "gz");
  assert.equal(extensionOf("notes."), NO_EXTENSION);
  assert.equal(extensionOf("dir.d/file"), NO_EXTENSION, "a dot in a folder name is not an extension");
  assert.equal(extensionOf("Makefile"), null);
  assert.equal(extensionOf(".gitignore"), null);
});

test("the list accepts dots, commas, case and the word none", () => {
  assert.deepEqual([...parseExtensions(".TXT, md;*.log none")].sort(), ["(none)", "log", "md", "txt"]);
  assert.equal(parseExtensions("  ").size, 0);
});

test("defaults: .txt and no extension on; code, config and log off", () => {
  assert.equal(spellKindFor("a.txt", on, D), "text");
  assert.equal(spellKindFor("/x/README", on, D), "text");
  for (const f of ["a.log", "a.json", "a.js", "a.ts", "a.rs", "a.toml", "a.yaml", "a.cfg", "a.bat", "a.sh", "a.md", "Makefile"]) {
    assert.equal(spellKindFor(f, on, D), null, f);
  }
});

test("untitled follows its own switch; an edited list changes the result", () => {
  assert.equal(spellKindFor(null, on, D), "text");
  assert.equal(spellKindFor(null, { untitled: false }, D), null);
  assert.equal(spellKindFor("a.md", on, "txt md"), "markdown");
  assert.equal(spellKindFor("a.py", on, "txt py"), "text");
  assert.equal(spellKindFor("a.txt", on, ""), null);
  assert.equal(spellKindFor("a.txt", {}, D), "text");
});

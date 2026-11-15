import assert from "node:assert/strict";
import { test } from "node:test";
import { isLogFile, logAppendix } from "./logfile.ts";

test("only a first line of exactly .LOG counts", () => {
  assert.ok(isLogFile(".LOG"));
  assert.ok(isLogFile(".LOG\nnotes"));
  assert.ok(isLogFile(".LOG\r\nnotes"));
  for (const t of ["", ".log\n", ".LOG ", " .LOG", ".LOGS\n", "x\n.LOG\n", ".LOG2"]) assert.equal(isLogFile(t), false, t);
});

test("appends the stamp on its own line, with a line break first only when needed", () => {
  assert.equal(logAppendix(".LOG", "9:05 AM 1/2/2026"), "\n9:05 AM 1/2/2026\n");
  assert.equal(logAppendix(".LOG\nold\n", "S"), "S\n");
  assert.equal(logAppendix(".LOG\r\n", "S"), "S\n");
});

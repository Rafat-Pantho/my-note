import assert from "node:assert/strict";
import { test } from "node:test";
import { isPermissionError, saveAction } from "./readonly.ts";

test("Save on a read-only file offers Save as; Save as, untitled and writable files just write", () => {
  assert.equal(saveAction({ readOnly: true, path: "C:\\a.txt" }, false), "offer-save-as");
  assert.equal(saveAction({ readOnly: true, path: "C:\\a.txt" }, true), "write");
  assert.equal(saveAction({ readOnly: true, path: null }, false), "write");
  assert.equal(saveAction({ readOnly: false, path: "C:\\a.txt" }, false), "write");
  assert.equal(saveAction({ path: "C:\\a.txt" }, false), "write");
});

test("recognizes permission errors from Rust", () => {
  assert.ok(isPermissionError("Access is denied. (os error 5)"));
  assert.ok(isPermissionError("Permission denied (os error 13)"));
  assert.equal(isPermissionError("There is not enough space on the disk. (os error 112)"), false);
  assert.equal(isPermissionError("The system cannot find the path specified. (os error 3)"), false);
});

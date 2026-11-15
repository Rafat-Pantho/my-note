import assert from "node:assert/strict";
import test from "node:test";
import { saveAllOrder } from "./saveall.ts";

const t = (name: string, dirty: boolean, path?: string, kind?: string) => ({ name, dirty, path, kind });

test("files first in tab order, untitled tabs last", () => {
  const list = [t("u1", true), t("a", true, "/a"), t("b", false, "/b"), t("u2", true), t("c", true, "/c")];
  assert.deepEqual(saveAllOrder(list).map((x) => x.name), ["a", "c", "u1", "u2"]);
});

test("clean tabs and the Settings tab are skipped", () => {
  assert.deepEqual(saveAllOrder([t("s", true, undefined, "settings"), t("a", false, "/a")]), []);
});

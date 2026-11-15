import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, message, promptFor } from "./external.ts";

const s = (mtimeMs: number, size: number) => ({ mtimeMs, size });

test("same time and size is unchanged", () => {
  assert.equal(compare(s(100, 5), s(100, 5)), "unchanged");
});

test("a different time or size is a change", () => {
  assert.equal(compare(s(100, 5), s(200, 5)), "changed");
  assert.equal(compare(s(100, 5), s(100, 6)), "changed");
  assert.equal(compare(s(100, 5), s(50, 5)), "changed"); // an older file put back counts too
});

test("a missing file is deleted", () => {
  assert.equal(compare(s(100, 5), null), "deleted");
});

test("a tab that was never stat-ed is never reported", () => {
  assert.equal(compare(undefined, s(1, 1)), "unchanged");
  assert.equal(compare(undefined, null), "unchanged");
});

test("clean tab gets the bar, dirty tab gets the question", () => {
  assert.equal(promptFor("unchanged", true), "none");
  assert.equal(promptFor("unchanged", false), "none");
  assert.equal(promptFor("changed", false), "bar-reload");
  assert.equal(promptFor("changed", true), "ask");
});

test("a deleted file only ever gets the Dismiss bar, dirty or not", () => {
  assert.equal(promptFor("deleted", false), "bar-deleted");
  assert.equal(promptFor("deleted", true), "bar-deleted");
});

test("wording names the file and the unsaved edits", () => {
  assert.match(message("a.txt", "bar-reload"), /a\.txt changed on disk\./);
  assert.match(message("a.txt", "ask"), /unsaved changes/);
  assert.match(message("a.txt", "bar-deleted"), /deleted or moved/);
});

test("after Keep mine / Dismiss the new stamp is the baseline, so the same change is not asked again", () => {
  const known = s(100, 5);
  const now = s(300, 9);
  assert.equal(compare(known, now), "changed");
  assert.equal(compare(now, now), "unchanged");
});

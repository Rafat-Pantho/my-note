import assert from "node:assert/strict";
import { test } from "node:test";
import { type ClosedTab, ClosedTabs, MAX_CLOSED, MAX_CLOSED_TEXT, closedEntry } from "./closed.ts";

const file = (path: string): ClosedTab => ({ path, name: path.split("/").pop()!, encoding: "utf-8", lineEnding: "lf" });
const info = (over: object = {}) => ({ path: null, name: "Untitled", encoding: "utf-8", lineEnding: "crlf", ...over });

test("reopens the most recently closed tab first", () => {
  const s = new ClosedTabs();
  s.push(file("/a.txt"));
  s.push(file("/b.txt"));
  s.push(file("/c.txt"));
  assert.equal(s.pop()?.path, "/c.txt");
  assert.equal(s.pop()?.path, "/b.txt");
  assert.equal(s.pop()?.path, "/a.txt");
  assert.equal(s.pop(), undefined);
  assert.equal(s.size, 0);
});

test("keeps only the last 10", () => {
  const s = new ClosedTabs();
  for (let i = 0; i < 15; i++) s.push(file(`/f${i}.txt`));
  assert.equal(s.size, MAX_CLOSED);
  const order: string[] = [];
  for (let e = s.pop(); e; e = s.pop()) order.push(e.path!);
  assert.deepEqual(order, ["/f14.txt", "/f13.txt", "/f12.txt", "/f11.txt", "/f10.txt", "/f9.txt", "/f8.txt", "/f7.txt", "/f6.txt", "/f5.txt"]);
});

test("the same file closed twice is one entry, at the newer position", () => {
  const s = new ClosedTabs();
  s.push(file("/a.txt"));
  s.push(file("/b.txt"));
  s.push(file("/A.TXT")); // same file on Windows
  assert.equal(s.size, 2);
  assert.equal(s.pop()?.path, "/A.TXT");
  assert.equal(s.pop()?.path, "/b.txt");
});

test("a file that is already open again is skipped", () => {
  const s = new ClosedTabs();
  s.push(file("/a.txt"));
  s.push(file("/b.txt"));
  s.push({ path: null, name: "Untitled", encoding: "utf-8", lineEnding: "lf", text: "hi" });
  assert.equal(s.pop((p) => p === "/b.txt")?.text, "hi"); // untitled has no path to be open
  assert.equal(s.pop((p) => p === "/b.txt")?.path, "/a.txt"); // /b.txt dropped, /a.txt returned
  assert.equal(s.size, 0);
});

test("untitled tabs keep their text, empty or huge ones are not recorded, Settings never is", () => {
  assert.deepEqual(closedEntry(info(), "draft"), { path: null, name: "Untitled", encoding: "utf-8", lineEnding: "crlf", text: "draft" });
  assert.equal(closedEntry(info(), ""), null);
  assert.equal(closedEntry(info(), undefined), null);
  assert.equal(closedEntry(info(), "x".repeat(MAX_CLOSED_TEXT + 1)), null);
  assert.notEqual(closedEntry(info(), "x".repeat(MAX_CLOSED_TEXT)), null);
  assert.equal(closedEntry(info({ kind: "settings", name: "Settings" }), "x"), null);
});

test("a file tab stores no text: it is read from disk again", () => {
  const e = closedEntry(info({ path: "/a.txt", name: "a.txt" }), "unsaved edits");
  assert.equal(e?.path, "/a.txt");
  assert.equal(e?.text, undefined);
});

test("clear empties the stack", () => {
  const s = new ClosedTabs();
  s.push(file("/a.txt"));
  s.clear();
  assert.equal(s.pop(), undefined);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { history, undo } from "@codemirror/commands";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { changeSpec, planChange, type Placement } from "./apply.ts";
import { RollbackHistory } from "./history.ts";
import { resolveScope } from "./scope.ts";

/** A tiny editor: real CodeMirror state + undo history, plus our rollback history, wired like the app. */
class Ed {
  state: EditorState;
  hist = new RollbackHistory();
  constructor(doc: string) {
    this.state = EditorState.create({ doc, extensions: [history()] });
  }
  get text() {
    return this.state.doc.toString();
  }
  dispatch(spec: TransactionSpec) {
    const tr = this.state.update(spec);
    this.state = tr.state;
    if (tr.docChanged) this.hist.map(tr.changes);
  }
  /** User typing: a plain user edit. */
  type(from: number, to: number, insert: string) {
    this.dispatch({ changes: { from, to, insert }, userEvent: "input.type" });
  }
  select(from: number, to: number) {
    this.dispatch({ selection: { anchor: from, head: to } });
  }
  /** Accept an AI result the way the app does. Returns the entry id. */
  accept(placement: Placement, result: string, action = "Test") {
    const sel = this.state.selection.main;
    const scope = resolveScope(this.state.doc, sel);
    const plan = planChange(this.state.doc, scope, placement, result);
    const before = this.state.doc.sliceString(plan.from, plan.to);
    this.dispatch(changeSpec(plan, "input.ai"));
    this.hist.add({
      action,
      time: 0,
      scope: scope.kind,
      scopeLabel: scope.label,
      from: plan.from,
      to: plan.from + plan.insert.length,
      before,
      after: plan.insert,
    });
    return this.hist.entries[this.hist.entries.length - 1].id;
  }
  /** Roll back like the app does; returns the plan so tests can check `lostEdits`. */
  restore(id: number) {
    const plan = this.hist.planRestore(id, this.state.doc)!;
    const e = this.hist.get(id)!;
    this.dispatch(changeSpec(plan, "input.ai"));
    this.hist.markRestored(id);
    this.hist.add({
      action: `Restore: ${e.action}`,
      time: 0,
      scope: e.scope,
      scopeLabel: e.scopeLabel,
      from: plan.from,
      to: plan.from + plan.insert.length,
      before: plan.current,
      after: plan.insert,
    });
    return plan;
  }
  /** Ctrl+Z, wired like the app: undo/redo changes detach the entries they touch before ranges are mapped. */
  undo() {
    undo({
      state: this.state,
      dispatch: (tr) => {
        this.state = tr.state;
        if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) this.hist.detachTouching(tr.changes);
        this.hist.map(tr.changes);
      },
    });
  }
}

test("accepting is one transaction: a single undo reverts it, typing before it survives", () => {
  const ed = new Ed("hello world");
  ed.type(11, 11, "!");
  assert.equal(ed.text, "hello world!");
  ed.select(0, 5);
  ed.accept("replace", "Hi", "Shorten");
  assert.equal(ed.text, "Hi world!");
  ed.undo();
  assert.equal(ed.text, "hello world!", "one Ctrl+Z reverts the whole AI change, not the typing before it");
});

test("each accept is its own undo step", () => {
  const ed = new Ed("aaa bbb");
  ed.select(0, 3);
  ed.accept("replace", "AAA");
  ed.select(4, 7);
  ed.accept("replace", "BBB");
  assert.equal(ed.text, "AAA BBB");
  ed.undo();
  assert.equal(ed.text, "AAA bbb");
  ed.undo();
  assert.equal(ed.text, "aaa bbb");
});

test("the entry stores action, scope, before and after text", () => {
  const ed = new Ed("one two three");
  ed.select(4, 7);
  ed.accept("replace", "2", "Rewrite");
  const [e] = ed.hist.entries;
  assert.deepEqual(
    [e.action, e.scope, e.scopeLabel, e.before, e.after, e.from, e.to],
    ["Rewrite", "selection", "Selection, 1 word", "two", "2", 4, 5],
  );
});

test("restore puts the old text back and keeps edits elsewhere", () => {
  const ed = new Ed("Intro.\nthe quick brown fox\nOutro.");
  ed.select(7, 26);
  const id = ed.accept("replace", "a fast fox");
  ed.type(0, 0, ">> "); // typed before it: the entry's range moves
  ed.type(ed.text.length, ed.text.length, " End"); // and after it
  const plan = ed.restore(id);
  assert.equal(plan.lostEdits, false, "nothing inside the AI text changed, so no confirmation is needed");
  assert.equal(ed.text, ">> Intro.\nthe quick brown fox\nOutro. End");
});

test("restore after edits INSIDE the AI text asks first, and rolling back loses them", () => {
  const ed = new Ed("the quick brown fox");
  ed.select(0, 19);
  const id = ed.accept("replace", "a fast fox");
  ed.type(2, 6, "SLOW"); // user polishes the AI text: "a SLOW fox"
  const e = ed.hist.get(id)!;
  assert.equal(ed.text.slice(e.from, e.to), "a SLOW fox", "the range followed the edit");
  const plan = ed.hist.planRestore(id, ed.state.doc)!;
  assert.equal(plan.lostEdits, true);
  assert.equal(plan.current, "a SLOW fox");
  ed.restore(id);
  assert.equal(ed.text, "the quick brown fox");
});

test("restore after a later AI change over the same text asks first", () => {
  const ed = new Ed("alpha beta");
  ed.select(0, 10);
  const first = ed.accept("replace", "one two");
  ed.select(0, 7);
  ed.accept("replace", "ONE TWO", "Second");
  const plan = ed.hist.planRestore(first, ed.state.doc)!;
  assert.equal(plan.lostEdits, true, "the first result is no longer what is in the document");
});

test("the rollback itself is a single undo step", () => {
  const ed = new Ed("the quick brown fox");
  ed.select(0, 19);
  const id = ed.accept("replace", "a fast fox");
  ed.restore(id);
  assert.equal(ed.text, "the quick brown fox");
  ed.undo(); // undoes the rollback only
  assert.equal(ed.text, "a fast fox");
  ed.undo(); // then the AI change
  assert.equal(ed.text, "the quick brown fox");
});

test("a rollback is recorded too, so it can be rolled forward again", () => {
  const ed = new Ed("abc def");
  ed.select(0, 3);
  const id = ed.accept("replace", "XYZ");
  ed.restore(id);
  assert.equal(ed.text, "abc def");
  assert.equal(ed.hist.get(id)!.restored, true);
  const last = ed.hist.entries[ed.hist.entries.length - 1];
  assert.equal(last.action, "Restore: Test");
  ed.restore(last.id);
  assert.equal(ed.text, "XYZ def");
});

test("an inserted result is rolled back by removing exactly what was added", () => {
  const ed = new Ed("Para one.\nPara two.\n");
  ed.select(0, 9);
  const id = ed.accept("below", "Summary.", "Summarize");
  assert.equal(ed.text, "Para one.\n\nSummary.\n\nPara two.\n");
  ed.restore(id);
  assert.equal(ed.text, "Para one.\nPara two.\n");
});

test("a restore whose text was deleted entirely asks first and re-inserts the old text", () => {
  const ed = new Ed("keep THIS keep");
  ed.select(5, 9);
  const id = ed.accept("replace", "that");
  ed.type(0, ed.text.length, "unrelated");
  const plan = ed.hist.planRestore(id, ed.state.doc)!;
  assert.equal(plan.lostEdits, true);
  assert.equal(plan.current, "");
});

test("count cap drops the oldest entries first", () => {
  const h = new RollbackHistory({ maxEntries: 3, maxChars: 1_000_000 });
  const add = (n: number) => h.add({ action: `a${n}`, time: 0, scope: "file", scopeLabel: "", from: 0, to: 1, before: "x", after: "y" });
  for (let i = 1; i <= 3; i++) assert.deepEqual(add(i), { skipped: false, dropped: 0 });
  assert.deepEqual(add(4), { skipped: false, dropped: 1 });
  assert.deepEqual(h.entries.map((e) => e.action), ["a2", "a3", "a4"]);
  assert.equal(h.totalChars, 6);
});

test("memory cap drops the oldest until the total fits", () => {
  const h = new RollbackHistory({ maxEntries: 100, maxChars: 100 });
  const add = (n: number, size: number) =>
    h.add({ action: `a${n}`, time: 0, scope: "file", scopeLabel: "", from: 0, to: 0, before: "b".repeat(size), after: "a".repeat(size) });
  add(1, 20); // 40
  add(2, 20); // 80
  const r = add(3, 20); // 120 > 100: drop a1
  assert.equal(r.dropped, 1);
  assert.deepEqual(h.entries.map((e) => e.action), ["a2", "a3"]);
  assert.equal(h.totalChars, 80);
  const big = add(4, 45); // 90 alone, 170 total: drop a2 and a3
  assert.equal(big.dropped, 2);
  assert.deepEqual(h.entries.map((e) => e.action), ["a4"]);
});

test("an entry bigger than the whole cap is not stored and does not evict anything", () => {
  const h = new RollbackHistory({ maxEntries: 10, maxChars: 100 });
  h.add({ action: "keep", time: 0, scope: "file", scopeLabel: "", from: 0, to: 0, before: "x", after: "y" });
  const r = h.add({ action: "huge", time: 0, scope: "file", scopeLabel: "", from: 0, to: 0, before: "x".repeat(101), after: "" });
  assert.deepEqual(r, { skipped: true, dropped: 0 });
  assert.deepEqual(h.entries.map((e) => e.action), ["keep"]);
});

test("planRestore of an unknown id", () => {
  assert.equal(new RollbackHistory().planRestore(99, EditorState.create({ doc: "x" }).doc), undefined);
});

test("undoing an AI change detaches its entry, so a later restore cannot duplicate the old text", () => {
  const ed = new Ed("the quick brown fox");
  ed.select(0, 19);
  const id = ed.accept("replace", "a fast fox");
  ed.undo();
  assert.equal(ed.text, "the quick brown fox");
  assert.equal(ed.hist.get(id)!.detached, true);
  assert.equal(ed.hist.planRestore(id, ed.state.doc), undefined, "nothing to restore: the undo already did it");
});

test("undoing something else leaves the entry restorable", () => {
  const ed = new Ed("Intro.\nthe quick brown fox");
  ed.select(7, 26);
  const id = ed.accept("replace", "a fast fox");
  ed.type(0, 0, ">> "); // typed elsewhere, then undone
  ed.undo();
  assert.equal(ed.text, "Intro.\na fast fox");
  assert.equal(ed.hist.get(id)!.detached, undefined);
  const plan = ed.restore(id);
  assert.equal(plan.lostEdits, false);
  assert.equal(ed.text, "Intro.\nthe quick brown fox");
});

test("undoing the rollback detaches the rollback's own entry too", () => {
  const ed = new Ed("abc def");
  ed.select(0, 3);
  const id = ed.accept("replace", "XYZ");
  ed.restore(id);
  ed.undo(); // undoes the rollback
  const last = ed.hist.entries[ed.hist.entries.length - 1];
  assert.equal(last.action, "Restore: Test");
  assert.equal(last.detached, true);
  assert.equal(ed.text, "XYZ def");
});

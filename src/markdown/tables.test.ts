import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeView, show } from "./fakeview.ts";
import {
  alignTable, cellAt, cellSpans, deleteColumn, deleteRow, displayWidth, findTable, formatTable, insertColumn,
  insertRow, insertTable, isDelimiterRow, needsAlign, newTable, parseSize, parseTable, setAlign, splitRow,
  tableEdit, tableEnter, tableAtLine, tableTab,
} from "./tables.ts";

test("rows split on unescaped pipes; edge pipes are optional", () => {
  assert.deepEqual(splitRow("| a | b |"), ["a", "b"]);
  assert.deepEqual(splitRow("a | b"), ["a", "b"]);
  assert.deepEqual(splitRow("|a|b|"), ["a", "b"]);
  assert.deepEqual(splitRow("| a | |"), ["a", ""]);
  assert.deepEqual(splitRow("| a \\| b | c |"), ["a \\| b", "c"]);
  assert.deepEqual(splitRow("|"), []);
});

test("delimiter rows", () => {
  assert.equal(isDelimiterRow("| --- | :-: |"), true);
  assert.equal(isDelimiterRow("|:--|--:|"), true);
  assert.equal(isDelimiterRow("--- | ---"), true);
  assert.equal(isDelimiterRow("| a | b |"), false);
  assert.equal(isDelimiterRow("---"), false, "a lone rule is not a table row");
  assert.equal(isDelimiterRow("| - | -- |"), true);
});

test("finding a table: header + delimiter with the same cell count, then pipe rows", () => {
  const lines = ["text", "", "| a | b |", "| - | - |", "| 1 | 2 |", "| 3 | 4 |", "", "after | pipe"];
  assert.deepEqual(findTable(lines, 2), { start: 2, end: 5 });
  assert.deepEqual(findTable(lines, 5), { start: 2, end: 5 });
  assert.equal(findTable(lines, 0), null);
  assert.equal(findTable(lines, 6), null);
  assert.equal(findTable(lines, 7), null, "a pipe in a paragraph is not a table");
  assert.equal(findTable(["| a | b |", "| - |"], 0), null, "cell counts differ");
  assert.equal(findTable(["x | y", "para", "| - | - |"], 0), null);
});

test("alignment pads every column to its widest cell and lines the pipes up", () => {
  const t = parseTable(["|a|bbb|", "|-|-|", "|longer|x|"], { start: 0, end: 2 });
  assert.deepEqual(formatTable(t), [
    "| a      | bbb |",
    "| ------ | --- |",
    "| longer | x   |",
  ]);
});

test("column alignment markers are kept and applied", () => {
  const t = parseTable(["| left | mid | right | none |", "| :--- | :-: | ---: | --- |", "| a | b | c | d |"], { start: 0, end: 2 });
  assert.deepEqual(t.aligns, ["left", "center", "right", "none"]);
  assert.deepEqual(formatTable(t), [
    "| left | mid | right | none |",
    "| :--- | :-: | ----: | ---- |",
    "| a    |  b  |     c | d    |",
  ]);
});

test("formatting is idempotent and every row has the same width", () => {
  const raw = ["| Name | Qty |", "|--|--:|", "| apple | 3 |", "| fig | 12 |", "| x |"];
  const once = formatTable(parseTable(raw, { start: 0, end: 4 }));
  const twice = formatTable(parseTable(once, { start: 0, end: 4 }));
  assert.deepEqual(twice, once);
  assert.equal(new Set(once.map((l) => displayWidth(l))).size, 1);
  assert.ok(once[4].includes("|     |") || once[4].endsWith("|     |"), once[4]); // the short row got an empty cell
});

test("wide characters count as two columns, combining marks as none", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("漢字"), 4);
  assert.equal(displayWidth("é"), 1);
  const t = parseTable(["| 漢字 | a |", "| - | - |", "| xx | b |"], { start: 0, end: 2 });
  const f = formatTable(t);
  assert.equal(new Set(f.map(displayWidth)).size, 1, f.join("\n"));
});

test("escaped pipes stay escaped", () => {
  const f = formatTable(parseTable(["| a \\| b | c |", "| - | - |"], { start: 0, end: 1 }));
  assert.ok(f[0].startsWith("| a \\| b |"), f[0]);
});

test("rows and columns can be added and removed", () => {
  const t = parseTable(["| a | b |", "| - | - |", "| 1 | 2 |"], { start: 0, end: 2 });
  assert.deepEqual(insertRow(t, 0).rows, [["", ""], ["1", "2"]]);
  assert.deepEqual(insertRow(t, 1).rows, [["1", "2"], ["", ""]]);
  assert.deepEqual(deleteRow(t, 0).rows, []);
  assert.deepEqual(insertColumn(t, 1).header, ["a", "", "b"]);
  assert.deepEqual(insertColumn(t, 2).rows, [["1", "2", ""]]);
  assert.deepEqual(deleteColumn(t, 0).header, ["b"]);
  assert.equal(deleteColumn(deleteColumn(t, 0), 0).header.length, 1, "the last column stays");
  assert.deepEqual(setAlign(t, 1, "right").aligns, ["none", "right"]);
});

test("a new table is a header plus empty rows, as plain pipe Markdown", () => {
  const f = formatTable(newTable(3, 2));
  assert.deepEqual(f, [
    "| Header 1 | Header 2 |",
    "| -------- | -------- |",
    "|          |          |",
    "|          |          |",
  ]);
  assert.deepEqual(parseSize("3x4"), [3, 4]);
  assert.deepEqual(parseSize(" 2 × 5 "), [2, 5]);
  assert.deepEqual(parseSize("4,2"), [4, 2]);
  assert.equal(parseSize("x"), null);
  assert.equal(parseSize("0x3"), null);
  assert.equal(newTable(1, 99).rows.length, 1, "at least a header and one row");
  assert.equal(newTable(1, 99).header.length, 30);
});

test("caret mapping inside a row", () => {
  const line = "| abc | de |";
  assert.deepEqual(cellAt(line, 3), { cell: 0, offset: 1 });
  assert.deepEqual(cellAt(line, 5), { cell: 0, offset: 3 }); // at the end of "abc"
  assert.deepEqual(cellAt(line, 7), { cell: 1, offset: 0 });
  assert.deepEqual(cellAt(line, 9), { cell: 1, offset: 1 });
  assert.deepEqual(cellAt(line, 20), { cell: 1, offset: 2 });
  const spans = cellSpans(line);
  assert.equal(line.slice(spans[1].start, spans[1].end), "de");
});

const doc = ["intro", "", "|a|b|", "|-|-|", "|1|2|", "", "tail"].join("\n");

test("Tab moves to the next cell, wraps to the next row, and adds a row at the end", () => {
  const v = fakeView(doc, { anchor: doc.indexOf("|a") + 2 });
  assert.equal(tableTab(v, 1), true);
  assert.equal(v.state.doc.toString().includes("| a   | b   |"), true, show(v));
  assert.ok(show(v).includes("[b]"), show(v));
  tableTab(v, 1); // to the first body cell
  assert.ok(show(v).includes("[1]"), show(v));
  tableTab(v, 1);
  assert.ok(show(v).includes("[2]"), show(v));
  tableTab(v, 1); // last cell: a new row
  const text = v.state.doc.toString();
  assert.equal(text.split("\n").filter((l) => l.startsWith("|")).length, 4, text);
  assert.ok(/\n\| {3} \| {3} \|\n/.test(text) || text.includes("|     |     |"), text);
  assert.equal(v.state.selection.main.head > text.indexOf("| 1 "), true);
  // Shift+Tab goes back
  tableTab(v, -1);
  assert.ok(show(v).includes("[2]"), show(v));
});

test("Shift+Tab from the first cell stays put; Tab outside a table is not handled", () => {
  const v = fakeView(doc, { anchor: doc.indexOf("|a") + 1 });
  assert.equal(tableTab(v, -1), true);
  assert.ok(show(v).includes("[a]"), show(v));
  assert.equal(tableTab(fakeView("plain|"), 1), false);
});

test("typing in a table leaves it out of line; aligning fixes it and keeps the caret in the same cell", () => {
  const v = fakeView("| a | b |\n| - | - |\n| longword| x|", { anchor: "| a | b |\n| - | - |\n| longword".length });
  assert.equal(needsAlign(v), true);
  assert.equal(alignTable(v), true);
  assert.equal(v.state.doc.toString(), "| a        | b   |\n| -------- | --- |\n| longword | x   |");
  assert.equal(needsAlign(v), false);
  assert.equal(alignTable(v), false, "already aligned: no change");
  const head = v.state.selection.main.head;
  assert.equal(v.state.doc.sliceString(head - 8, head), "longword");
});

test("Enter in a table adds a row below; Enter in an empty last row leaves the table", () => {
  const v = fakeView("| a | b |\n| - | - |\n| 1 | 2 |", { anchor: "| a | b |\n| - | - |\n| 1".length });
  assert.equal(tableEnter(v), true);
  assert.equal(v.state.doc.toString().split("\n").length, 4);
  assert.equal(tableEnter(v), true, "the new last row is empty: the table ends");
  const t = v.state.doc.toString();
  assert.equal(t.split("\n").filter((l) => l.startsWith("|")).length, 3, t);
  assert.ok(t.endsWith("\n"), JSON.stringify(t));
  assert.equal(v.state.selection.main.head, t.length);
  assert.equal(tableEnter(fakeView("plain|")), false);
});

test("context-menu edits keep a valid pipe table", () => {
  const src = "| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |";
  const at = (v: ReturnType<typeof fakeView>, line: number) => tableAtLine(v.state.doc, line)!;
  let v = fakeView(src, { anchor: 0 });
  tableEdit(v, at(v, 3), 1, "rowBelow");
  assert.equal(v.state.doc.toString().split("\n").length, 5);
  v = fakeView(src, { anchor: 0 });
  tableEdit(v, at(v, 3), 0, "deleteRow");
  assert.equal(v.state.doc.toString(), "| a   | b   |\n| --- | --- |\n| 3   | 4   |");
  v = fakeView(src, { anchor: 0 });
  tableEdit(v, at(v, 1), 0, "deleteRow"); // the header cannot be deleted
  assert.equal(v.state.doc.toString(), src);
  v = fakeView(src, { anchor: 0 });
  tableEdit(v, at(v, 3), 1, "colRight");
  assert.equal(v.state.doc.toString().split("\n")[0], "| a   | b   |     |");
  v = fakeView(src, { anchor: 0 });
  tableEdit(v, at(v, 3), 0, "deleteCol");
  assert.equal(v.state.doc.toString().split("\n")[0], "| b   |");
  v = fakeView(src, { anchor: 0 });
  tableEdit(v, at(v, 3), 1, "right");
  assert.equal(v.state.doc.toString().split("\n")[1], "| --- | --: |");
  v = fakeView(src, { anchor: 0 });
  tableEdit(v, at(v, 3), 0, "center");
  assert.equal(v.state.doc.toString().split("\n")[1], "| :-: | --- |");
  assert.ok(!/<|style|data-/i.test(v.state.doc.toString()), "plain Markdown only");
});

test("a table inside a code fence is left alone", () => {
  const v = fakeView("```\n|a|b|\n|-|-|\n```", { anchor: 6 });
  assert.equal(tableTab(v, 1), false);
  assert.equal(alignTable(v), false);
});

test("Insert table puts an aligned table on its own paragraph and selects the first header", () => {
  let v = fakeView("hello|");
  insertTable(v, 3, 2);
  assert.equal(
    v.state.doc.toString(),
    "hello\n\n| Header 1 | Header 2 |\n| -------- | -------- |\n|          |          |\n|          |          |\n",
  );
  assert.ok(show(v).includes("[Header 1]"), show(v));
  v = fakeView("|");
  insertTable(v, 2, 1);
  assert.equal(v.state.doc.toString(), "| Header 1 |\n| -------- |\n|          |\n");
  v = fakeView("a\n|\nnext line");
  insertTable(v, 2, 1);
  assert.ok(v.state.doc.toString().includes("|          |\n\nnext line") || v.state.doc.toString().includes("|          |\nnext line") === false);
  const parsed = tableAtLine(v.state.doc, 2);
  assert.ok(parsed && parsed.table.header.length === 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCodes, printCss } from "./printcss.ts";

const ctx = { name: "notes.txt", date: "11/15/2026" };
const setup = (over = {}) => ({ marginMm: 20, landscape: false, header: "", footer: "", ...over });

test("margin and orientation", () => {
  assert.match(printCss(setup(), ctx), /size: A4 portrait;\s+margin: 20mm;/);
  assert.match(printCss(setup({ landscape: true, marginMm: 12 }), ctx), /size: A4 landscape;\s+margin: 12mm;/);
});

test("paper size: A4, Letter, Legal; an unknown value falls back to A4", () => {
  assert.match(printCss(setup({ paper: "letter" }), ctx), /size: letter portrait;/);
  assert.match(printCss(setup({ paper: "legal", landscape: true }), ctx), /size: legal landscape;/);
  assert.match(printCss(setup({ paper: "tabloid" }), ctx), /size: A4 portrait;/);
});

test("&t is the time, and is empty when no time is given", () => {
  assert.deepEqual(parseCodes("&t", { ...ctx, time: "9:05 AM" }).center, [{ text: "9:05 AM" }]);
  assert.deepEqual(parseCodes("a&tb", ctx).center, [{ text: "ab" }]);
});

test("margins are clamped to 0-50 mm and bad numbers fall back", () => {
  assert.match(printCss(setup({ marginMm: 500 }), ctx), /margin: 50mm/);
  assert.match(printCss(setup({ marginMm: -3 }), ctx), /margin: 0mm/);
  assert.match(printCss(setup({ marginMm: NaN }), ctx), /margin: 20mm/);
});

test("empty header and footer emit no margin boxes", () => {
  assert.doesNotMatch(printCss(setup(), ctx), /@top|@bottom/);
});

test("file name, date and page number codes", () => {
  const c = printCss(setup({ header: "&f", footer: "Page &p of &P &d" }), ctx);
  assert.match(c, /@top-center \{ content: "notes\.txt";/);
  assert.match(c, /@bottom-center \{ content: "Page " counter\(page\) " of " counter\(pages\) " " "11\/15\/2026"|@bottom-center \{ content: "Page " counter\(page\) " of " counter\(pages\) " 11\/15\/2026"/);
});

test("&l &c &r pick the box", () => {
  const p = parseCodes("&lleft&cmid&rright", ctx);
  assert.deepEqual(p.left, [{ text: "left" }]);
  assert.deepEqual(p.center, [{ text: "mid" }]);
  assert.deepEqual(p.right, [{ text: "right" }]);
  const c = printCss(setup({ footer: "&l&f&r&p" }), ctx);
  assert.match(c, /@bottom-left \{ content: "notes\.txt"/);
  assert.match(c, /@bottom-right \{ content: counter\(page\)/);
  assert.doesNotMatch(c, /@bottom-center/);
});

test("&& is an ampersand, unknown codes and a trailing & are kept as typed", () => {
  assert.deepEqual(parseCodes("a&&b", ctx).center, [{ text: "a&b" }]);
  assert.deepEqual(parseCodes("&z", ctx).center, [{ text: "&z" }]);
  assert.deepEqual(parseCodes("end&", ctx).center, [{ text: "end&" }]);
});

test("quotes, backslashes and newlines in text or the file name cannot escape the CSS string", () => {
  const evil = { name: 'a"; } body { display:none } /*', date: "d" };
  const c = printCss(setup({ header: 'x\\"y&f' }), evil);
  assert.ok(c.includes('\\"; } body'), c); // the quote is escaped, still inside the string
  assert.ok(!/[^\\]"; \} body/.test(c));
  assert.ok(c.includes('x\\\\\\"y'));
});

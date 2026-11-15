import assert from "node:assert/strict";
import { test } from "node:test";
import { imageSource, safeLink } from "./links.ts";

test("http, https and mailto links are allowed", () => {
  assert.equal(safeLink("https://example.com/a?b=c#d"), "https://example.com/a?b=c#d");
  assert.equal(safeLink("http://example.com"), "http://example.com/");
  assert.equal(safeLink("HTTPS://EXAMPLE.COM/x"), "https://example.com/x");
  assert.equal(safeLink("mailto:me@example.com"), "mailto:me@example.com");
  assert.equal(safeLink("mailto:me@example.com?subject=Hi%20there"), "mailto:me@example.com?subject=Hi%20there");
});

test("every other scheme is refused, however it is dressed up", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\u0000script:alert(1)",
    "&#106;avascript:alert(1)",
    "\u00a0javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///C:/Windows/System32/calc.exe",
    "file://server/share/x",
    "ftp://example.com/x",
    "ssh://host",
    "tel:+123",
    "sms:123",
    "ms-msdt:/id",
    "steam://run/1",
    "about:blank",
    "blob:https://example.com/uuid",
    "//example.com/x",
    "/relative/path",
    "relative.html",
    "#anchor",
    "?q=1",
    "",
    "https://",
    "http://exa mple.com",
    "mailto:",
  ]) {
    assert.equal(safeLink(bad), null, JSON.stringify(bad));
  }
  assert.equal(safeLink("https://example.com/" + "a".repeat(3000)), null);
});

test("images: http(s) addresses and inline raster data URIs only", () => {
  assert.deepEqual(imageSource("https://example.com/a.png"), { kind: "remote", url: "https://example.com/a.png" });
  assert.deepEqual(imageSource("data:image/png;base64,iVBORw0KGgo="), { kind: "data", url: "data:image/png;base64,iVBORw0KGgo=" });
  assert.equal(imageSource("data:image/jpeg;base64,/9j/4AAQ")?.kind, "data");
  assert.equal(imageSource("data:image/gif;base64,R0lGODlh")?.kind, "data");
  assert.equal(imageSource("data:image/webp;base64,UklGRg==")?.kind, "data");
  for (const bad of [
    "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "data:image/png,not-base64",
    "data:image/png;base64,AAA\"onerror=\"alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "javascript:alert(1)",
    "file:///C:/pic.png",
    "mailto:a@b.c",
    "pic.png",
    "./pic.png",
    "//example.com/a.png",
    "",
  ]) {
    assert.equal(imageSource(bad), null, bad);
  }
});

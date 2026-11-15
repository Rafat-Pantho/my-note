import assert from "node:assert/strict";
import { test } from "node:test";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { createRenderer } from "./render.ts";

const window = new JSDOM("<!doctype html><html><body></body></html>").window;
const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);
const { toHtml } = createRenderer(purify as never);

/** Parses the result again and reports anything that could run code or load something. */
function dangers(html: string): string[] {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const out: string[] = [];
  for (const el of doc.body.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "iframe", "object", "embed", "svg", "math", "form", "link", "meta", "base", "video", "audio", "source", "template", "noscript"].includes(tag)) out.push(`tag <${tag}>`);
    for (const a of el.attributes) {
      if (/^on/i.test(a.name)) out.push(`handler ${a.name}`);
      if (a.name === "style" || a.name === "srcset" || a.name === "formaction" || a.name === "xlink:href") out.push(`attr ${a.name}`);
      if (["href", "src"].includes(a.name) && !/^(?:https?:|mailto:|data:image\/(?:png|jpe?g|gif|webp);base64,)/i.test(a.value)) out.push(`url ${a.name}=${a.value}`);
    }
  }
  return out;
}

test("ordinary Markdown renders to the expected elements", () => {
  const html = toHtml("# Title\n\nSome **bold**, *italic*, ~~gone~~ and `code`.\n\n- a\n- b\n\n1. one\n2. two\n\n> quote\n\n[link](https://example.com)\n\n```\ncode block\n```\n");
  for (const part of ["<h1>Title</h1>", "<strong>bold</strong>", "<em>italic</em>", "<del>gone</del>", "<code>code</code>", "<ul>", "<ol>", "<blockquote>", '<a href="https://example.com/">link</a>', "<pre><code>code block"]) {
    assert.ok(html.includes(part) || html.includes(part.replace("https://example.com/", "https://example.com")), `${part}\n${html}`);
  }
});

test("tables render with alignment", () => {
  const html = toHtml("| a | b |\n| :-- | --: |\n| 1 | 2 |\n");
  assert.ok(html.includes("<table>") && html.includes("<th") && html.includes("<td"), html);
  assert.ok(/align="left"/.test(html) && /align="right"/.test(html), html);
  assert.deepEqual(dangers(html), []);
});

test("task lists keep disabled checkboxes and nothing else from <input>", () => {
  const html = toHtml("- [x] done\n- [ ] todo\n");
  assert.equal((html.match(/<input/g) ?? []).length, 2, html);
  assert.ok(/disabled/.test(html));
  assert.deepEqual(dangers(html), []);
});

const FIXTURES: Record<string, string> = {
  "script tag": "<script>alert(1)</script>",
  "script in a paragraph": "hello <script>alert(document.cookie)</script> world",
  "script with attributes": '<script src="https://evil.example/x.js"></script>',
  "uppercase and broken script": "<ScRiPt >alert(1)</ScRiPt\n>",
  "javascript link": "[click](javascript:alert(1))",
  "javascript link, mixed case and entities": "[click](JaVaScRiPt:alert(1)) [x](&#106;avascript:alert(1)) [y](java&#9;script:alert(1))",
  "javascript autolink": "<javascript:alert(1)>",
  "data link": "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "vbscript and file links": "[a](vbscript:x) [b](file:///C:/Windows/System32/calc.exe)",
  "reference-style javascript link": "[x][1]\n\n[1]: javascript:alert(1)",
  "img onerror": '<img src=x onerror="alert(1)">',
  "img onerror in markdown": '![x" onerror="alert(1)](https://example.com/a.png)',
  "event handler on a link": '<a href="https://example.com" onclick="alert(1)">x</a>',
  "onmouseover on a div": '<div onmouseover="alert(1)">hover</div>',
  "svg onload": "<svg onload=alert(1)></svg>",
  "svg with script": '<svg><script>alert(1)</script></svg>',
  "svg in a data image": "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
  "svg data image, not base64": "![x](data:image/svg+xml,<svg onload=alert(1)>)",
  "svg use / foreignObject": '<svg><use href="data:image/svg+xml;base64,AAAA#x"/><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>',
  "math / mXSS": "<math><mtext><table><mglyph><style><!--</style><img title=\"--&gt;&lt;img src=1 onerror=alert(1)&gt;\">",
  "iframe": '<iframe src="https://evil.example"></iframe>',
  "iframe srcdoc": '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  "object and embed": '<object data="x.swf"></object><embed src="x.swf">',
  "style tag": "<style>body{background:url(https://evil.example/x)}</style>",
  "style attribute": '<p style="background:url(https://evil.example/x)">x</p>',
  "link tag": '<link rel="stylesheet" href="https://evil.example/x.css">',
  "meta refresh": '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  "base tag": '<base href="https://evil.example/">',
  "form": '<form action="https://evil.example"><input name=x><button>go</button></form>',
  "input that is not a checkbox": '<input type="text" value="x" autofocus onfocus="alert(1)">',
  "video / audio": '<video src=x onerror=alert(1)></video><audio src=x onerror=alert(1)></audio>',
  "details ontoggle": "<details open ontoggle=alert(1)>",
  "body onload": "<body onload=alert(1)>",
  "unclosed tag tricks": "<img src=\"x\" onerror=alert(1) //",
  "html comment": "<!-- --><script>alert(1)</script>",
  "nested markdown in html": "<div><p>**bold**</p><script>alert(1)</script></div>",
  "srcset": '<img srcset="https://evil.example/a.png 1x" src="https://example.com/ok.png">',
  "data attribute": '<p data-x="1" data-onload="alert(1)">x</p>',
  "unicode escapes in a link": "[x](\\u006aavascript:alert(1))",
  "protocol-relative image": "![x](//evil.example/a.png)",
  "code containing a script stays text": "`<script>alert(1)</script>`",
};

for (const [name, src] of Object.entries(FIXTURES)) {
  test(`XSS fixture: ${name}`, () => {
    const html = toHtml(src);
    assert.deepEqual(dangers(html), [], `${html}`);
  });
}

test("raw HTML is shown as text, not rendered", () => {
  const html = toHtml("<b>not bold</b> and <span class=x>text</span>");
  assert.ok(html.includes("&lt;b&gt;not bold&lt;/b&gt;"), html);
  assert.ok(!/<b>/.test(html), html);
  const block = toHtml("<div>\nhello\n</div>");
  assert.ok(block.includes("&lt;div&gt;"), block);
  assert.ok(!/<div/.test(block), block);
});

test("code spans and fences keep markup as text", () => {
  const html = toHtml("`<script>alert(1)</script>`\n\n```html\n<img src=x onerror=alert(1)>\n```\n");
  assert.ok(html.includes("&lt;script&gt;"), html);
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), html);
  assert.deepEqual(dangers(html), []);
});

test("allowed links and images survive; unsafe ones lose their address", () => {
  const html = toHtml("[ok](https://example.com/p) [mail](mailto:a@b.co) [bad](javascript:alert(1))\n\n![pic](https://example.com/a.png) ![inline](data:image/png;base64,iVBORw0KGgo=)");
  assert.ok(html.includes('href="https://example.com/p"'), html);
  assert.ok(html.includes('href="mailto:a@b.co"'), html);
  assert.ok(!html.includes("javascript"), html);
  assert.ok(html.includes('src="https://example.com/a.png"'), html);
  assert.ok(html.includes('src="data:image/png;base64,iVBORw0KGgo="'), html);
});

test("the fragment form is sanitized the same way", () => {
  const frag = createRenderer(purify as never).toFragment('<img src=x onerror=alert(1)> [x](javascript:alert(1)) **ok**');
  const div = window.document.createElement("div");
  div.append(frag);
  assert.deepEqual(dangers(div.innerHTML), []);
  assert.ok(div.innerHTML.includes("<strong>ok</strong>"));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRun } from "./actions.ts";
import { cleanResult } from "./output.ts";
import { MARKDOWN_RULE, SYSTEM_PROMPT, buildMessages } from "./prompts.ts";

test("a Markdown document adds a rule to keep the syntax; other documents are unchanged", () => {
  const run = makeRun("rewrite");
  const plain = buildMessages(run, "hello");
  const md = buildMessages(run, "# Title\n\n| a | b |\n| - | - |", { markdown: true });
  assert.equal(plain[0].content, SYSTEM_PROMPT);
  assert.equal(md[0].content, `${SYSTEM_PROMPT}\n${MARKDOWN_RULE}`);
  assert.match(MARKDOWN_RULE, /pipe tables/);
  assert.match(MARKDOWN_RULE, /fenced code blocks/);
  assert.match(md[1].content, /<text>\n# Title/);
  assert.equal(buildMessages(run, "x", { markdown: false })[0].content, SYSTEM_PROMPT);
});

test("a Markdown reply keeps its own tables, fences and headings when it is cleaned", () => {
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  assert.equal(cleanResult(table, "| a | b |\n| - | - |\n| 1 | 2 |"), table);
  const doc = "# T\n\n```js\nlet x = 1;\n```\n\n- a\n- b";
  assert.equal(cleanResult(doc, doc), doc, "the input had a fence: nothing is stripped");
  assert.equal(cleanResult("```markdown\n# T\n- a\n```", "# T\n- a"), "# T\n- a", "a fence wrapped around the whole reply goes");
});

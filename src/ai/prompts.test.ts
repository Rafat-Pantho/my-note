import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS, expectedOutputTokens, makeRun } from "./actions.ts";
import { SYSTEM_PROMPT, buildMessages, promptTokens } from "./prompts.ts";
import { OLLAMA_MAX_CTX, checkContext, contextLimit, estimateTokens, ollamaNumCtx } from "./tokens.ts";

test("every action builds a run; options are required where they matter", () => {
  for (const id of ["summarize", "shorten", "rewrite", "grammar", "continue"] as const) {
    const r = makeRun(id);
    assert.equal(r.title, ACTIONS[id].label);
    assert.ok(r.instruction.length > 20);
  }
  assert.equal(makeRun("tone", { tone: "formal" }).title, "Change tone: Formal");
  assert.match(makeRun("tone", { tone: "friendly" }).instruction, /friendly tone/);
  assert.throws(() => makeRun("tone"), /Choose a tone/);
  assert.throws(() => makeRun("tone", { tone: "angry" }), /Choose a tone/);
  assert.equal(makeRun("translate", { language: "French" }).title, "Translate to French");
  assert.match(makeRun("translate", { language: " German " }).instruction, /into German\./);
  assert.throws(() => makeRun("translate", { language: " " }), /Choose a language/);
  assert.equal(makeRun("custom", { prompt: "  Make it rhyme  " }).instruction, "Make it rhyme");
  assert.throws(() => makeRun("custom", { prompt: "" }), /Write what you want/);
  const p = makeRun("preset", { prompt: "Add emoji", presetName: "Emoji" });
  assert.deepEqual([p.title, p.instruction], ["Emoji", "Add emoji"]);
});

test("how each result is offered", () => {
  assert.equal(ACTIONS.summarize.apply, "below");
  assert.equal(ACTIONS.continue.apply, "append");
  for (const id of ["shorten", "rewrite", "grammar", "tone", "translate", "custom", "preset"] as const) {
    assert.equal(ACTIONS[id].apply, "replace", id);
  }
  // word diffs for rewrites; none for summaries, translations and continuations
  assert.deepEqual(
    Object.values(ACTIONS).filter((a) => a.diff).map((a) => a.id).sort(),
    ["custom", "grammar", "preset", "rewrite", "shorten", "tone"],
  );
});

test("the system prompt demands only the result, same language, no fences, no preface", () => {
  assert.match(SYSTEM_PROMPT, /ONLY the resulting text/);
  assert.match(SYSTEM_PROMPT, /No preface/);
  assert.match(SYSTEM_PROMPT, /same language/);
  assert.match(SYSTEM_PROMPT, /code fences unless the input text itself contains them/);
  assert.match(SYSTEM_PROMPT, /line breaks/);
});

test("messages: system prompt, then instruction plus the text in tags", () => {
  const m = buildMessages(makeRun("shorten"), "Some  text\nwith lines");
  assert.equal(m.length, 2);
  assert.equal(m[0].role, "system");
  assert.equal(m[1].role, "user");
  assert.ok(m[1].content.endsWith("<text>\nSome  text\nwith lines\n</text>"));
  assert.match(m[1].content, /^Make the text shorter/);
  const empty = buildMessages(makeRun("custom", { prompt: "Write a haiku" }), "");
  assert.match(empty[1].content, /Write a haiku\n\n\(The document is empty\.\)/);
});

test("token estimates: English, CJK and other scripts", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("a".repeat(400)), 100);
  assert.equal(estimateTokens("日本語".repeat(100)), 300);
  assert.equal(estimateTokens("я".repeat(250)), 100);
  assert.ok(promptTokens(buildMessages(makeRun("rewrite"), "word ".repeat(1000))) > 1250);
});

test("expected reply size", () => {
  assert.equal(expectedOutputTokens(ACTIONS.rewrite, 1000), 1364);
  assert.equal(expectedOutputTokens(ACTIONS.summarize, 100), 200);
  assert.equal(expectedOutputTokens(ACTIONS.summarize, 100_000), 1500);
  assert.equal(expectedOutputTokens(ACTIONS.continue, 50), 1000);
});

test("Ollama context size: default for short text, bucketed for long, capped", () => {
  assert.equal(ollamaNumCtx(500), undefined);
  assert.equal(ollamaNumCtx(1500), undefined);
  assert.equal(ollamaNumCtx(1600), 4096);
  assert.equal(ollamaNumCtx(3700), 4096);
  assert.equal(ollamaNumCtx(3800), 8192);
  assert.equal(ollamaNumCtx(14_000), 16_384);
  assert.equal(ollamaNumCtx(20_000), OLLAMA_MAX_CTX);
  assert.equal(ollamaNumCtx(500_000), OLLAMA_MAX_CTX);
});

test("context warnings depend on the environment", () => {
  assert.equal(contextLimit("ollama", true), OLLAMA_MAX_CTX);
  const small = checkContext("openai_compatible", true, 6000);
  assert.equal(small.exceeds, true, "a local OpenAI-compatible server is assumed to run 4096");
  assert.equal(small.numCtx, undefined, "only Ollama takes a per-request window");
  assert.equal(checkContext("openai_compatible", false, 6000).exceeds, false);
  assert.equal(checkContext("anthropic", false, 150_000).exceeds, false);
  assert.equal(checkContext("anthropic", false, 250_000).exceeds, true);
  const o = checkContext("ollama", true, 9000);
  assert.deepEqual([o.exceeds, o.numCtx], [false, 16_384]);
  assert.equal(checkContext("ollama", true, 40_000).exceeds, true, "beyond what we will ask Ollama to load");
});

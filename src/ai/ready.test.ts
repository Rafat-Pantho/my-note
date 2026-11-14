import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedReason, destination } from "./ready.ts";
import type { ActiveEnv, AiStatus } from "./types.ts";

const env = (over: Partial<ActiveEnv> = {}): ActiveEnv => ({
  id: "e1", name: "Ollama", kind: "ollama", model: "llama3", host: "localhost:11434", local: true,
  consent: "granted", ready: true, ...over,
});
const status = (enabled: boolean, e: ActiveEnv | null): AiStatus => ({ enabled, env: e });

test("each blocked state explains itself and where to fix it", () => {
  assert.match(blockedReason(undefined)!, /AI is off/);
  assert.match(blockedReason(status(false, env()))!, /AI is off.*Settings > AI/);
  assert.match(blockedReason(status(true, null))!, /No AI environment/);
  assert.match(blockedReason(status(true, env({ consent: "denied", ready: false })))!, /did not allow connections to localhost:11434/);
  assert.match(blockedReason(status(true, env({ consent: "unset", ready: false })))!, /Allow the connection to localhost:11434/);
  assert.match(blockedReason(status(true, env({ model: null })))!, /No model is selected for Ollama/);
});

test("a ready environment is not blocked", () => {
  assert.equal(blockedReason(status(true, env())), null);
});

test("destination says where the text goes", () => {
  assert.equal(destination({ host: "localhost:11434", local: true }), "localhost:11434 (this computer)");
  assert.equal(destination({ host: "api.openai.com", local: false }), "api.openai.com (another machine)");
});

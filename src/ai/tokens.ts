/** Token estimates and context-window limits. All estimates: no tokenizer ships with the app, and every model
 *  counts differently, so these err on the side of warning early. */
import type { AiKind } from "./types.ts";

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

/** Rough token count: ~4 characters per token for English-like text, ~1 per CJK character, ~2.5 characters
 *  per token for other non-ASCII scripts (Cyrillic, Arabic, accented text...). */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(ascii / 4 + cjk + other / 2.5);
}

/** The window we assume when the model's real one is unknown (we do not ask the server). Ollama is special:
 *  we set its window per request, up to OLLAMA_MAX_CTX. A local OpenAI-compatible server (LM Studio...) is
 *  assumed to run its common default of 4096; hosted ones the common large windows. */
export function contextLimit(kind: AiKind, local: boolean): number {
  switch (kind) {
    case "ollama":
      return OLLAMA_MAX_CTX;
    case "openai_compatible":
      return local ? 4096 : 128_000;
    case "anthropic":
      return 200_000;
    case "gemini":
      return 1_000_000;
  }
}

export const OLLAMA_MAX_CTX = 32_768;
/** Below this we leave Ollama's own default alone. Its default is 2048 on some versions. */
const OLLAMA_DEFAULT_SAFE = 1500;
const OLLAMA_BUCKETS = [4096, 8192, 16_384, OLLAMA_MAX_CTX];

/** The `num_ctx` to send to Ollama for a request needing about `needTokens` (prompt + expected reply), or
 *  undefined when the text is short enough for the default. Bucketed so repeated requests reuse the same
 *  loaded model instead of reloading it for every slightly different size. Capped at OLLAMA_MAX_CTX (a bigger
 *  window costs a lot of memory); `checkContext` warns when the need is beyond the cap. */
export function ollamaNumCtx(needTokens: number): number | undefined {
  if (needTokens <= OLLAMA_DEFAULT_SAFE) return undefined;
  const padded = Math.ceil(needTokens * 1.1);
  return OLLAMA_BUCKETS.find((b) => b >= padded) ?? OLLAMA_MAX_CTX;
}

export interface ContextCheck {
  need: number;
  limit: number;
  /** Likely too big for the model: the user is asked before anything is sent. */
  exceeds: boolean;
  /** Only for Ollama: the window to request. */
  numCtx: number | undefined;
}

export function checkContext(kind: AiKind, local: boolean, needTokens: number): ContextCheck {
  const limit = contextLimit(kind, local);
  return {
    need: needTokens,
    limit,
    exceeds: needTokens > limit,
    numCtx: kind === "ollama" ? ollamaNumCtx(needTokens) : undefined,
  };
}

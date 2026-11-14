/** The AI actions. Pure data + one factory: what each action asks the model, how its result may be applied,
 *  and whether a word diff makes sense for it. */

/** replace = the result stands in for the scope; below = new text after the scope's last line;
 *  append = continues the scope's last words. */
export type ApplyMode = "replace" | "below" | "append";

export type ActionId =
  | "summarize"
  | "shorten"
  | "rewrite"
  | "grammar"
  | "tone"
  | "translate"
  | "continue"
  | "custom"
  | "preset";

export interface ActionDef {
  id: ActionId;
  label: string;
  /** The suggested way to apply the result (the primary Accept button). */
  apply: ApplyMode;
  /** Rewrites show a word diff of original vs result. */
  diff: boolean;
  /** Expected size of the reply relative to the input; drives the context estimate. */
  output: "same" | "short" | "open";
  /** The action needs text to work on (custom prompts may run on an empty file). */
  needsText: boolean;
}

export const TONES = [
  { value: "formal", label: "Formal" },
  { value: "casual", label: "Casual" },
  { value: "friendly", label: "Friendly" },
] as const;

export const LANGUAGES = [
  "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Russian", "Polish", "Turkish",
  "Arabic", "Hindi", "Bengali", "Chinese (Simplified)", "Chinese (Traditional)", "Japanese", "Korean",
  "Indonesian", "Vietnamese",
] as const;

export const ACTIONS: Record<ActionId, ActionDef> = {
  summarize: { id: "summarize", label: "Summarize", apply: "below", diff: false, output: "short", needsText: true },
  shorten: { id: "shorten", label: "Shorten", apply: "replace", diff: true, output: "same", needsText: true },
  rewrite: { id: "rewrite", label: "Rewrite (clearer)", apply: "replace", diff: true, output: "same", needsText: true },
  grammar: { id: "grammar", label: "Fix grammar and spelling", apply: "replace", diff: true, output: "same", needsText: true },
  tone: { id: "tone", label: "Change tone", apply: "replace", diff: true, output: "same", needsText: true },
  translate: { id: "translate", label: "Translate", apply: "replace", diff: false, output: "same", needsText: true },
  continue: { id: "continue", label: "Continue writing", apply: "append", diff: false, output: "open", needsText: true },
  custom: { id: "custom", label: "Custom prompt", apply: "replace", diff: true, output: "same", needsText: false },
  preset: { id: "preset", label: "Preset", apply: "replace", diff: true, output: "same", needsText: false },
};

/** One concrete request: an action plus its options. */
export interface ActionRun {
  def: ActionDef;
  /** Shown in the panel and stored in the rollback history, e.g. "Change tone: Formal". */
  title: string;
  /** What the model is asked to do with the text. */
  instruction: string;
}

export interface RunOptions {
  tone?: string;
  language?: string;
  /** Free text for a custom prompt, or a saved preset's instruction. */
  prompt?: string;
  /** A saved preset's name. */
  presetName?: string;
}

const INSTRUCTIONS: Partial<Record<ActionId, string>> = {
  summarize: "Summarize the text. Keep the key points and be much shorter than the original.",
  shorten: "Make the text shorter while keeping its meaning and key details. Keep the same tone and formatting.",
  rewrite:
    "Rewrite the text to be clearer and easier to read. Keep its meaning, facts, tone and formatting.",
  grammar:
    "Fix the grammar, spelling and punctuation of the text. Change nothing else: keep the wording, style and formatting, and do not add or remove content.",
  continue:
    "Continue writing the text from exactly where it ends, in the same voice, style and language. Reply with only the new continuation and do not repeat any of the existing text.",
};

const clean = (s: string | undefined) => (s ?? "").trim();

/** Builds a run, or throws a readable Error if an option is missing. */
export function makeRun(id: ActionId, opts: RunOptions = {}): ActionRun {
  const def = ACTIONS[id];
  switch (id) {
    case "tone": {
      const tone = TONES.find((t) => t.value === opts.tone);
      if (!tone) throw new Error("Choose a tone.");
      return { def, title: `${def.label}: ${tone.label}`, instruction: `Rewrite the text in a ${tone.value} tone. Keep its meaning and facts.` };
    }
    case "translate": {
      const language = clean(opts.language);
      if (!language) throw new Error("Choose a language.");
      return { def, title: `Translate to ${language}`, instruction: `Translate the text into ${language}.` };
    }
    case "custom": {
      const prompt = clean(opts.prompt);
      if (!prompt) throw new Error("Write what you want the AI to do.");
      return { def, title: "Custom prompt", instruction: prompt };
    }
    case "preset": {
      const prompt = clean(opts.prompt);
      if (!prompt) throw new Error("This preset has no instruction.");
      return { def, title: clean(opts.presetName) || "Preset", instruction: prompt };
    }
    default:
      return { def, title: def.label, instruction: INSTRUCTIONS[id]! };
  }
}

/** Tokens the reply is expected to take, given the input size. Used for the context estimate and `max_tokens`. */
export function expectedOutputTokens(def: ActionDef, inputTokens: number): number {
  switch (def.output) {
    case "same":
      return Math.ceil(inputTokens * 1.3) + 64;
    case "short":
      return Math.min(Math.max(Math.ceil(inputTokens * 0.5), 200), 1500);
    case "open":
      return Math.max(inputTokens, 1000);
  }
}

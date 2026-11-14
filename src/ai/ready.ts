/** Why AI actions are unavailable right now, in words for the user, or null if they can run. Pure. */
import type { AiStatus } from "./types.ts";

export function blockedReason(ai: AiStatus | undefined): string | null {
  if (!ai || !ai.enabled) return "AI is off. Nothing is sent anywhere. Turn it on in Settings > AI.";
  const e = ai.env;
  if (!e) return "No AI environment is set up. Add one in Settings > AI.";
  if (e.consent === "denied") {
    return `You did not allow connections to ${e.host}, so nothing can be sent. Allow it in Settings > AI to use AI actions.`;
  }
  if (!e.ready) return `Allow the connection to ${e.host} in Settings > AI first.`;
  if (!e.model) return `No model is selected for ${e.name}. Choose one in Settings > AI.`;
  return null;
}

/** "Local" / "Remote" wording for where the text will go. */
export function destination(e: { host: string; local: boolean }): string {
  return `${e.host} (${e.local ? "this computer" : "another machine"})`;
}

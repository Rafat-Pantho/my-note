/** Types shared with Rust `ai` module (type-only: nothing here ends up in the bundle). */

export type AiKind = "ollama" | "openai_compatible" | "anthropic" | "gemini";
export type Consent = "unset" | "granted" | "denied";

/** The active environment as the status bar needs it. Computed in Rust from the settings alone. */
export interface ActiveEnv {
  id: string;
  name: string;
  kind: AiKind;
  model: string | null;
  host: string;
  /** This computer (true) or another machine (false). */
  local: boolean;
  consent: Consent;
  /** Connections to this environment are allowed right now. */
  ready: boolean;
}

export interface AiStatus {
  enabled: boolean;
  env: ActiveEnv | null;
}

export interface EnvView {
  id: string;
  name: string;
  kind: AiKind;
  baseUrl: string;
  model: string | null;
  consent: Consent;
  consentOrigin: string;
  allowInsecure: boolean;
  /** A key is stored in the OS keychain (the key itself is never available here). */
  hasKey: boolean;
  models: string[];
  /** Unix seconds of the last successful listing; 0 = never. */
  modelsAt: number;
  host: string;
  local: boolean;
  secure: boolean;
  /** Plain http to a non-local host: needs the user's explicit OK. */
  needsInsecureOk: boolean;
  keyRequired: boolean;
  /** Consent was given for the current host. */
  consentValid: boolean;
}

export interface AiView {
  enabled: boolean;
  active: string | null;
  environments: EnvView[];
  status: AiStatus;
}

export interface EnableResult {
  view: AiView;
  ollama: "found" | "present" | "not_found";
}

export type StreamEvent =
  | { event: "chunk"; text: string }
  | { event: "done" }
  | { event: "cancelled" }
  | { event: "error"; message: string };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

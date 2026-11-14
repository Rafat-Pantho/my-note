/** Thin wrappers over the Rust `ai_*` commands. The frontend never makes network requests: every call here
 *  goes through Tauri IPC and Rust decides whether a connection is allowed. Part of a lazy chunk (Settings > AI,
 *  and later the AI actions); nothing here runs at startup. */
import { Channel, invoke } from "@tauri-apps/api/core";
import { setAiStatus } from "../theme/appearance";
import type { AiKind, AiView, ChatMessage, EnableResult, StreamEvent } from "./types";

/** Every command that changes the AI config returns the new view; keep the status bar in step with it. */
const view = async (p: Promise<AiView>): Promise<AiView> => {
  const v = await p;
  setAiStatus(v.status);
  return v;
};

export const getAi = () => view(invoke<AiView>("ai_get"));

export async function enableAi(): Promise<EnableResult> {
  const r = await invoke<EnableResult>("ai_enable");
  setAiStatus(r.view.status);
  return r;
}

export const disableAi = () => view(invoke<AiView>("ai_disable"));
export const addEnv = (kind: AiKind, name: string, baseUrl: string) =>
  view(invoke<AiView>("ai_add_env", { kind, name, baseUrl }));
export const updateEnv = (id: string, patch: { name?: string; baseUrl?: string }) =>
  view(invoke<AiView>("ai_update_env", { id, ...patch }));
export const removeEnv = (id: string) => view(invoke<AiView>("ai_remove_env", { id }));
export const setActive = (id: string) => view(invoke<AiView>("ai_set_active", { id }));
/** The key goes to the OS keychain and is never readable from here again. */
export const setKey = (id: string, key: string) => view(invoke<AiView>("ai_set_key", { id, key }));
export const clearKey = (id: string) => view(invoke<AiView>("ai_clear_key", { id }));
export const setConsent = (id: string, granted: boolean, allowInsecure = false) =>
  view(invoke<AiView>("ai_set_consent", { id, granted, allowInsecure }));
/** Rejects with a readable message (not running, 401, 404, timeout...) or if the user has not allowed it. */
export const listModels = (id: string) => view(invoke<AiView>("ai_list_models", { id }));
export const setModel = (id: string, model: string | null) =>
  view(invoke<AiView>("ai_set_model", { id, model }));
export const openOllamaSite = () => invoke<void>("open_ollama_site");

let counter = 0;
export const newRequestId = () => `r${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Streams a reply. `onEvent` gets chunks and exactly one terminal event (done, cancelled or error). Resolves
 *  when Rust is finished; rejects only if the request was refused before any connection (not allowed...). */
export function streamChat(
  id: string,
  requestId: string,
  messages: ChatMessage[],
  onEvent: (e: StreamEvent) => void,
  maxTokens?: number,
): Promise<void> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("ai_stream", { id, requestId, messages, maxTokens, onEvent: channel });
}

/** Aborts a running stream; Rust drops the request, which closes the connection. */
export const cancelChat = (requestId: string) => invoke<void>("ai_cancel", { requestId });

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AiStatus } from "../ai/types";

/** Mirrors Rust `config::Settings` and `effects::Status`. Rust validates; this only displays and applies. */
export interface Settings {
  defaultEncoding: string;
  defaultLineEnding: string;
  wordWrap: boolean;
  /** CSS font-family list; empty means the built-in monospace stack. */
  fontFamily: string;
  fontSize: number;
  tabSize: number;
  restoreSession: boolean;
  theme: "light" | "dark" | "system";
  effects: "off" | "transparent" | "blur";
  /** 0.5 to 1.0, applied to the background layer only. */
  opacity: number;
  reduceEffects: boolean;
  openInNewWindow: boolean;
  /** "" (not chosen yet), "bing", "google", "duckduckgo" or a custom URL template with %s. */
  searchEngine: string;
  statusBar: boolean;
}

export interface EffectStatus {
  requested: Settings["effects"];
  active: Settings["effects"];
  backend: string;
  /** Why the active mode differs from the request. */
  reason: string | null;
  blurSupported: boolean;
  transparentSupported: boolean;
  dark: boolean;
}

export interface Appearance {
  settings: Settings;
  status: EffectStatus;
  /** Active AI environment and local/remote, for the status bar. Rust derives it from the settings alone. */
  ai: AiStatus;
}

let current: Appearance | null = null;
const listeners = new Set<(a: Appearance) => void>();

/** Called after every settings change, whoever made it (panel, shortcut, OS re-check). Returns an unsubscribe. */
export function onAppearance(fn: (a: Appearance) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const appearance = (): Appearance | null => current;

/** Maps the resolved state onto the root element; CSS does the rest (see styles.css). */
export function applyAppearance(a: Appearance): void {
  current = a;
  const root = document.documentElement;
  root.dataset.theme = a.status.dark ? "dark" : "light";
  root.classList.toggle("fx", a.status.active !== "off");
  root.classList.toggle("fx-blur", a.status.active === "blur");
  root.classList.toggle("reduce-fx", a.settings.reduceEffects);
  root.style.setProperty("--fx-pct", `${Math.round(a.settings.opacity * 100)}%`);
  for (const fn of listeners) fn(a);
}

/** Loads settings and the real effect status from Rust, applies them. Never throws: failure leaves the
 *  default solid dark look and default settings, which is a fully working editor. */
export async function loadAppearance(): Promise<void> {
  try {
    applyAppearance(await invoke<Appearance>("get_settings"));
    // Rust re-checks OS state on focus/theme change and tells us if the outcome changed.
    void listen<Appearance>("appearance-changed", (e) => applyAppearance(e.payload));
  } catch {
    /* solid default */
  }
}

/** Pushes a new AI status (after any AI settings change) to everything that listens, e.g. the status bar. */
export function setAiStatus(ai: AiStatus): void {
  if (current) applyAppearance({ ...current, ai });
}

export async function setAppearance(patch: Partial<Settings>): Promise<Appearance> {
  const a = await invoke<Appearance>("set_settings", { patch });
  applyAppearance(a);
  return a;
}

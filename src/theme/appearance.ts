import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Mirrors Rust `config::Settings` and `effects::Status`. Rust validates; this only displays and applies. */
export interface Settings {
  theme: "light" | "dark" | "system";
  effects: "off" | "transparent" | "blur";
  /** 0.5 to 1.0, applied to the background layer only. */
  opacity: number;
  reduceEffects: boolean;
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
}

let current: Appearance | null = null;

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
}

/** Loads settings and the real effect status from Rust, applies them. Never throws: failure leaves the
 *  default solid dark look, which is a fully working editor. */
export async function loadAppearance(): Promise<void> {
  try {
    applyAppearance(await invoke<Appearance>("get_appearance"));
    // Rust re-checks OS state on focus/theme change and tells us if the outcome changed.
    void listen<Appearance>("appearance-changed", (e) => applyAppearance(e.payload));
  } catch {
    /* solid default */
  }
}

export async function setAppearance(patch: Partial<Settings>): Promise<Appearance> {
  const a = await invoke<Appearance>("set_appearance", { patch });
  applyAppearance(a);
  return a;
}

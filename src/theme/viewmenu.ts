/** TEMPORARY (M2): test-only View menu for theme, effects, opacity and Reduce effects.
 *  M3 replaces it with the Settings UI. To remove: delete this file, the #viewmenu button in index.html,
 *  and the createViewMenu call in app.ts. */
import { type Settings, appearance, setAppearance } from "./appearance";

const OPACITIES = [1, 0.9, 0.8, 0.7, 0.6, 0.5];

function describe(): string {
  const a = appearance();
  if (!a) return "Appearance not loaded";
  const { status: s } = a;
  const now = s.active === "off" ? "solid" : `${s.active} (${s.backend})`;
  const why = s.reason ? ` Reason: ${s.reason}.` : "";
  const sup = `Blur ${s.blurSupported ? "available" : "not available"}, transparency ${s.transparentSupported ? "available" : "not available"}.`;
  return `Now: ${now}.${why} ${sup}`;
}

export function createViewMenu(anchor: HTMLElement): void {
  anchor.addEventListener("click", () => open(anchor));
}

function open(anchor: HTMLElement): void {
  if (document.querySelector(".menu")) {
    document.querySelector(".menu")!.remove();
    return;
  }
  const a = appearance();
  const s: Settings = a?.settings ?? { theme: "system", effects: "off", opacity: 1, reduceEffects: false };
  const menu = document.createElement("div");
  menu.className = "menu";

  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const heading = (t: string) => {
    const h = document.createElement("div");
    h.className = "hd";
    h.textContent = t;
    menu.append(h);
  };
  const item = (label: string, on: boolean, patch: Partial<Settings>, disabled = false) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.disabled = disabled;
    if (on) b.className = "on";
    b.addEventListener("click", () => {
      close();
      void setAppearance(patch);
    });
    menu.append(b);
  };

  heading("Theme");
  item("Light", s.theme === "light", { theme: "light" });
  item("Dark", s.theme === "dark", { theme: "dark" });
  item("System", s.theme === "system", { theme: "system" });
  heading("Effects");
  item("Off (solid)", s.effects === "off", { effects: "off" });
  item("Transparent", s.effects === "transparent", { effects: "transparent" }, a ? !a.status.transparentSupported : false);
  item("Blur", s.effects === "blur", { effects: "blur" }, a ? !a.status.blurSupported : false);
  heading("Background opacity");
  for (const o of OPACITIES) item(`${Math.round(o * 100)}%`, Math.abs(s.opacity - o) < 0.005, { opacity: o });
  menu.append(document.createElement("hr"));
  item("Reduce effects", s.reduceEffects, { reduceEffects: !s.reduceEffects });
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = describe();
  menu.append(note);

  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${r.bottom + 4}px`;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", onKey, true);
}

/** The AI actions popup (button, Ctrl+I and the right-click menu all open this). Plain DOM, no logic of its
 *  own: it shows what the controller tells it and reports what was picked. Part of the lazy AI chunk. */
import { ACTIONS, type ActionId, LANGUAGES, type RunOptions, TONES } from "./actions";
import type { Preset } from "./types";

export interface MenuModel {
  /** Where to open: under an element, or at a point (right-click). */
  at: HTMLElement | { x: number; y: number };
  /** "Selection, 123 words" / "Whole file, 1,234 words": what the action will work on. */
  scopeLabel: string;
  /** Why nothing can run (AI off, not allowed...), or null. Rows are disabled and this is shown. */
  blocked: string | null;
  /** The text to work on is empty: actions that need text are disabled. */
  emptyText: boolean;
  presets: Preset[];
  historyCount: number;
  onRun(id: ActionId, opts: RunOptions): void;
  onHistory(): void;
  onSettings(): void;
  onClose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

export function showActionMenu(m: MenuModel): void {
  document.querySelector(".aimenu")?.remove();
  const menu = el("div", "aimenu");
  menu.setAttribute("role", "menu");
  let closed = false;
  const close = (refocus = true) => {
    if (closed) return;
    closed = true;
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
    if (refocus) m.onClose();
  };
  const run = (id: ActionId, opts: RunOptions = {}) => {
    close(false);
    m.onRun(id, opts);
  };
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };

  const head = el("div", "aim-scope");
  head.append("Works on: ", el("strong", "", m.scopeLabel));
  menu.append(head);

  if (m.blocked) {
    const box = el("div", "aim-blocked");
    box.append(el("p", "", m.blocked));
    const b = el("button", "aim-link", "Open AI settings");
    b.onclick = () => {
      close(false);
      m.onSettings();
    };
    box.append(b);
    menu.append(box);
  }

  const off = (id: ActionId) => m.blocked !== null || (ACTIONS[id].needsText && m.emptyText);
  const why = (id: ActionId) =>
    m.blocked ?? (ACTIONS[id].needsText && m.emptyText ? "Nothing to work on: it is empty. Type or select some text first." : "");

  const simple = (id: ActionId, label = ACTIONS[id].label) => {
    const b = el("button", "aim-row", label);
    b.disabled = off(id);
    b.title = why(id);
    b.onclick = () => run(id);
    return b;
  };
  const inline = (label: string, ...controls: HTMLElement[]) => {
    const r = el("div", "aim-inline");
    r.append(el("span", "aim-lbl", label), ...controls);
    return r;
  };

  menu.append(simple("summarize"), simple("shorten"), simple("rewrite"), simple("grammar"));

  // Change tone: three buttons
  const tones = TONES.map((t) => {
    const b = el("button", "aim-mini", t.label);
    b.disabled = off("tone");
    b.title = why("tone");
    b.onclick = () => run("tone", { tone: t.value });
    return b;
  });
  menu.append(inline("Change tone:", ...tones));

  // Translate: language picker + button
  const lang = el("select");
  for (const l of LANGUAGES) lang.append(new Option(l, l));
  const go = el("button", "aim-mini", "Translate");
  lang.disabled = go.disabled = off("translate");
  go.title = why("translate");
  go.onclick = () => run("translate", { language: lang.value });
  menu.append(inline("Translate to:", lang, go));

  menu.append(simple("continue"));

  // Custom prompt: free text
  const prompt = el("input");
  prompt.type = "text";
  prompt.placeholder = "Custom prompt: what should the AI do?";
  prompt.spellcheck = false;
  const send = el("button", "aim-mini", "Run");
  prompt.disabled = send.disabled = off("custom");
  send.title = why("custom");
  const runCustom = () => {
    if (prompt.value.trim()) run("custom", { prompt: prompt.value });
  };
  send.onclick = runCustom;
  prompt.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runCustom();
    }
  };
  const customRow = el("div", "aim-inline aim-custom");
  customRow.append(prompt, send);
  menu.append(customRow);

  if (m.presets.length) {
    menu.append(el("div", "aim-sep", "Your actions"));
    for (const p of m.presets) {
      const b = el("button", "aim-row", p.name);
      b.disabled = off("preset");
      b.title = why("preset") || p.instruction;
      b.onclick = () => run("preset", { prompt: p.instruction, presetName: p.name });
      menu.append(b);
    }
  }

  menu.append(el("div", "aim-sep"));
  const hist = el("button", "aim-row", m.historyCount ? `Rollback history (${m.historyCount})...` : "Rollback history");
  hist.disabled = m.historyCount === 0;
  hist.title = m.historyCount ? "" : "No AI changes have been accepted in this tab yet.";
  hist.onclick = () => {
    close(false);
    m.onHistory();
  };
  menu.append(hist);

  document.body.append(menu);
  place(menu, m.at);
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", onKey, true);
  (menu.querySelector("button:not(:disabled), input:not(:disabled)") as HTMLElement | null)?.focus();
}

/** Positions the popup under an element (right edges aligned) or at a point, kept inside the window. */
function place(menu: HTMLElement, at: MenuModel["at"]): void {
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let x: number;
  let y: number;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    x = r.right - w;
    y = r.bottom + 4;
  } else {
    x = at.x;
    y = at.y;
  }
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`;
}

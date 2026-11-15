/** Settings panel. Lazy chunk: loaded the first time Settings is opened, never at startup.
 *  Every control saves through Rust (`set_settings`, which validates and debounces the file write) and the
 *  change applies live: the app listens with `onAppearance`. Controls re-sync from the settings Rust returns,
 *  so a value Rust clamped or rejected snaps back to what is really in effect. */
import "./settings.css";
import { invoke } from "@tauri-apps/api/core";
import { FILE_TYPES } from "../editor/spelltypes";
import { ENCODINGS, LINE_ENDINGS } from "../editor/statusbar";
import { showInFolder } from "../tabs/ipc";
import { type Appearance, type Settings, appearance, onAppearance, setAppearance } from "../theme/appearance";

type Sync = (a: Appearance) => void;
type Keys<T> = { [K in keyof Settings]: Settings[K] extends T ? K : never }[keyof Settings];

const SECTIONS = [
  ["general", "General"],
  ["appearance", "Appearance"],
  ["spelling", "Spelling"],
  ["ai", "AI"],
] as const;

const FONT_SUGGESTIONS = [
  "Cascadia Mono", "Cascadia Code", "Consolas", "Courier New", "Lucida Console", "Menlo", "SF Mono",
  "DejaVu Sans Mono", "JetBrains Mono", "Fira Code", "monospace",
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** What the window is really doing, and why it differs from the request (if it does). */
function describeEffects(a: Appearance): string {
  const { status: s } = a;
  const now = s.active === "off" ? "solid" : `${s.active} (${s.backend})`;
  const why = s.reason ? ` Reason: ${s.reason}.` : "";
  const blur = s.blurSupported ? "available" : "not available on this system";
  const trans = s.transparentSupported ? "available" : "not available on this system";
  return `Now: ${now}.${why} Blur: ${blur}. Transparency: ${trans}.`;
}

export interface SettingsPanel {
  dispose(): void;
  /** Switches to a section ("general", "appearance", "ai"); unknown ids are ignored. */
  show(section: string): void;
}

export function mountSettings(host: HTMLElement): SettingsPanel {
  const syncs: Sync[] = [];
  const save = (patch: Partial<Settings>) => setAppearance(patch).catch(() => appearance());

  /* ----- controls: each returns its element and registers how to refresh it ----- */

  const select = (key: Keys<string>, items: { label: string; value: string }[]) => {
    const c = el("select");
    for (const it of items) c.append(new Option(it.label, it.value));
    c.onchange = () => void save({ [key]: c.value });
    syncs.push((a) => (c.value = String(a.settings[key])));
    return c;
  };

  const checkbox = (key: Keys<boolean>) => {
    const c = el("input");
    c.type = "checkbox";
    c.onchange = () => void save({ [key]: c.checked });
    syncs.push((a) => (c.checked = Boolean(a.settings[key])));
    return c;
  };

  const number = (key: Keys<number>, min: number, max: number) => {
    const c = el("input", "num");
    c.type = "number";
    c.min = String(min);
    c.max = String(max);
    c.step = "1";
    const show = (a: Appearance | null) => a && (c.value = String(a.settings[key]));
    c.onchange = async () => {
      const n = Number(c.value);
      show(c.value.trim() !== "" && Number.isFinite(n) ? await save({ [key]: n }) : appearance());
    };
    syncs.push((a) => document.activeElement !== c && show(a));
    return c;
  };

  const fontFamily = () => {
    const c = el("input", "wide");
    c.type = "text";
    c.placeholder = "Default monospace";
    c.setAttribute("list", "st-fonts");
    c.spellcheck = false;
    const list = el("datalist");
    list.id = "st-fonts";
    for (const f of FONT_SUGGESTIONS) list.append(new Option(f));
    const show = (a: Appearance | null) => a && (c.value = a.settings.fontFamily);
    c.onchange = async () => show(await save({ fontFamily: c.value }));
    syncs.push((a) => document.activeElement !== c && show(a));
    const wrap = el("span", "grow");
    wrap.append(c, list);
    return wrap;
  };

  /** Ctrl+E engine. "Custom" shows up only while a custom address is set (it is chosen in the Ctrl+E dialog). */
  const searchEngine = () => {
    const c = el("select");
    for (const [label, v] of [["Ask on first use", ""], ["Bing", "bing"], ["Google", "google"], ["DuckDuckGo", "duckduckgo"]]) {
      c.append(new Option(label, v));
    }
    const custom = new Option("", "custom");
    c.append(custom);
    c.onchange = () => void save({ searchEngine: c.value });
    syncs.push((a) => {
      const v = a.settings.searchEngine;
      const known = ["", "bing", "google", "duckduckgo"].includes(v);
      custom.hidden = known;
      if (!known) {
        let host = v;
        try {
          host = new URL(v.replace("%s", "x")).host;
        } catch {
          /* show the raw text */
        }
        custom.text = `Custom: ${host}`;
      }
      c.value = known ? v : "custom";
    });
    return c;
  };

  /* ----- spelling: toggles, file types, dictionaries (the list is read from Rust when the section is shown) ----- */

  const fileTypes = () => {
    const box = el("div", "types");
    for (const t of FILE_TYPES) {
      const label = el("label", "type");
      const c = el("input");
      c.type = "checkbox";
      c.onchange = () => void save({ spellTypes: { [t.id]: c.checked } });
      syncs.push((a) => (c.checked = !!a.settings.spellTypes?.[t.id]));
      const text = el("span", "", t.label);
      if (t.hint) text.append(el("span", "hint", t.hint));
      label.append(c, text);
      box.append(label);
    }
    return box;
  };

  interface Lang {
    id: string;
    name: string;
  }
  const langSelect = el("select");
  const fallbackLang = "en_US";
  const showLanguage = (a: Appearance | null) => {
    const want = a?.settings.spellLanguage ?? fallbackLang;
    langSelect.value = [...langSelect.options].some((o) => o.value === want) ? want : fallbackLang;
  };
  const loadLanguages = async () => {
    const langs = await invoke<Lang[]>("spell_languages").catch(() => [] as Lang[]);
    langSelect.replaceChildren(...(langs.length ? langs : [{ id: fallbackLang, name: "English (United States), built in" }]).map((l) => new Option(l.name, l.id)));
    showLanguage(appearance());
  };
  langSelect.onchange = () => void save({ spellLanguage: langSelect.value });
  syncs.push(showLanguage);

  const dictFolder = () => {
    const wrap = el("span", "folder");
    const where = el("span", "where");
    const choose = el("button", "btn", "Choose folder...");
    const clear = el("button", "btn", "Clear");
    choose.onclick = async (e) => {
      e.preventDefault();
      const dir = await invoke<string | null>("spell_pick_dir").catch(() => null);
      if (dir) {
        await save({ spellDictDir: dir });
        await loadLanguages();
      }
    };
    clear.onclick = async (e) => {
      e.preventDefault();
      await save({ spellDictDir: "" });
      await loadLanguages();
    };
    syncs.push((a) => {
      const d = a.settings.spellDictDir;
      where.textContent = d || "None";
      where.title = d;
      clear.hidden = !d;
    });
    wrap.append(where, choose, clear);
    return wrap;
  };

  const personalNote = el("p", "note");
  const personalButton = () => {
    const b = el("button", "btn", "Show file");
    b.onclick = async (e) => {
      e.preventDefault();
      const path = await invoke<string | null>("spell_personal_path").catch(() => null);
      if (path) await showInFolder(path).catch(() => {});
      else personalNote.textContent = "No words added yet. Right-click a misspelled word and choose Add to dictionary.";
    };
    return b;
  };

  const effectMode = () => {
    const c = select("effects", [
      { label: "Off (solid)", value: "off" },
      { label: "Transparent", value: "transparent" },
      { label: "Blur", value: "blur" },
    ]);
    // Only offer what this OS can do; Rust still validates and falls back if a call fails.
    syncs.push(({ status: s }) => {
      c.options[1].disabled = !s.transparentSupported;
      c.options[2].disabled = !s.blurSupported;
    });
    return c;
  };

  const opacity = () => {
    const wrap = el("span", "range");
    const c = el("input");
    c.type = "range";
    c.min = "50";
    c.max = "100";
    c.step = "5";
    const out = el("output");
    let pending = 0;
    c.oninput = () => {
      out.textContent = `${c.value}%`;
      // One update per frame while dragging.
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => void save({ opacity: Number(c.value) / 100 }));
    };
    syncs.push((a) => {
      if (document.activeElement !== c) c.value = String(Math.round(a.settings.opacity * 100));
      out.textContent = `${c.value}%`;
      c.disabled = a.settings.effects === "off";
    });
    wrap.append(c, out);
    return wrap;
  };

  /* ----- layout ----- */

  const row = (label: string, control: HTMLElement, hint = "") => {
    const r = el("label", "row");
    const text = el("span", "lbl", label);
    if (hint) text.append(el("span", "hint", hint));
    r.append(text, control);
    return r;
  };

  const section = (title: string, ...children: HTMLElement[]) => {
    const s = el("section");
    s.append(el("h2", "", title), ...children);
    return s;
  };

  const effectsNote = el("p", "note");
  syncs.push((a) => (effectsNote.textContent = describeEffects(a)));

  // The AI section is its own lazy chunk, fetched the first time the section is shown (never at startup).
  const aiHost = el("div");
  let aiRequested = false;
  let disposeAi: (() => void) | null = null;
  let torn = false;
  const loadAi = () => {
    if (aiRequested) return;
    aiRequested = true;
    void import("../ai/settings").then((m) => {
      if (!torn) disposeAi = m.mountAi(aiHost);
    });
  };

  const panels: Record<(typeof SECTIONS)[number][0], HTMLElement> = {
    general: section(
      "General",
      row("Default encoding", select("defaultEncoding", ENCODINGS as { label: string; value: string }[]), "For new files"),
      row("Default line ending", select("defaultLineEnding", LINE_ENDINGS as { label: string; value: string }[]), "For new files"),
      row("Word wrap", checkbox("wordWrap"), "Alt+Z also toggles it"),
      row("Font family", fontFamily(), "Applies to the editor"),
      row("Font size", number("fontSize", 8, 48), "Pixels at 100% zoom"),
      row("Tab size", number("tabSize", 1, 16), "Width of a tab character, in spaces"),
      row("Restore session", checkbox("restoreSession"), "Reopen tabs and unsaved text at startup"),
      row("Auto-save", checkbox("autoSave"), "Saves files that already have a name after a pause in typing"),
      row("Auto-save delay", number("autoSaveSeconds", 1, 600), "Seconds without typing"),
      row("Show control characters", checkbox("showControlChars"), "Make joiners, bidi marks and other invisible characters visible"),
      row("Open files in a new window", checkbox("openInNewWindow"), "File > Open and Recent. Off: a new tab"),
      row("Search engine", searchEngine(), "Ctrl+E sends the selected text to it, in your browser"),
    ),
    appearance: section(
      "Appearance",
      row(
        "Theme",
        select("theme", [
          { label: "System", value: "system" },
          { label: "Light", value: "light" },
          { label: "Dark", value: "dark" },
        ]),
      ),
      row("Effect mode", effectMode(), "Window transparency or blur behind the background"),
      row("Opacity", opacity(), "Background only, never text. Used by Transparent and Blur"),
      row("Reduce effects", checkbox("reduceEffects"), "Solid background, no animation"),
      effectsNote,
    ),
    spelling: section(
      "Spelling",
      row("Spell check", checkbox("spellCheck"), "Red wavy underline and right-click suggestions"),
      row("Autocorrect", checkbox("autocorrect"), "Fixes common typos when you press Space or Enter. Ctrl+Z undoes it"),
      row("Language", langSelect, "Only dictionaries that are available are listed"),
      row("Extra dictionaries", dictFolder(), "A folder with Hunspell .dic and .aff pairs (bn_BD.dic + bn_BD.aff). Nothing is downloaded"),
      row("Your dictionary", personalButton(), "Words you added, one per line, in the config folder"),
      personalNote,
      el("h3", "", "Check spelling and autocorrect in"),
      fileTypes(),
      el("p", "note", "Words in a writing system that has no dictionary loaded (for example Bengali with the English dictionary) are never underlined."),
    ),
    ai: section("AI", aiHost),
  };

  const nav = el("nav", "st-nav");
  const main = el("div", "st-main");
  const buttons = new Map<string, HTMLButtonElement>();
  const show = (id: keyof typeof panels) => {
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== id;
    for (const [k, b] of buttons) b.classList.toggle("on", k === id);
    if (id === "ai") loadAi();
    if (id === "spelling") void loadLanguages();
  };
  for (const [id, label] of SECTIONS) {
    const b = el("button", "", label);
    b.onclick = () => show(id);
    buttons.set(id, b);
    nav.append(b);
    main.append(panels[id]);
  }

  const root = el("div", "st");
  root.append(nav, main);
  host.replaceChildren(root);
  show("general");

  const refresh: Sync = (a) => syncs.forEach((f) => f(a));
  const current = appearance();
  if (current) refresh(current);
  const off = onAppearance(refresh);

  return {
    show(section) {
      if (section in panels) show(section as keyof typeof panels);
    },
    dispose() {
      torn = true;
      disposeAi?.();
      off();
      host.replaceChildren();
    },
  };
}

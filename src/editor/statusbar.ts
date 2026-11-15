import type { AiStatus } from "../ai/types";
import { type MenuItem, showMenu } from "./dialog";

export const ENCODINGS: MenuItem[] = [
  { label: "UTF-8", value: "utf-8" },
  { label: "UTF-8 with BOM", value: "utf-8-bom" },
  { label: "UTF-16 LE", value: "utf-16le" },
  { label: "UTF-16 BE", value: "utf-16be" },
  { label: "Windows-1252", value: "windows-1252" },
];

export const LINE_ENDINGS: MenuItem[] = [
  { label: "Windows (CRLF)", value: "crlf" },
  { label: "Unix (LF)", value: "lf" },
  { label: "Macintosh (CR)", value: "cr" },
];

const label = (items: MenuItem[], v: string) => items.find((i) => i.value === v)?.label ?? v;

export interface StatusInfo {
  line: number;
  col: number;
  selected: number;
  /** Total characters in the document (UTF-16 code units, from the document length). */
  chars: number;
  readOnly: boolean;
  zoom: number;
  wrap: boolean;
  encoding: string;
  lineEnding: string;
}

export interface StatusHandlers {
  toggleWrap(): void;
  resetZoom(): void;
  setEncoding(v: string): void;
  setLineEnding(v: string): void;
  /** The AI indicator was clicked: open Settings > AI. */
  openAi(): void;
}

/** Text, badge and tooltip for the AI indicator. Pure, so the wording lives in one place. */
export function describeAi(ai: AiStatus): { text: string; badge: "local" | "remote" | ""; title: string; state: string } {
  if (!ai.enabled) return { text: "AI off", badge: "", state: "off", title: "AI is off. Nothing is sent anywhere. Click to set it up." };
  const e = ai.env;
  if (!e) return { text: "AI: no environment", badge: "", state: "none", title: "AI is on but no environment is set up. Click to add one." };
  const where = e.local ? "on this computer" : "on another machine";
  const allowed = e.ready ? "" : e.consent === "denied" ? " · not allowed" : " · needs permission";
  return {
    text: `${e.name} · ${e.model ?? "no model"}${allowed}`,
    badge: e.local ? "local" : "remote",
    state: e.ready ? "ready" : "blocked",
    title: `Active AI environment: ${e.name} at ${e.host} (${where}). Text is sent there only when you run an AI action. Click to open AI settings.`,
  };
}

export function createStatusBar(host: HTMLElement, h: StatusHandlers) {
  const mk = (tag: "span" | "button", title = "") => {
    const el = document.createElement(tag);
    el.title = title;
    return el;
  };
  const msg = mk("span");
  msg.className = "msg";
  const sp = mk("span");
  sp.className = "sp";
  const pos = mk("span");
  const chars = mk("span", "Characters in the document");
  const ro = mk("span", "This file is read-only. Save offers Save as.");
  ro.className = "ro";
  ro.hidden = true;
  const sel = mk("span");
  const zoom = mk("button", "Reset zoom (Ctrl+0)");
  const wrap = mk("button", "Toggle word wrap (Alt+Z)");
  const enc = mk("button", "Encoding used when saving");
  const eol = mk("button", "Line ending used when saving");
  const ai = mk("button");
  ai.className = "ai";
  const aiText = mk("span");
  const aiBadge = mk("span");
  ai.append(aiText, aiBadge);
  host.append(ai, msg, sp, ro, pos, chars, sel, zoom, wrap, enc, eol);

  ai.onclick = h.openAi;
  zoom.onclick = h.resetZoom;
  wrap.onclick = h.toggleWrap;
  enc.onclick = () => showMenu(enc, ENCODINGS, enc.dataset.v ?? "", h.setEncoding);
  eol.onclick = () => showMenu(eol, LINE_ENDINGS, eol.dataset.v ?? "", h.setLineEnding);

  return {
    /** Active AI environment and whether it is local or remote. */
    setAi(status: AiStatus): void {
      const d = describeAi(status);
      aiText.textContent = d.text;
      aiBadge.textContent = d.badge === "local" ? "Local" : d.badge === "remote" ? "Remote" : "";
      aiBadge.className = `badge ${d.badge}`;
      aiBadge.hidden = !d.badge;
      ai.dataset.state = d.state;
      ai.title = d.title;
    },
    /** Transient text on the left, e.g. "Opening file...". */
    message(text: string): void {
      msg.textContent = text;
    },
    set(s: Partial<StatusInfo>): void {
      if (s.line !== undefined || s.col !== undefined) {
        pos.dataset.l = String(s.line ?? pos.dataset.l);
        pos.dataset.c = String(s.col ?? pos.dataset.c);
        pos.textContent = `Ln ${pos.dataset.l}, Col ${pos.dataset.c}`;
      }
      if (s.readOnly !== undefined) {
        ro.hidden = !s.readOnly;
        ro.textContent = s.readOnly ? "Read-only" : "";
      }
      if (s.chars !== undefined) chars.textContent = `${s.chars.toLocaleString()} chars`;
      if (s.selected !== undefined) sel.textContent = s.selected > 0 ? `${s.selected} selected` : "";
      if (s.zoom !== undefined) zoom.textContent = `${s.zoom}%`;
      if (s.wrap !== undefined) wrap.textContent = s.wrap ? "Wrap: on" : "Wrap: off";
      if (s.encoding !== undefined) {
        enc.dataset.v = s.encoding;
        enc.textContent = label(ENCODINGS, s.encoding);
      }
      if (s.lineEnding !== undefined) {
        eol.dataset.v = s.lineEnding;
        eol.textContent = label(LINE_ENDINGS, s.lineEnding);
      }
    },
  };
}

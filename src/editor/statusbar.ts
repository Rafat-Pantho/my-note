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
  const sel = mk("span");
  const zoom = mk("button", "Reset zoom (Ctrl+0)");
  const wrap = mk("button", "Toggle word wrap (Alt+Z)");
  const enc = mk("button", "Encoding used when saving");
  const eol = mk("button", "Line ending used when saving");
  host.append(msg, sp, pos, sel, zoom, wrap, enc, eol);

  zoom.onclick = h.resetZoom;
  wrap.onclick = h.toggleWrap;
  enc.onclick = () => showMenu(enc, ENCODINGS, enc.dataset.v ?? "", h.setEncoding);
  eol.onclick = () => showMenu(eol, LINE_ENDINGS, eol.dataset.v ?? "", h.setLineEnding);

  return {
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

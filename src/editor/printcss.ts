/** Print page setup -> CSS. Pure. Margins and orientation use `@page`; header and footer use `@page` margin boxes
 *  (supported by the WebView2 / Chromium print engine), with these codes (like Notepad's):
 *  &f file name, &p page number, &P page count, &d date, &l &c &r left / centre / right, && an ampersand. */

export interface PrintSetup {
  marginMm: number;
  landscape: boolean;
  header: string;
  footer: string;
}

export interface PrintContext {
  name: string;
  date: string;
}

type Part = { text: string } | { counter: "page" | "pages" };
type Align = "left" | "center" | "right";

const quote = (s: string) => `"${s.replace(/[\\"]/g, "\\$&").replace(/[\r\n]+/g, " ")}"`;

/** Splits header/footer text into its three sections, each a list of text and counters. */
export function parseCodes(text: string, ctx: PrintContext): Record<Align, Part[]> {
  const out: Record<Align, Part[]> = { left: [], center: [], right: [] };
  let at: Align = "center";
  const add = (p: Part) => {
    const list = out[at];
    const last = list[list.length - 1];
    if ("text" in p && last && "text" in last) last.text += p.text;
    else list.push(p);
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "&" || i === text.length - 1) {
      add({ text: text[i] });
      continue;
    }
    const code = text[++i];
    if (code === "f") add({ text: ctx.name });
    else if (code === "d") add({ text: ctx.date });
    else if (code === "p") add({ counter: "page" });
    else if (code === "P") add({ counter: "pages" });
    else if (code === "l") at = "left";
    else if (code === "c") at = "center";
    else if (code === "r") at = "right";
    else if (code === "&") add({ text: "&" });
    else add({ text: "&" + code }); // unknown code: shown as typed
  }
  return out;
}

const content = (parts: Part[]) =>
  parts.map((p) => ("text" in p ? quote(p.text) : `counter(${p.counter})`)).join(" ");

function boxes(where: "top" | "bottom", text: string, ctx: PrintContext): string {
  const sections = parseCodes(text, ctx);
  return (["left", "center", "right"] as const)
    .filter((a) => sections[a].length)
    .map((a) => `@${where}-${a} { content: ${content(sections[a])}; font: 9pt system-ui, sans-serif; color: #444; }`)
    .join("\n  ");
}

/** The stylesheet text for one print job. Values are clamped, so a bad setting cannot break the CSS. */
export function printCss(s: PrintSetup, ctx: PrintContext): string {
  const margin = Number.isFinite(s.marginMm) ? Math.min(50, Math.max(0, Math.round(s.marginMm))) : 20;
  const rules = [`size: ${s.landscape ? "landscape" : "portrait"};`, `margin: ${margin}mm;`];
  const top = boxes("top", s.header, ctx);
  const bottom = boxes("bottom", s.footer, ctx);
  if (top) rules.push(top);
  if (bottom) rules.push(bottom);
  return `@page {\n  ${rules.join("\n  ")}\n}`;
}

/** Find / Replace panel. Lazy-loaded on first Ctrl+F / Ctrl+H. */
import {
  SearchQuery,
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { installLazy } from "./editor";

// CodeMirror's own panel is replaced by ours; the extension is only used for its commands.
const searchExt = search({ createPanel: () => ({ dom: document.createElement("div") }) });

let panel: HTMLElement | null = null;

const OPTIONS = [
  ["case", "Match case"],
  ["word", "Whole word"],
  ["regex", "Regex"],
  ["wrap", "Wrap around"],
] as const;

export function openFind(view: EditorView, withReplace: boolean): void {
  if (!panel) panel = build(view);
  const host = view.dom.parentElement!;
  if (panel.parentElement !== host) host.append(panel);
  panel.classList.toggle("replace", withReplace);
  const find = panel.querySelector<HTMLInputElement>(".f-find")!;
  const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
  if (sel && !sel.includes("\n")) find.value = sel;
  find.focus();
  find.select();
}

function build(view: EditorView): HTMLElement {
  const el = document.createElement("div");
  el.className = "find";
  el.setAttribute("role", "dialog");
  el.innerHTML = `
    <div class="row">
      <input type="text" class="f-find" placeholder="Find" spellcheck="false">
      <button class="prev" title="Previous (Shift+Enter)">↑</button>
      <button class="next" title="Next (Enter)">↓</button>
      <button class="x" title="Close (Esc)">×</button>
    </div>
    <div class="row rep">
      <input type="text" class="f-rep" placeholder="Replace" spellcheck="false">
      <button class="r1">Replace</button>
      <button class="rall">All</button>
    </div>
    <div class="row opts">
      ${OPTIONS.map(([k, l]) => `<label><input type="checkbox" data-o="${k}"${k === "wrap" ? " checked" : ""}> ${l}</label>`).join("")}
      <span class="fmsg"></span>
    </div>`;
  const $ = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const find = $<HTMLInputElement>(".f-find");
  const rep = $<HTMLInputElement>(".f-rep");
  const note = $(".fmsg");
  const opt = (k: string) => el.querySelector<HTMLInputElement>(`[data-o=${k}]`)!.checked;
  const say = (t: string) => (note.textContent = t);

  const query = (): SearchQuery | null => {
    say("");
    if (!find.value) return null;
    const q = new SearchQuery({
      search: find.value,
      replace: rep.value,
      caseSensitive: opt("case"),
      wholeWord: opt("word"),
      regexp: opt("regex"),
    });
    if (!q.valid) {
      say("Invalid regex");
      return null;
    }
    installLazy(view, searchExt); // active tab may predate the extension
    view.dispatch({ effects: setSearchQuery.of(q) });
    return q;
  };

  const exists = (q: SearchQuery, from: number, to: number) =>
    !q.getCursor(view.state, from, to).next().done;

  const go = (dir: 1 | -1) => {
    const q = query();
    if (!q) return;
    const { from, to } = view.state.selection.main;
    if (!opt("wrap") && !(dir > 0 ? exists(q, to, view.state.doc.length) : exists(q, 0, from))) {
      say(exists(q, 0, view.state.doc.length) ? "End reached" : "No matches");
      return;
    }
    if (!(dir > 0 ? findNext(view) : findPrevious(view))) say("No matches");
  };

  const count = (q: SearchQuery) => {
    let n = 0;
    const c = q.getCursor(view.state);
    while (!c.next().done) n++;
    return n;
  };

  $(".next").onclick = () => go(1);
  $(".prev").onclick = () => go(-1);
  $(".r1").onclick = () => {
    const q = query();
    if (!q) return;
    if (!replaceNext(view)) say("No matches");
  };
  $(".rall").onclick = () => {
    const q = query();
    if (!q) return;
    const n = count(q);
    replaceAll(view);
    say(`Replaced ${n}`);
  };
  const close = () => {
    el.remove();
    view.focus();
  };
  $(".x").onclick = close;
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      if (e.target === rep && el.classList.contains("replace")) $(".r1").click();
      else go(e.shiftKey ? -1 : 1);
    }
  });
  return el;
}

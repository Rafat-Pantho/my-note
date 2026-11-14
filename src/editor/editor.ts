import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  type ViewUpdate,
  drawSelection,
  highlightActiveLine,
  keymap,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  insertTab,
} from "@codemirror/commands";
import { theme } from "../theme/theme";

const wrapComp = new Compartment();
const tabComp = new Compartment();
/** Holds extensions that are lazy-loaded (search). Empty until the find chunk loads. */
const lazyComp = new Compartment();
let lazyExt: Extension = [];
/** Current user prefs, so states created later (new tabs) start with them. */
let tabSize = 8;
let baseFont = 14;
let onUpdate: (u: ViewUpdate) => void = () => {};

const wrapExt = (wrap: boolean): Extension => (wrap ? EditorView.lineWrapping : []);

/** One handler for every state; the app sets it once. */
export function setUpdateHandler(fn: (u: ViewUpdate) => void): void {
  onUpdate = fn;
}

/** Each tab owns an EditorState (so undo history is per tab). Text uses `\n`. */
export function makeState(doc: string, wrap: boolean): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      drawSelection(),
      highlightActiveLine(),
      wrapComp.of(wrapExt(wrap)),
      lazyComp.of(lazyExt),
      tabComp.of(EditorState.tabSize.of(tabSize)),
      keymap.of([
        { key: "Tab", run: insertTab },
        { key: "Shift-Tab", run: indentLess },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => onUpdate(u)),
      theme,
    ],
  });
}

export function createEditor(parent: HTMLElement): EditorView {
  return new EditorView({ parent, state: makeState("", true) });
}

const prefEffects = (wrap: boolean, tab: number) => [
  wrapComp.reconfigure(wrapExt(wrap)),
  tabComp.reconfigure(EditorState.tabSize.of(tab)),
];

/** Same prefs for a tab that is not on screen. */
export function withPrefs(state: EditorState, wrap: boolean, tab: number): EditorState {
  return state.update({ effects: prefEffects(wrap, tab) }).state;
}

/** Word wrap and tab size for the live view and every state created from now on. */
export function setPrefs(view: EditorView, wrap: boolean, tab: number): void {
  tabSize = tab;
  view.dispatch({ effects: prefEffects(wrap, tab) });
}

/** Font settings: size in px at 100% zoom, and the user's font-family list ("" = built-in stack). */
export function setFont(view: EditorView, size: number, family: string, zoom: number): void {
  baseFont = size;
  const root = document.documentElement.style;
  if (family) root.setProperty("--mono-user", `${family}, var(--mono-font)`);
  else root.removeProperty("--mono-user");
  applyZoom(view, zoom);
}

/** Called by lazy chunks to add an extension to the current and all future states. */
export function installLazy(view: EditorView, ext: Extension): void {
  lazyExt = ext;
  view.dispatch({ effects: lazyComp.reconfigure(ext) });
}

export function applyZoom(view: EditorView, percent: number): void {
  document.documentElement.style.setProperty("--editor-font", `${(baseFont * percent) / 100}px`);
  view.requestMeasure();
}

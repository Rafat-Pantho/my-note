import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  type ViewUpdate,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
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
import { EXTRA_CONTROL_CHARS, controlLabel } from "./controlchars";

const wrapComp = new Compartment();
const tabComp = new Compartment();
const ctrlComp = new Compartment();
const dirComp = new Compartment();
/** Holds extensions that are lazy-loaded (search). Empty until the find chunk loads. */
const lazyComp = new Compartment();
let lazyExt: Extension = [];
/** Current user prefs, so states created later (new tabs) start with them. */
let tabSize = 8;
let showCtrl = false;
let baseFont = 14;
let onUpdate: (u: ViewUpdate) => void = () => {};

const wrapExt = (wrap: boolean): Extension => (wrap ? EditorView.lineWrapping : []);

/** Zero-width joiners, bidi marks and other control characters, drawn as small labelled boxes. */
const ctrlExt = (on: boolean): Extension =>
  on
    ? highlightSpecialChars({
        addSpecialChars: EXTRA_CONTROL_CHARS,
        render(code, description) {
          const el = document.createElement("span");
          el.className = "cm-ctrl";
          el.textContent = controlLabel(code);
          el.title = description ?? "";
          return el;
        },
      })
    : [];

const dirExt = (rtl: boolean): Extension => (rtl ? EditorView.contentAttributes.of({ dir: "rtl" }) : []);

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
      ctrlComp.of(ctrlExt(showCtrl)),
      dirComp.of([]),
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

const prefEffects = (wrap: boolean, tab: number, ctrl: boolean) => [
  wrapComp.reconfigure(wrapExt(wrap)),
  tabComp.reconfigure(EditorState.tabSize.of(tab)),
  ctrlComp.reconfigure(ctrlExt(ctrl)),
];

/** Same prefs for a tab that is not on screen. */
export function withPrefs(state: EditorState, wrap: boolean, tab: number, ctrl: boolean): EditorState {
  return state.update({ effects: prefEffects(wrap, tab, ctrl) }).state;
}

/** Word wrap and tab size for the live view and every state created from now on. */
export function setPrefs(view: EditorView, wrap: boolean, tab: number, ctrl: boolean): void {
  tabSize = tab;
  showCtrl = ctrl;
  view.dispatch({ effects: prefEffects(wrap, tab, ctrl) });
}

/** Reading order of one tab (it lives in that tab's state). */
export function setDirection(view: EditorView, rtl: boolean): void {
  view.dispatch({ effects: dirComp.reconfigure(dirExt(rtl)) });
}

export function withDirection(state: EditorState, rtl: boolean): EditorState {
  return state.update({ effects: dirComp.reconfigure(dirExt(rtl)) }).state;
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

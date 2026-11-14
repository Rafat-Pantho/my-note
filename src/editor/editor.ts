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
/** Holds extensions that are lazy-loaded (search). Empty until the find chunk loads. */
const lazyComp = new Compartment();
let lazyExt: Extension = [];
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
      EditorState.tabSize.of(8),
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

export function withWrap(state: EditorState, wrap: boolean): EditorState {
  return state.update({ effects: wrapComp.reconfigure(wrapExt(wrap)) }).state;
}

export function setWrap(view: EditorView, wrap: boolean): void {
  view.dispatch({ effects: wrapComp.reconfigure(wrapExt(wrap)) });
}

/** Called by lazy chunks to add an extension to the current and all future states. */
export function installLazy(view: EditorView, ext: Extension): void {
  lazyExt = ext;
  view.dispatch({ effects: lazyComp.reconfigure(ext) });
}

export function applyZoom(view: EditorView, percent: number): void {
  document.documentElement.style.setProperty("--editor-font", `${(14 * percent) / 100}px`);
  view.requestMeasure();
}

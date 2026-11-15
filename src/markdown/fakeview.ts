/** A stand-in for EditorView in Node tests (there is no DOM): real editor state, real transactions. Only used by
 *  the tests of the commands, which touch nothing but `state`, `dispatch` and `focus`. */
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** `doc` with the caret where the first `|` is (that character is removed), or, when `selection` is given, exactly
 *  `doc` with that selection. */
export function fakeView(doc: string, selection?: { anchor: number; head?: number }): EditorView {
  const at = doc.indexOf("|");
  const text = selection || at < 0 ? doc : doc.replace("|", "");
  const sel = selection ?? { anchor: at < 0 ? 0 : at };
  const v = {
    state: EditorState.create({ doc: text, selection: sel }),
    dispatch(spec: unknown) {
      v.state = v.state.update(spec as never).state;
    },
    focus() {},
  };
  return v as unknown as EditorView;
}

/** The document with the caret shown as `|` (a selection as `[...]`). */
export function show(v: EditorView): string {
  const { from, to, empty } = v.state.selection.main;
  const t = v.state.doc.toString();
  return empty ? t.slice(0, from) + "|" + t.slice(from) : t.slice(0, from) + "[" + t.slice(from, to) + "]" + t.slice(to);
}

import { EditorView } from "@codemirror/view";

/** Editor theme. Everything is a CSS variable, so light/dark switches without touching the editor state.
 *  The editor itself is transparent: the #editor container paints the (possibly translucent) background. */
export const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--fg)" },
  ".cm-scroller": {
    fontFamily: "var(--mono-user, var(--mono-font))",
    fontSize: "var(--editor-font)",
    lineHeight: "1.5",
  },
  ".cm-content": { caretColor: "var(--caret)", padding: "8px 0" },
  ".cm-cursor": { borderLeftColor: "var(--caret)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    { backgroundColor: "var(--selection)" },
});

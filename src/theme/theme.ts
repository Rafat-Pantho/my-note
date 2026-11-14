import { EditorView } from "@codemirror/view";

/** Dark theme. Colors mirror the CSS variables and the window backgroundColor in tauri.conf.json. */
export const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--fg)" },
    ".cm-scroller": {
      fontFamily: "Consolas, 'Cascadia Mono', monospace",
      fontSize: "var(--editor-font)",
      lineHeight: "1.5",
    },
    ".cm-content": { caretColor: "var(--caret)", padding: "8px 0" },
    ".cm-cursor": { borderLeftColor: "var(--caret)" },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
      { backgroundColor: "var(--selection)" },
  },
  { dark: true },
);


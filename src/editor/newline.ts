import { insertNewlineAndIndent } from "@codemirror/commands";
import { Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** What Enter does when something else (autocorrect) has to type the newline itself. Markdown mode supplies one
 *  that continues lists and tables, so a typo fixed by Enter in a list item still gets the next bullet. */
export const newlineCommand = Facet.define<(view: EditorView) => boolean, (view: EditorView) => boolean>({
  combine: (all) => all[0] ?? insertNewlineAndIndent,
});

/** Right-click menu for the editor: the usual Notepad items plus whatever extra entries the app adds (AI).
 *  The webview's own menu cannot be extended, so this replaces it inside the text area. */
import { redo, selectAll, undo, undoDepth } from "@codemirror/commands";
import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";

export interface ContextItem {
  label: string;
  /** Shortcut shown on the right. */
  hint?: string;
  run?: () => void;
  disabled?: boolean;
  /** A divider (no label needed). */
  sep?: boolean;
  /** Drawn bold: the spelling suggestions. */
  strong?: boolean;
}

export const hasSelection = (view: EditorView) => !view.state.selection.ranges.every((r) => r.empty);

/** The Edit commands shared by the right-click menu and the Edit menu. `flash` shows a short message. */
export function editorCommands(view: EditorView, flash: (text: string) => void) {
  const clip = (command: "cut" | "copy") => () => {
    view.focus();
    document.execCommand(command); // CodeMirror handles the cut/copy event itself
  };
  return {
    undo: () => { undo(view); view.focus(); },
    redo: () => { redo(view); view.focus(); },
    cut: clip("cut"),
    copy: clip("copy"),
    paste: () => {
      view.focus();
      // The webview cannot read the clipboard without a permission prompt that never resolves, so Rust does.
      invoke<string>("clipboard_read").then(
        (text) => {
          if (text) view.dispatch({ ...view.state.replaceSelection(text), scrollIntoView: true, userEvent: "input.paste" });
          else flash("The clipboard has no text.");
        },
        (e) => flash(String(e) === "unsupported" ? "Press Ctrl+V to paste." : String(e)),
      );
    },
    del: () => {
      view.dispatch({ ...view.state.replaceSelection(""), userEvent: "delete.selection" });
      view.focus();
    },
    selectAll: () => { selectAll(view); view.focus(); },
  };
}

/** Puts plain text on the clipboard (a click is the user action it needs). False if the webview refused. */
export function copyText(text: string): boolean {
  const box = document.createElement("textarea");
  box.value = text;
  box.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.append(box);
  box.select();
  const ok = document.execCommand("copy");
  box.remove();
  return ok;
}

/** Cut / Copy / Paste / Delete / Select all for `view`, in Notepad's order. */
export function editorItems(view: EditorView, flash: (text: string) => void): ContextItem[] {
  const hasSel = hasSelection(view);
  const c = editorCommands(view, flash);
  return [
    { label: "Undo", hint: "Ctrl+Z", disabled: undoDepth(view.state) === 0, run: c.undo },
    { label: "", sep: true },
    { label: "Cut", hint: "Ctrl+X", disabled: !hasSel, run: c.cut },
    { label: "Copy", hint: "Ctrl+C", disabled: !hasSel, run: c.copy },
    { label: "Paste", hint: "Ctrl+V", run: c.paste },
    { label: "Delete", hint: "Del", disabled: !hasSel, run: c.del },
    { label: "", sep: true },
    { label: "Select all", hint: "Ctrl+A", run: c.selectAll },
  ];
}

/** Opens the menu at a point. Closes on pick, outside click, Escape or window blur. */
export function showContextMenu(x: number, y: number, items: ContextItem[], onClose: () => void): void {
  document.querySelector(".menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "menu ctx";
  menu.setAttribute("role", "menu");
  for (const it of items) {
    if (it.sep) {
      const d = document.createElement("div");
      d.className = "sep";
      menu.append(d);
      continue;
    }
    const b = document.createElement("button");
    b.append(it.label);
    if (it.strong) b.classList.add("strong");
    if (it.hint) {
      const k = document.createElement("span");
      k.className = "hint";
      k.textContent = it.hint;
      b.append(k);
    }
    b.disabled = !!it.disabled;
    b.onclick = () => {
      close(false);
      it.run?.();
    };
    menu.append(b);
  }
  const close = (refocus: boolean) => {
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
    if (refocus) onClose();
  };
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Node)) close(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close(true);
    }
  };
  const onBlur = () => close(false);
  document.body.append(menu);
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
}

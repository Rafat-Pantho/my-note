import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { createEditor } from "./editor/editor";

const view = createEditor(document.getElementById("editor")!);
view.focus();
void invoke("editor_ready");

// Show the window only after the first frame has been painted.
requestAnimationFrame(() => requestAnimationFrame(() => void invoke("show_window")));

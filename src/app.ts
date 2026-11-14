import { listen } from "@tauri-apps/api/event";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { applyZoom, createEditor, makeState, setUpdateHandler, setWrap, withWrap } from "./editor/editor";
import { modal } from "./editor/dialog";
import { createStatusBar } from "./editor/statusbar";
import {
  editorReady, exitApp, loadSession, pickOpenFiles, pickSavePath, readFile, saveSession,
  setTitle, showWindow, takeLaunchArgs, writeFile,
} from "./tabs/ipc";
import { buildSession, parseSession, type Prefs } from "./tabs/session";
import { type Tab, TabBar } from "./tabs/tabs";
import { loadAppearance } from "./theme/appearance";
import { createViewMenu } from "./theme/viewmenu";

const APP = "My Note";
const SESSION_DELAY_MS = 1500;
const LARGE_FILE_MB = 1;

let view!: EditorView;
let tabs: Tab[] = [];
let active!: Tab;
let nextId = 1;
let activateToken = 0;
let prefs: Prefs = { wrap: true, zoom: 100 };

const bar = new TabBar(document.getElementById("tabs")!, {
  select: (t) => void activate(t),
  close: (t) => void closeTab(t),
  reorder(ids) {
    tabs = ids.map((id) => tabs.find((t) => t.id === id)!);
    scheduleSession();
  },
});
const status = createStatusBar(document.getElementById("statusbar")!, {
  toggleWrap,
  resetZoom: () => setZoom(100),
  setEncoding(v) {
    active.encoding = v;
    status.set({ encoding: v });
    markDirty();
  },
  setLineEnding(v) {
    active.lineEnding = v;
    status.set({ lineEnding: v });
    markDirty();
  },
});

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase(); // Windows paths
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r)));
const isBlank = (t: Tab) => !t.path && !t.dirty && !!t.state && t.state.doc.length === 0;

function makeTab(init: Partial<Tab> & { text?: string }): Tab {
  const { text, ...rest } = init;
  return {
    id: nextId++,
    path: null,
    name: "Untitled",
    state: text === undefined ? null : makeState(text, prefs.wrap),
    dirty: false,
    encoding: "utf-8",
    lineEnding: "crlf",
    ...rest,
  };
}

/* ---------- UI refresh ---------- */

function refreshTabs() {
  bar.render(tabs, active);
}

let lastTitle = "";
function refreshTitle() {
  const title = `${active.dirty ? "*" : ""}${active.name} - ${APP}`;
  if (title === lastTitle) return;
  lastTitle = title;
  document.title = title;
  void setTitle(title);
}

function refreshCursor() {
  const s = view.state;
  const head = s.selection.main.head;
  const line = s.doc.lineAt(head);
  let selected = 0;
  for (const r of s.selection.ranges) selected += r.to - r.from;
  status.set({ line: line.number, col: head - line.from + 1, selected });
}

function refreshAll() {
  refreshTabs();
  refreshTitle();
  refreshCursor();
  status.set({ zoom: prefs.zoom, wrap: prefs.wrap, encoding: active.encoding, lineEnding: active.lineEnding });
}

function markDirty() {
  if (!active.dirty) active.dirty = true;
  refreshTabs();
  refreshTitle();
  scheduleSession();
}

function onUpdate(u: ViewUpdate) {
  if (!active) return;
  active.state = u.state;
  if (u.docChanged) {
    if (!active.dirty) markDirty();
    else scheduleSession();
  }
  if (u.docChanged || u.selectionSet) refreshCursor();
}

/* ---------- tabs ---------- */

async function activate(tab: Tab): Promise<void> {
  const token = ++activateToken;
  if (active?.state && active !== tab) active.state = view.state;
  if (!tab.state) {
    const ok = await loadFromDisk(tab);
    if (!ok) {
      tabs = tabs.filter((t) => t !== tab);
      if (!tabs.length) tabs.push(makeTab({ text: "" }));
      return activate(tabs[0]);
    }
    if (token !== activateToken) return;
  }
  active = tab;
  view.setState(tab.state!);
  refreshAll();
  view.focus();
  scheduleSession();
}

function newTab() {
  const t = makeTab({ text: "" });
  tabs.push(t);
  void activate(t);
}

async function closeTab(tab: Tab): Promise<boolean> {
  if (tab.dirty && !(await resolveUnsaved(tab))) return false;
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  if (!tabs.length) tabs.push(makeTab({ text: "" }));
  if (tab === active || !tabs.includes(active)) await activate(tabs[Math.min(i, tabs.length - 1)]);
  else {
    refreshTabs();
    scheduleSession();
  }
  return true;
}

/** Save / Don't save / Cancel. Returns false if the user cancelled (or the save did). */
async function resolveUnsaved(tab: Tab): Promise<boolean> {
  if (tab !== active) await activate(tab);
  const r = await modal({
    message: `Do you want to save changes to ${tab.name}?`,
    buttons: ["Save", "Don't save", "Cancel"],
  });
  if (r.button === "Save") return saveTab(tab, false);
  return r.button === "Don't save";
}

function switchTab(delta: number) {
  if (tabs.length < 2) return;
  void activate(tabs[(tabs.indexOf(active) + delta + tabs.length) % tabs.length]);
}

/* ---------- files ---------- */

async function loadFromDisk(tab: Tab): Promise<boolean> {
  const t = await readIntoTab(tab.path!);
  if (!t) return false;
  tab.state = t.state;
  tab.encoding = t.encoding;
  tab.lineEnding = t.lineEnding;
  return true;
}

/** Reads a file into a fresh tab (not yet in `tabs`). Shows errors; null on failure/cancel. */
async function readIntoTab(path: string): Promise<Tab | null> {
  const name = basename(path);
  let allowLarge = false;
  for (;;) {
    try {
      status.message(`Opening ${name}...`);
      const f = await readFile(path, allowLarge);
      if (f.size > LARGE_FILE_MB * 1024 * 1024) await nextFrame(); // let the message paint
      const tab = makeTab({ path, name, text: f.text, encoding: f.encoding, lineEnding: f.lineEnding });
      status.message("");
      return tab;
    } catch (e) {
      status.message("");
      const msg = String(e);
      if (msg.startsWith("large:") && !allowLarge) {
        const mb = Math.round(Number(msg.slice(6)) / 1048576);
        const r = await modal({
          message: `${name} is ${mb} MB. Large files can be slow to open and edit. Open it anyway?`,
          buttons: ["Open anyway", "Cancel"],
        });
        if (r.button !== "Open anyway") return null;
        allowLarge = true;
        continue;
      }
      await modal({ message: `Cannot open ${path}\n${msg}`, buttons: ["OK"] });
      return null;
    }
  }
}

async function openPaths(paths: string[]) {
  let last: Tab | undefined;
  for (const p of paths) {
    const existing = tabs.find((t) => t.path && samePath(t.path, p));
    if (existing) {
      last = existing;
      continue;
    }
    const tab = await readIntoTab(p);
    if (!tab) continue;
    if (tabs.length === 1 && isBlank(tabs[0])) tabs = [];
    tabs.push(tab);
    last = tab;
  }
  if (last) await activate(last);
}

async function openDialog() {
  const paths = await pickOpenFiles();
  if (paths.length) await openPaths(paths);
}

async function saveTab(tab: Tab, saveAs: boolean): Promise<boolean> {
  if (!tab.state) await loadFromDisk(tab);
  let path = tab.path;
  if (!path || saveAs) {
    path = await pickSavePath(tab.path ? basename(tab.path) : "Untitled.txt");
    if (!path) return false;
  }
  const state = tab === active ? view.state : tab.state!;
  try {
    await writeFile(path, state.doc.toString(), tab.encoding, tab.lineEnding);
  } catch (e) {
    await modal({ message: `Cannot save ${path}\n${String(e)}`, buttons: ["OK"] });
    return false;
  }
  tab.path = path;
  tab.name = basename(path);
  tab.dirty = false;
  refreshTabs();
  refreshTitle();
  scheduleSession();
  return true;
}

/* ---------- session ---------- */

let sessionTimer = 0;
function scheduleSession() {
  clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(() => {
    // Idle callback so serializing never competes with typing.
    requestIdleCallback(() => void persistSession(), { timeout: 3000 });
  }, SESSION_DELAY_MS);
}

function persistSession() {
  clearTimeout(sessionTimer);
  if (active?.state) active.state = view.state;
  return saveSession(buildSession(tabs, active, prefs)).catch(() => {});
}

async function restoreSession() {
  const s = parseSession(await loadSession());
  if (!s) return;
  prefs = s.prefs;
  tabs = s.tabs.map((t) =>
    makeTab({
      path: t.path,
      name: t.name,
      encoding: t.encoding,
      lineEnding: t.lineEnding,
      dirty: t.dirty,
      text: t.text,
    }),
  );
  // Tabs without text are file-backed and load on first activation.
  active = tabs[Math.min(s.active, tabs.length - 1)];
}

/* ---------- app close ---------- */

async function closeApp() {
  for (const tab of tabs.filter((t) => t.dirty)) {
    if (!(await resolveUnsaved(tab))) return;
    tab.dirty = false;
    if (!tab.path) tab.discarded = true; // only reached by "Don't save"
  }
  await persistSession();
  await exitApp();
}

/* ---------- view commands ---------- */

function toggleWrap() {
  prefs.wrap = !prefs.wrap;
  setWrap(view, prefs.wrap);
  for (const t of tabs) if (t !== active && t.state) t.state = withWrap(t.state, prefs.wrap);
  status.set({ wrap: prefs.wrap });
  scheduleSession();
}

function setZoom(percent: number) {
  prefs.zoom = Math.min(500, Math.max(10, percent));
  applyZoom(view, prefs.zoom);
  status.set({ zoom: prefs.zoom });
  scheduleSession();
}

async function gotoLine() {
  const doc = view.state.doc;
  const cur = doc.lineAt(view.state.selection.main.head).number;
  const r = await modal({ message: `Go to line (1-${doc.lines}):`, input: String(cur), buttons: ["Go to", "Cancel"] });
  const n = parseInt(r.value, 10);
  if (r.button === "Go to" && Number.isFinite(n)) {
    const line = doc.line(Math.min(doc.lines, Math.max(1, n)));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
  }
  view.focus();
}

function insertDateTime() {
  const d = new Date();
  const text = `${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ${d.toLocaleDateString()}`;
  view.dispatch({ ...view.state.replaceSelection(text), scrollIntoView: true, userEvent: "input" });
}

async function openFind(replace: boolean) {
  const m = await import("./editor/find");
  m.openFind(view, replace);
}

function print() {
  const el = document.getElementById("print")!;
  el.textContent = view.state.doc.toString();
  window.addEventListener("afterprint", () => (el.textContent = ""), { once: true });
  window.print();
}

/* ---------- input ---------- */

function onKeyDown(e: KeyboardEvent) {
  if (document.querySelector(".modal-bg")) return;
  const key = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  const run = (fn: () => void) => {
    e.preventDefault();
    fn();
  };
  if (e.key === "F5" && !ctrl) return run(insertDateTime);
  if (e.altKey && !ctrl && key === "z") return run(toggleWrap);
  if (!ctrl || e.altKey) return;
  switch (key) {
    case "n":
    case "t": return run(newTab);
    case "w": return run(() => void closeTab(active));
    case "o": return run(() => void openDialog());
    case "s": return run(() => void saveTab(active, e.shiftKey));
    case "f": return run(() => void openFind(false));
    case "h": return run(() => void openFind(true));
    case "g": return run(() => void gotoLine());
    case "p": return run(print);
    case "tab": return run(() => switchTab(e.shiftKey ? -1 : 1));
    case "pagedown": return run(() => switchTab(1));
    case "pageup": return run(() => switchTab(-1));
    case "+":
    case "=":
    case "add": return run(() => setZoom(prefs.zoom + 10));
    case "-":
    case "subtract": return run(() => setZoom(prefs.zoom - 10));
    case "0": return run(() => setZoom(100));
  }
}

/* ---------- boot ---------- */

export async function boot() {
  view = createEditor(document.getElementById("editor")!);
  setUpdateHandler(onUpdate);
  const [, args] = await Promise.all([restoreSession(), takeLaunchArgs(), loadAppearance()]);
  if (!tabs.length) {
    tabs.push(makeTab({ text: "" }));
    active = tabs[0];
  }
  applyZoom(view, prefs.zoom);
  await activate(active);
  if (args.length) await openPaths(args);

  window.addEventListener("keydown", onKeyDown, true);
  document.getElementById("newtab")!.onclick = newTab;
  createViewMenu(document.getElementById("viewmenu")!); // temporary, M3 removes
  document.getElementById("editor")!.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(prefs.zoom + (e.deltaY < 0 ? 10 : -10));
    },
    { passive: false },
  );
  window.addEventListener("contextmenu", (e) => {
    if (!(e.target as HTMLElement).closest(".cm-content, input")) e.preventDefault();
  });

  void editorReady();
  // Show the window only after the first frame has been painted.
  requestAnimationFrame(() => requestAnimationFrame(() => void showWindow()));

  void listen<{ paths: string[] }>("tauri://drag-drop", (e) => void openPaths(e.payload.paths));
  void listen("close-requested", () => void closeApp());
}

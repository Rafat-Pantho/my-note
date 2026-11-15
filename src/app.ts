import { listen } from "@tauri-apps/api/event";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { applyZoom, createEditor, makeState, setFont, setPrefs, setUpdateHandler, withPrefs } from "./editor/editor";
import type { AiController } from "./ai/controller";
import { editorItems, showContextMenu } from "./editor/contextmenu";
import { modal } from "./editor/dialog";
import { createStatusBar } from "./editor/statusbar";
import {
  decodeSession, editorReady, exitApp, isSessionLarge, loadSessionBytes, pickOpenFiles, pickSavePath, readFile, saveSession,
  setTitle, showWindow, takeLaunchArgs, writeFile,
} from "./tabs/ipc";
import { buildSession, parseSession, type Prefs, type Session } from "./tabs/session";
import type { SettingsPanel } from "./settings/panel";
import { type Tab, TabBar } from "./tabs/tabs";
import { type Appearance, appearance, loadAppearance, onAppearance, setAppearance } from "./theme/appearance";

const APP = "My Note";
const SESSION_DELAY_MS = 1500;
const LARGE_FILE_MB = 1;

let view!: EditorView;
let tabs: Tab[] = [];
let active!: Tab;
let nextId = 1;
/** True while a large session file is still being read after the first paint. */
let restoring = false;
let restoreDone: Promise<void> = Promise.resolve();
let zoomTouched = false;
let activateToken = 0;
let prefs: Prefs = { wrap: true, zoom: 100 };
/** Last real document tab, so the saved session still knows the active file while Settings is shown. */
let lastDoc: Tab | undefined;
let settingsTab: Tab | null = null;
let settingsPanel: SettingsPanel | null = null;
/** The AI actions controller. Its code is a lazy chunk: null until the user first opens the AI menu. */
let aiCtl: AiController | null = null;
// What the editor currently uses, to apply only real changes (a slider fires many updates).
let appliedTab = 8;
let appliedSize = 14;
let appliedFamily = "";

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
  openAi: () => void openSettings("ai"),
});

status.setAi({ enabled: false, env: null }); // until settings arrive from Rust

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase(); // Windows paths
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r)));
const isBlank = (t: Tab) => !t.path && !t.dirty && !!t.state && t.state.doc.length === 0;

function makeTab(init: Partial<Tab> & { text?: string }): Tab {
  const { text, ...rest } = init;
  const d = appearance()?.settings; // defaults for new files; opened files override via `rest`
  return {
    id: nextId++,
    path: null,
    name: "Untitled",
    state: text === undefined ? null : makeState(text, prefs.wrap),
    dirty: false,
    encoding: d?.defaultEncoding ?? "utf-8",
    lineEnding: d?.defaultLineEnding ?? "crlf",
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
  aiCtl?.onUpdate(u);
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
  if (!tab.state && tab.kind !== "settings") {
    const ok = await loadFromDisk(tab);
    if (!ok) {
      tabs = tabs.filter((t) => t !== tab);
      if (!tabs.length) tabs.push(makeTab({ text: "" }));
      return activate(tabs[0]);
    }
    if (token !== activateToken) return;
  }
  active = tab;
  const isSettings = tab.kind === "settings";
  if (!isSettings) {
    lastDoc = tab;
    view.setState(tab.state!);
  }
  aiCtl?.onTabChange(tab);
  document.getElementById("app")!.classList.toggle("on-settings", isSettings);
  document.getElementById("settings")!.hidden = !isSettings;
  refreshAll();
  if (!isSettings) view.focus();
  scheduleSession();
}

/** One Settings tab. Its code is a lazy chunk, fetched the first time it is opened. */
async function openSettings(section?: string) {
  if (!settingsTab || !tabs.includes(settingsTab)) {
    const { mountSettings } = await import("./settings/panel");
    if (!settingsTab || !tabs.includes(settingsTab)) {
      // (a second call during the import may have created it already)
      settingsTab = makeTab({ name: "Settings", kind: "settings" });
      settingsPanel = mountSettings(document.getElementById("settings")!);
      tabs.push(settingsTab);
    }
  }
  await activate(settingsTab);
  if (section) settingsPanel?.show(section);
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
  if (tab === settingsTab) {
    settingsPanel?.dispose();
    settingsPanel = null;
    settingsTab = null;
  }
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
  if (restoring) return Promise.resolve(); // the saved session has not been read yet: never overwrite it
  if (active?.state) active.state = view.state;
  const s = buildSession(tabs, active?.kind === "settings" ? lastDoc : active, prefs);
  // "Restore session" off: keep no tabs or unsaved text on disk.
  const data: Session = appearance()?.settings.restoreSession === false ? { ...s, active: 0, tabs: [] } : s;
  return saveSession(data).catch(() => {});
}

const sessionOf = (buf: ArrayBuffer): Session | null => parseSession(decodeSession(buf));

/** Tabs described by a saved session. Tabs without text are file-backed and load on first activation. */
function sessionTabs(s: Session): Tab[] {
  return s.tabs.map((t) =>
    makeTab({
      path: t.path,
      name: t.name,
      encoding: t.encoding,
      lineEnding: t.lineEnding,
      dirty: t.dirty,
      text: t.text,
    }),
  );
}

/** Needs the settings loaded first (restoreSession, word wrap come from them, not from the session file). */
function applySession(s: Session | null) {
  if (!s) return;
  prefs.zoom = s.prefs.zoom;
  if (appearance()?.settings.restoreSession === false) return;
  tabs = sessionTabs(s);
  active = tabs[Math.min(s.active, tabs.length - 1)];
}

/**
 * A session that arrived after the first paint (a big one). Nothing the user did meanwhile is lost: if the
 * placeholder tab is still untouched it is replaced, otherwise the restored tabs are put before the current ones.
 */
async function lateRestore(s: Session | null) {
  restoring = false;
  if (s && appearance()?.settings.restoreSession !== false) {
    if (!zoomTouched) {
      prefs.zoom = s.prefs.zoom;
      applyZoom(view, prefs.zoom);
      status.set({ zoom: prefs.zoom });
    }
    const restored = sessionTabs(s);
    if (restored.length) {
      if (tabs.length === 1 && isBlank(tabs[0])) {
        tabs = restored;
        await activate(restored[Math.min(s.active, restored.length - 1)]);
      } else {
        tabs = [...restored, ...tabs];
        refreshTabs();
      }
    }
  }
  scheduleSession(); // saves skipped while restoring
}

/* ---------- app close ---------- */

async function closeApp() {
  await restoreDone; // never save over a session that is still being restored
  for (const tab of tabs.filter((t) => t.dirty)) {
    if (!(await resolveUnsaved(tab))) return;
    tab.dirty = false;
    if (!tab.path) tab.discarded = true; // only reached by "Don't save"
  }
  await persistSession();
  await exitApp();
}

/* ---------- AI ---------- */

let flashTimer = 0;
function flash(text: string) {
  status.message(text);
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => status.message(""), 6000);
}

async function ai(): Promise<AiController> {
  if (!aiCtl) {
    const { createController } = await import("./ai/controller");
    aiCtl ??= createController({
      view: () => view,
      tab: () => active,
      isDocTab: () => active.kind !== "settings",
      openSettings: (section) => void openSettings(section),
      flash,
    });
  }
  return aiCtl;
}

async function openAiMenu(at?: HTMLElement | { x: number; y: number }) {
  if (active.kind === "settings") return;
  (await ai()).openMenu(at);
}

/** Replaces the webview's own right-click menu inside the text with ours (Notepad items + AI). */
function onEditorContextMenu(e: MouseEvent) {
  e.preventDefault();
  const quick = (id: "summarize" | "shorten" | "rewrite" | "grammar", label: string) => ({
    label: `AI: ${label}`,
    run: () => void ai().then((c) => c.runQuick(id)),
  });
  showContextMenu(
    e.clientX,
    e.clientY,
    [
      ...editorItems(view, flash),
      { label: "", sep: true },
      { label: "AI actions...", hint: "Ctrl+I", run: () => void openAiMenu({ x: e.clientX, y: e.clientY }) },
      quick("summarize", "Summarize"),
      quick("shorten", "Shorten"),
      quick("rewrite", "Rewrite (clearer)"),
      quick("grammar", "Fix grammar and spelling"),
    ],
    () => view.focus(),
  );
}

/* ---------- view commands ---------- */

function toggleWrap() {
  void setAppearance({ wordWrap: !prefs.wrap }); // applySettings does the rest, also for the Settings panel
}

/** Live-applies editor settings (wrap, tab size, font) to the view and every open tab. */
function applySettings({ settings: s, ai }: Appearance) {
  status.setAi(ai);
  if (s.wordWrap !== prefs.wrap || s.tabSize !== appliedTab) {
    prefs.wrap = s.wordWrap;
    appliedTab = s.tabSize;
    setPrefs(view, s.wordWrap, s.tabSize);
    for (const t of tabs) if (t !== active && t.state) t.state = withPrefs(t.state, s.wordWrap, s.tabSize);
    status.set({ wrap: s.wordWrap });
    scheduleSession();
  }
  if (s.fontSize !== appliedSize || s.fontFamily !== appliedFamily) {
    appliedSize = s.fontSize;
    appliedFamily = s.fontFamily;
    setFont(view, s.fontSize, s.fontFamily, prefs.zoom);
  }
}

function setZoom(percent: number) {
  zoomTouched = true;
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
  const inDoc = active?.kind !== "settings";
  const run = (fn: () => void) => {
    e.preventDefault();
    fn();
  };
  if (e.key === "F5" && !ctrl) return inDoc ? run(insertDateTime) : undefined;
  if (e.altKey && !ctrl && key === "z") return inDoc ? run(toggleWrap) : undefined;
  if (!ctrl || e.altKey) return;
  // Editing shortcuts do nothing on the Settings tab (and must not reach the webview's own handlers).
  if (!inDoc && ["s", "f", "h", "g", "p", "i", "+", "=", "add", "-", "subtract", "0"].includes(key)) return run(() => {});
  switch (key) {
    case ",": return run(() => void openSettings());
    case "i":
      e.stopPropagation(); // not CodeMirror's own Ctrl+I
      return run(() => void openAiMenu());
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
  const marks: string[] = [`boot ${Math.round(performance.now())}`];
  view = createEditor(document.getElementById("editor")!);
  setUpdateHandler(onUpdate);
  onAppearance(applySettings);
  // A normal session comes with the first request, in parallel with the settings. A big one (megabytes of
  // unsaved text) is fetched and parsed only after the first paint, so it cannot hold the page up.
  const [sessionBuf, args] = await Promise.all([
    loadSessionBytes(false).catch(() => new ArrayBuffer(0)),
    takeLaunchArgs(),
    loadAppearance(),
  ]);
  restoring = isSessionLarge(sessionBuf);
  marks.push(`ipc ${Math.round(performance.now())}${restoring ? " (session late)" : ""}`);
  if (!restoring) applySession(sessionOf(sessionBuf));
  if (!tabs.length) {
    tabs.push(makeTab({ text: "" }));
    active = tabs[0];
  }
  applyZoom(view, prefs.zoom);
  await activate(active);
  if (args.length) await openPaths(args);

  window.addEventListener("keydown", onKeyDown, true);
  document.getElementById("newtab")!.onclick = newTab;
  document.getElementById("settingsbtn")!.onclick = () => void openSettings();
  const aibtn = document.getElementById("aibtn")!;
  aibtn.onclick = () => void openAiMenu(aibtn);
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
    const target = e.target as HTMLElement;
    if (target.closest(".cm-content")) onEditorContextMenu(e);
    else if (!target.closest("input, textarea, #aipanel")) e.preventDefault();
  });

  marks.push(`active ${Math.round(performance.now())}`);
  void editorReady(marks.join(", "));
  // Show the window now: a hidden WebView2 window does not paint, so waiting for frames only delayed the show.
  // The editor DOM is built and the window background already has the theme colour.
  void showWindow();
  const shown = new Promise<void>((resolve) => setTimeout(resolve, 60)); // let the show reach Rust before heavy parsing
  if (restoring) {
    restoreDone = shown
      .then(() => loadSessionBytes(true))
      .then((buf) => lateRestore(sessionOf(buf)))
      .catch(() => lateRestore(null));
  }

  void listen<{ paths: string[] }>("tauri://drag-drop", (e) => void openPaths(e.payload.paths));
  void listen("close-requested", () => void closeApp());
}

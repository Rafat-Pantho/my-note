import { listen } from "@tauri-apps/api/event";
import { redoDepth, undoDepth } from "@codemirror/commands";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
  NO_SPELL, applyZoom, createEditor, makeState, setDirection, setFont, setPrefs, setSpell, setUpdateHandler,
  withDirection, withPrefs,
} from "./editor/editor";
import { spellKindFor } from "./editor/spelltypes";
import type { AiController } from "./ai/controller";
import { copyText, editorCommands, editorItems, hasSelection, showContextMenu } from "./editor/contextmenu";
import { modal } from "./editor/dialog";
import { createStatusBar } from "./editor/statusbar";
import {
  decodeSession, editorReady, exitApp, fileStamps, isSessionLarge, loadSessionBytes, newWindow, pickOpenFiles, pickSavePath,
  readFile, recentAdd, recentClear, recentList, saveSession, searchWeb, setTitle, showInFolder, showWindow,
  takeLaunchArgs, writeFile,
} from "./tabs/ipc";
import { ClosedTabs, closedEntry } from "./tabs/closed";
import { compare, message, promptFor } from "./tabs/external";
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
/** Spell check + autocorrect. Lazy chunk: null until a tab of an enabled file type has text. */
let spellMod: typeof import("./editor/spell") | null = null;
let spellLoading = false;
let appliedSpell = "";
// What the editor currently uses, to apply only real changes (a slider fires many updates).
let appliedTab = 8;
let appliedCtrl = false;
let appliedSize = 14;
let appliedAuto = false;
let appliedFamily = "";

const bar = new TabBar(document.getElementById("tabs")!, {
  select: (t) => void activate(t),
  close: (t) => void closeTab(t),
  reorder(ids) {
    tabs = ids.map((id) => tabs.find((t) => t.id === id)!);
    scheduleSession();
  },
  context: (t, x, y) => showTabMenu(t, x, y),
});
const closed = new ClosedTabs();
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
    scheduleAutoSave();
  }
  if (u.docChanged || u.selectionSet) refreshCursor();
  if (u.docChanged && !spellMod) void syncSpell(); // the first text in a tab that needs it loads the chunk
}

/** Makes the live view match the settings: spell check and autocorrect for the file type of this tab, or
 *  nothing. Costs nothing (no chunk, no dictionary) while both are off or the tab is empty. */
async function syncSpell(): Promise<void> {
  const tab = active;
  const s = appearance()?.settings;
  if (!tab || tab.kind === "settings" || !s) return;
  const kind = s.spellCheck || s.autocorrect ? spellKindFor(tab.path, s.spellTypes) : null;
  if (!spellMod) {
    if (!kind || spellLoading || view.state.doc.length === 0) return;
    spellLoading = true;
    try {
      spellMod = await import("./editor/spell");
      spellMod.setNotifier(flash);
    } catch {
      return;
    } finally {
      spellLoading = false;
    }
  }
  spellMod.configure({ spell: s.spellCheck, autocorrect: s.autocorrect, language: s.spellLanguage, dictDir: s.spellDictDir });
  if (active !== tab) return void syncSpell(); // the user switched tabs while the chunk loaded
  setSpell(view, kind ? spellMod.extensionFor(kind) : NO_SPELL);
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
  hideExtBar();
  void handleExternal(tab);
  document.getElementById("app")!.classList.toggle("on-settings", isSettings);
  document.getElementById("settings")!.hidden = !isSettings;
  refreshAll();
  if (!isSettings) view.focus();
  void syncSpell();
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
  if (i < 0) return true; // already gone (closed twice in a row)
  const entry = closedEntry(tab, tab.path ? undefined : tab.state?.doc.toString());
  if (entry) closed.push(entry);
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
  tab.stamp = t.stamp;
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
      tab.stamp = (await fileStamps([path]).catch(() => [null]))[0] ?? undefined;
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
    void recentAdd(p).catch(() => {});
    if (tabs.length === 1 && isBlank(tabs[0])) tabs = [];
    tabs.push(tab);
    last = tab;
  }
  if (last) await activate(last);
}

/** File > Open and Recent: a new tab, or a new window when that setting is on (an empty window just takes it). */
async function openFiles(paths: string[]) {
  if (!paths.length) return;
  if (appearance()?.settings.openInNewWindow && !(tabs.length === 1 && isBlank(tabs[0]))) {
    for (const p of paths) void recentAdd(p).catch(() => {});
    try {
      await newWindow(paths);
      return;
    } catch (e) {
      flash(String(e)); // could not start one: open it here instead
    }
  }
  await openPaths(paths);
}

async function openDialog() {
  await openFiles(await pickOpenFiles());
}

async function saveAll() {
  for (const t of tabs.filter((x) => x.dirty && x.kind !== "settings")) {
    if (!(await saveTab(t, false))) return; // cancelled or failed: stop here
  }
}

/** Ctrl+Shift+T: the most recently closed tab (last 10). A file that is open again is skipped. */
async function reopenClosed() {
  const e = closed.pop((p) => tabs.some((t) => t.path && samePath(t.path, p)));
  if (!e) return flash("No closed tab to reopen.");
  if (e.path) return openPaths([e.path]);
  const t = makeTab({ text: e.text ?? "", encoding: e.encoding, lineEnding: e.lineEnding, name: e.name, dirty: true });
  if (tabs.length === 1 && isBlank(tabs[0])) tabs = [];
  tabs.push(t);
  await activate(t);
}

/* ---------- tab context menu ---------- */

/** Closes `list` one by one; stops if the user cancels a "save changes?" question. */
async function closeMany(list: Tab[]) {
  for (const t of list) if (!(await closeTab(t))) return;
}

/** "Move to new window": saves first if needed (asks), opens the file in a new window, closes the tab here. */
async function moveToNewWindow(tab: Tab) {
  if (tab.dirty || !tab.path) {
    const r = await modal({
      message: `${tab.name} must be saved to move it to a new window. Save it now?`,
      buttons: ["Save", "Cancel"],
    });
    if (r.button !== "Save" || !(await saveTab(tab, false))) return;
  }
  try {
    await newWindow([tab.path!]);
  } catch (e) {
    return flash(String(e));
  }
  await closeTab(tab);
}

function showTabMenu(tab: Tab, x: number, y: number) {
  const i = tabs.indexOf(tab);
  const path = tab.path;
  const doc = tab.kind !== "settings";
  showContextMenu(
    x,
    y,
    [
      { label: "Close", hint: "Ctrl+W", run: () => void closeTab(tab) },
      {
        label: "Close other tabs",
        disabled: tabs.length < 2,
        run: () => void activate(tab).then(() => closeMany(tabs.filter((t) => t !== tab))),
      },
      {
        label: "Close tabs to the right",
        disabled: i >= tabs.length - 1,
        run: () => void closeMany(tabs.slice(i + 1)),
      },
      { label: "", sep: true },
      {
        label: "Copy file path",
        disabled: !path,
        run: () => flash(copyText(path!) ? "File path copied." : "Could not copy the file path."),
      },
      { label: "Show in file manager", disabled: !path, run: () => void showInFolder(path!).catch((e) => flash(String(e))) },
      { label: "Move to new window", disabled: !doc, run: () => void moveToNewWindow(tab) },
    ],
    () => view.focus(),
  );
}

/* ---------- menu bar ---------- */

async function searchSelection() {
  if (active.kind === "settings") return;
  const r = view.state.selection.main;
  const text = view.state.sliceDoc(r.from, Math.min(r.to, r.from + 2000)).replace(/\s+/g, " ").trim();
  if (!text) return flash("Select some text to search for.");
  try {
    await searchWeb(text);
  } catch (e) {
    if (String(e) !== "no-engine") return flash(String(e));
    const { chooseEngine } = await import("./editor/websearch"); // first use: ask which engine, once
    const chosen = await chooseEngine();
    view.focus();
    if (chosen) await searchWeb(text).catch((err) => flash(String(err)));
  }
}

async function pageSetup() {
  const { openPageSetup } = await import("./editor/pagesetup");
  await openPageSetup();
  view.focus();
}

function toggleRtl() {
  if (active.kind === "settings") return;
  active.rtl = !active.rtl;
  setDirection(view, active.rtl);
  view.focus();
}

async function findStep(dir: 1 | -1) {
  (await import("./editor/find")).findStep(view, dir);
}

/** Builds File / Edit / View after the first paint (its code is a lazy chunk). */
async function loadMenus() {
  const { createMenuBar, menuDefs } = await import("./editor/menubar");
  const edit = () => editorCommands(view, flash);
  createMenuBar(
    document.getElementById("menus")!,
    menuDefs({
      isDoc: () => active.kind !== "settings",
      hasSelection: () => hasSelection(view),
      canUndo: () => undoDepth(view.state) > 0,
      canRedo: () => redoDepth(view.state) > 0,
      wrap: () => prefs.wrap,
      statusBar: () => appearance()?.settings.statusBar !== false,
      recent: recentList,
      newTab,
      newWindow: () => void newWindow([]).catch((e) => flash(String(e))),
      open: () => void openDialog(),
      openRecent: (p) => void openFiles([p]),
      clearRecent: () => void recentClear().catch(() => {}),
      save: () => void saveTab(active, false),
      saveAs: () => void saveTab(active, true),
      saveAll: () => void saveAll(),
      print: () => void print(),
      pageSetup: () => void pageSetup(),
      controlChars: () => appearance()?.settings.showControlChars === true,
      toggleControlChars: () => void setAppearance({ showControlChars: appearance()?.settings.showControlChars !== true }),
      rtl: () => active.rtl === true,
      toggleRtl,
      closeTab: () => void closeTab(active),
      closeWindow: () => void closeApp(),
      undo: () => edit().undo(),
      redo: () => edit().redo(),
      cut: () => edit().cut(),
      copy: () => edit().copy(),
      paste: () => edit().paste(),
      del: () => edit().del(),
      find: () => void openFind(false),
      findNext: () => void findStep(1),
      findPrev: () => void findStep(-1),
      replace: () => void openFind(true),
      goto: () => void gotoLine(),
      selectAll: () => edit().selectAll(),
      dateTime: () => {
        insertDateTime();
        view.focus();
      },
      searchWeb: () => void searchSelection(),
      zoomIn: () => setZoom(prefs.zoom + 10),
      zoomOut: () => setZoom(prefs.zoom - 10),
      zoomReset: () => setZoom(100),
      toggleStatusBar: () => void setAppearance({ statusBar: appearance()?.settings.statusBar === false }),
      toggleWrap: () => {
        toggleWrap();
        view.focus();
      },
    }),
    () => (active.kind === "settings" ? undefined : view.focus()),
  );
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
  if (!tab.path || saveAs) void recentAdd(path).catch(() => {});
  tab.path = path;
  if (tab === active) void syncSpell(); // the file type may have changed (Save as .py: no spell check)
  tab.name = basename(path);
  tab.dirty = false;
  tab.stamp = (await fileStamps([path]).catch(() => [null]))[0] ?? undefined;
  tab.external = undefined;
  if (tab === active) hideExtBar();
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

/* ---------- changed on disk ---------- */

function hideExtBar() {
  const bar = document.getElementById("extbar")!;
  bar.hidden = true;
  bar.replaceChildren();
}

/** The user answered (or dismissed): what is on disk now is the new baseline, so it is not asked again. */
function acceptDiskState(tab: Tab) {
  tab.stamp = tab.external === "deleted" ? undefined : tab.extStamp;
  tab.external = undefined;
  tab.extStamp = undefined;
}

async function reloadTab(tab: Tab) {
  if (!tab.path) return;
  const t = await readIntoTab(tab.path);
  if (!t) return;
  tab.state = tab.rtl ? withDirection(t.state!, true) : t.state;
  tab.encoding = t.encoding;
  tab.lineEnding = t.lineEnding;
  tab.stamp = t.stamp;
  tab.dirty = false;
  tab.external = undefined;
  tab.extStamp = undefined;
  if (tab === active) {
    hideExtBar();
    view.setState(tab.state!);
    refreshAll();
    view.focus();
    void syncSpell();
  }
  scheduleSession();
}

/** Shows what the focus check found for `tab` (only the tab on screen is ever prompted). */
async function handleExternal(tab: Tab) {
  if (!tab.external || tab.kind === "settings" || tab !== active) return;
  const prompt = promptFor(tab.external, tab.dirty);
  const text = message(tab.name, prompt);
  if (prompt === "ask") {
    const r = await modal({ message: `${text}\nReload from disk, or keep your version?`, buttons: ["Reload", "Keep mine"] });
    if (!tab.external) return; // answered meanwhile (saved)
    if (r.button === "Reload") await reloadTab(tab);
    else acceptDiskState(tab);
    return;
  }
  const bar = document.getElementById("extbar")!;
  const label = document.createElement("span");
  label.textContent = text;
  const buttons: HTMLButtonElement[] = [];
  const add = (name: string, fn: () => void) => {
    const b = document.createElement("button");
    b.textContent = name;
    b.onclick = fn;
    buttons.push(b);
  };
  if (prompt === "bar-reload") add("Reload", () => void reloadTab(tab));
  add("Dismiss", () => {
    acceptDiskState(tab);
    hideExtBar();
    view.focus();
  });
  bar.replaceChildren(label, ...buttons);
  bar.hidden = false;
}

let checkingExternal = false;
/** Window regained focus: one stat per open file (there is no background watcher). */
async function checkExternal() {
  if (checkingExternal || restoring || document.querySelector(".modal-bg")) return;
  checkingExternal = true;
  try {
    const list = tabs.filter((t) => t.path && t.state && t.kind !== "settings" && !t.discarded);
    if (!list.length) return;
    const now = await fileStamps(list.map((t) => t.path!)).catch(() => null);
    if (!now) return;
    list.forEach((t, i) => {
      if (!t.stamp && now[i]) t.stamp = now[i]!; // restored with unsaved text: the baseline is the first look
      const c = compare(t.stamp, now[i]);
      if (c === "unchanged") return;
      t.external = c;
      t.extStamp = now[i] ?? undefined;
    });
    await handleExternal(active);
  } finally {
    checkingExternal = false;
  }
}

/* ---------- auto-save ---------- */

let autoTimer = 0;
/** Restarts the idle countdown (setting: Auto-save, off by default). Only files that already have a path. */
function scheduleAutoSave() {
  clearTimeout(autoTimer);
  const s = appearance()?.settings;
  if (!s?.autoSave) return;
  autoTimer = window.setTimeout(() => void autoSave(), s.autoSaveSeconds * 1000);
}

async function autoSave() {
  if (document.querySelector(".modal-bg") || restoring) return scheduleAutoSave();
  // A file that changed on disk is never overwritten behind the user's back.
  for (const t of tabs.filter((x) => x.dirty && x.path && !x.external && x.kind !== "settings")) {
    await saveTab(t, false);
  }
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
async function onEditorContextMenu(e: MouseEvent) {
  e.preventDefault();
  const { clientX: x, clientY: y } = e;
  // On a misspelled word: suggestions, Add to dictionary, Ignore (nothing, instantly, anywhere else).
  const spelling = spellMod ? await spellMod.contextItems(view, x, y, flash) : [];
  const quick = (id: "summarize" | "shorten" | "rewrite" | "grammar", label: string) => ({
    label: `AI: ${label}`,
    run: () => void ai().then((c) => c.runQuick(id)),
  });
  showContextMenu(
    x,
    y,
    [
      ...spelling,
      ...editorItems(view, flash),
      { label: "", sep: true },
      { label: "AI actions...", hint: "Ctrl+I", run: () => void openAiMenu({ x, y }) },
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
  document.getElementById("app")!.classList.toggle("no-status", !s.statusBar);
  if (s.wordWrap !== prefs.wrap || s.tabSize !== appliedTab || s.showControlChars !== appliedCtrl) {
    prefs.wrap = s.wordWrap;
    appliedTab = s.tabSize;
    appliedCtrl = s.showControlChars;
    setPrefs(view, s.wordWrap, s.tabSize, s.showControlChars);
    for (const t of tabs) {
      if (t !== active && t.state) t.state = withPrefs(t.state, s.wordWrap, s.tabSize, s.showControlChars);
    }
    status.set({ wrap: s.wordWrap });
    scheduleSession();
  }
  const spellKey = JSON.stringify([s.spellCheck, s.autocorrect, s.spellTypes, s.spellLanguage, s.spellDictDir]);
  if (spellKey !== appliedSpell) {
    appliedSpell = spellKey;
    void syncSpell();
  }
  if (s.autoSave !== appliedAuto) {
    appliedAuto = s.autoSave;
    scheduleAutoSave();
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

async function print() {
  const el = document.getElementById("print")!;
  const s = appearance()?.settings;
  if (s) {
    // Page setup: margins, orientation, header and footer as one @page rule (see editor/printcss.ts).
    const { printCss } = await import("./editor/printcss");
    let style = document.getElementById("printstyle");
    if (!style) {
      style = document.createElement("style");
      style.id = "printstyle";
      document.head.append(style);
    }
    style.textContent = printCss(
      { marginMm: s.printMarginMm, landscape: s.printLandscape, header: s.printHeader, footer: s.printFooter },
      { name: active.name, date: new Date().toLocaleDateString() },
    );
  }
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
  if (e.key === "F3" && !ctrl && !e.altKey) return inDoc ? run(() => void findStep(e.shiftKey ? -1 : 1)) : undefined;
  if (e.altKey && !ctrl && key === "z") return inDoc ? run(toggleWrap) : undefined;
  if (!ctrl || e.altKey) return;
  // Editing shortcuts do nothing on the Settings tab (and must not reach the webview's own handlers).
  if (!inDoc && ["s", "f", "h", "g", "p", "i", "e", "+", "=", "add", "-", "subtract", "0"].includes(key)) return run(() => {});
  switch (key) {
    case ",": return run(() => void openSettings());
    case "i":
      e.stopPropagation(); // not CodeMirror's own Ctrl+I
      return run(() => void openAiMenu());
    case "e":
      e.stopPropagation(); // not CodeMirror's own Ctrl+E (macOS: end of line)
      return run(() => void searchSelection());
    case "n": return run(() => (e.shiftKey ? void newWindow([]).catch((err) => flash(String(err))) : newTab()));
    case "t": return run(() => (e.shiftKey ? void reopenClosed() : newTab()));
    case "w": return run(() => void closeTab(active));
    case "o": return run(() => void openDialog());
    case "s": return run(() => void saveTab(active, e.shiftKey));
    case "f": return run(() => void openFind(false));
    case "h": return run(() => void openFind(true));
    case "g": return run(() => void gotoLine());
    case "p": return run(() => void print());
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
  window.addEventListener("focus", () => void checkExternal());
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
    if (target.closest(".cm-content")) void onEditorContextMenu(e);
    else if (!target.closest("input, textarea, #aipanel")) e.preventDefault();
  });

  marks.push(`active ${Math.round(performance.now())}`);
  void editorReady(marks.join(", "));
  // Show the window now: a hidden WebView2 window does not paint, so waiting for frames only delayed the show.
  // The editor DOM is built and the window background already has the theme colour.
  void showWindow();
  // The menus are built after the first paint: a frame and a timeout later, off the startup path.
  requestAnimationFrame(() => setTimeout(() => void loadMenus(), 0));
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

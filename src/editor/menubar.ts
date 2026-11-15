/** Menu bar: File, Edit, View, with Alt access keys, arrow keys and submenus.
 *  Lazy chunk: fetched and built after the first paint, so it never delays startup. */

export interface Entry {
  /** "&Save" marks the access key. */
  label: string;
  hint?: string;
  title?: string;
  run?: () => void;
  disabled?: boolean;
  checked?: boolean;
  sep?: boolean;
  sub?: Entry[];
}

export interface MenuDef {
  label: string;
  build(): Entry[];
  /** Runs before the menu is built (File fetches the recent list here). */
  prepare?(): Promise<void>;
}

/** What the menus can do and what state they show. Implemented by app.ts. */
export interface Commands {
  isDoc(): boolean;
  hasSelection(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  wrap(): boolean;
  statusBar(): boolean;
  recent(): Promise<string[]>;
  newTab(): void;
  newWindow(): void;
  open(): void;
  openRecent(path: string): void;
  clearRecent(): void;
  save(): void;
  saveAs(): void;
  saveAll(): void;
  print(): void;
  pageSetup(): void;
  closeTab(): void;
  closeWindow(): void;
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  del(): void;
  find(): void;
  findNext(): void;
  findPrev(): void;
  replace(): void;
  goto(): void;
  selectAll(): void;
  dateTime(): void;
  searchWeb(): void;
  controlChars(): boolean;
  toggleControlChars(): void;
  rtl(): boolean;
  toggleRtl(): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  toggleStatusBar(): void;
  toggleWrap(): void;
  md(): boolean;
  toggleMd(): void;
  mdView(): "source" | "preview" | "split";
  setMdView(v: "source" | "preview" | "split"): void;
}

const SEP: Entry = { label: "", sep: true };

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const dirname = (p: string) => p.slice(0, Math.max(0, p.length - basename(p).length - 1));

/** The menu contents. `recent` is filled by File's `prepare` just before it opens. */
export function menuDefs(c: Commands): MenuDef[] {
  let recent: string[] = [];
  const doc = c.isDoc;
  const recentEntries = (): Entry[] => [
    ...(recent.length
      ? recent.map((p) => ({ label: basename(p), hint: dirname(p), title: p, run: () => c.openRecent(p) }))
      : [{ label: "(No recent files)", disabled: true }]),
    SEP,
    { label: "&Clear list", disabled: !recent.length, run: c.clearRecent },
  ];
  return [
    {
      label: "&File",
      prepare: async () => {
        recent = await c.recent().catch(() => []);
      },
      build: () => [
        { label: "New &tab", hint: "Ctrl+N", run: c.newTab },
        { label: "New &window", hint: "Ctrl+Shift+N", run: c.newWindow },
        { label: "&Open...", hint: "Ctrl+O", run: c.open },
        { label: "&Recent", sub: recentEntries() },
        SEP,
        { label: "&Save", hint: "Ctrl+S", disabled: !doc(), run: c.save },
        { label: "Save &as...", hint: "Ctrl+Shift+S", disabled: !doc(), run: c.saveAs },
        { label: "Save a&ll", hint: "Ctrl+Alt+S", run: c.saveAll },
        SEP,
        { label: "&Print...", hint: "Ctrl+P", disabled: !doc(), run: c.print },
        { label: "Page set&up...", run: c.pageSetup },
        SEP,
        { label: "&Close tab", hint: "Ctrl+W", run: c.closeTab },
        { label: "Close wi&ndow", hint: "Ctrl+Shift+W", run: c.closeWindow },
        { label: "E&xit", run: c.closeWindow },
      ],
    },
    {
      label: "&Edit",
      build: () => {
        const d = !doc();
        const sel = d || !c.hasSelection();
        return [
          { label: "&Undo", hint: "Ctrl+Z", disabled: d || !c.canUndo(), run: c.undo },
          { label: "&Redo", hint: "Ctrl+Y", disabled: d || !c.canRedo(), run: c.redo },
          SEP,
          { label: "Cu&t", hint: "Ctrl+X", disabled: sel, run: c.cut },
          { label: "&Copy", hint: "Ctrl+C", disabled: sel, run: c.copy },
          { label: "&Paste", hint: "Ctrl+V", disabled: d, run: c.paste },
          { label: "De&lete", hint: "Del", disabled: sel, run: c.del },
          SEP,
          { label: "&Find...", hint: "Ctrl+F", disabled: d, run: c.find },
          { label: "Find &next", hint: "F3", disabled: d, run: c.findNext },
          { label: "Find pre&vious", hint: "Shift+F3", disabled: d, run: c.findPrev },
          { label: "R&eplace...", hint: "Ctrl+H", disabled: d, run: c.replace },
          { label: "&Go to...", hint: "Ctrl+G", disabled: d, run: c.goto },
          SEP,
          { label: "Select &all", hint: "Ctrl+A", disabled: d, run: c.selectAll },
          { label: "Date and &time", hint: "F5", disabled: d, run: c.dateTime },
          SEP,
          { label: "&Search web", hint: "Ctrl+E", disabled: sel, run: c.searchWeb },
          SEP,
          { label: "Rig&ht-to-left reading order", checked: c.rtl(), disabled: d, run: c.toggleRtl },
        ];
      },
    },
    {
      label: "&View",
      build: () => [
        {
          label: "&Zoom",
          sub: [
            { label: "Zoom &in", hint: "Ctrl++", disabled: !doc(), run: c.zoomIn },
            { label: "Zoom &out", hint: "Ctrl+-", disabled: !doc(), run: c.zoomOut },
            { label: "&Restore default zoom", hint: "Ctrl+0", disabled: !doc(), run: c.zoomReset },
          ],
        },
        { label: "&Status bar", checked: c.statusBar(), run: c.toggleStatusBar },
        { label: "Show &control characters", checked: c.controlChars(), run: c.toggleControlChars },
        { label: "&Word wrap", hint: "Alt+Z", checked: c.wrap(), disabled: !doc(), run: c.toggleWrap },
        SEP,
        { label: "&Markdown mode", hint: "Ctrl+Shift+M", checked: c.md(), disabled: !doc(), run: c.toggleMd },
        {
          label: "Markdown vie&w",
          sub: [
            { label: "&Source", checked: c.mdView() === "source", disabled: !doc() || !c.md(), run: () => c.setMdView("source") },
            { label: "S&plit", checked: c.mdView() === "split", disabled: !doc() || !c.md(), run: () => c.setMdView("split") },
            { label: "&Preview", checked: c.mdView() === "preview", disabled: !doc() || !c.md(), run: () => c.setMdView("preview") },
          ],
        },
      ],
    },
  ];
}

const accessKey = (label: string): string => {
  const i = label.indexOf("&");
  return i >= 0 ? label.charAt(i + 1).toLowerCase() : "";
};

/** Label text with the access key underlined. */
function fill(el: HTMLElement, label: string): void {
  const i = label.indexOf("&");
  if (i < 0) {
    el.textContent = label;
    return;
  }
  const u = document.createElement("u");
  u.textContent = label.charAt(i + 1);
  el.append(label.slice(0, i), u, label.slice(i + 2));
}

interface Level {
  el: HTMLElement;
  rows: { entry: Entry; btn: HTMLButtonElement }[];
  hl: number;
}

/** Fills `host` with the menu buttons. `onClose` runs when a menu is dismissed without a command (give the
 *  editor focus back). */
export function createMenuBar(host: HTMLElement, defs: MenuDef[], onClose: () => void): void {
  let levels: Level[] = []; // [menu] or [menu, submenu]
  let current = -1;
  let token = 0; // a newer open request cancels an older one still waiting in `prepare`

  const buttons = defs.map((d, i) => {
    const b = document.createElement("button");
    b.className = "mb-btn";
    b.setAttribute("aria-haspopup", "menu");
    fill(b, d.label);
    b.onmousedown = (e) => e.preventDefault(); // keep the editor's focus and selection
    b.onclick = () => (current === i ? closeAll(true) : void openMenu(i, false));
    b.onmouseenter = () => {
      if (current >= 0 && current !== i) void openMenu(i, false);
    };
    return b;
  });
  host.replaceChildren(...buttons);

  function place(el: HTMLElement, x: number, y: number, flipX?: number): void {
    document.body.append(el);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = flipX !== undefined && x + w > window.innerWidth - 4 ? flipX - w : x;
    el.style.left = `${Math.max(4, Math.min(left, window.innerWidth - w - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`;
  }

  function render(entries: Entry[]): Level {
    const el = document.createElement("div");
    el.className = "menu ctx bar";
    el.setAttribute("role", "menu");
    const level: Level = { el, rows: [], hl: -1 };
    for (const entry of entries) {
      if (entry.sep) {
        const s = document.createElement("div");
        s.className = "sep";
        el.append(s);
        continue;
      }
      const btn = document.createElement("button");
      btn.setAttribute("role", "menuitem");
      if (entry.title) btn.title = entry.title;
      btn.classList.toggle("on", !!entry.checked);
      btn.disabled = !!entry.disabled;
      const text = document.createElement("span");
      fill(text, entry.label);
      const side = document.createElement("span");
      side.className = "hint";
      side.textContent = entry.sub ? "▸" : (entry.hint ?? "");
      btn.append(text, side);
      const idx = level.rows.length;
      btn.onmousedown = (e) => e.preventDefault();
      btn.onmouseenter = () => hover(level, idx);
      btn.onclick = () => activate(level, idx);
      level.rows.push({ entry, btn });
      el.append(btn);
    }
    return level;
  }

  function setHl(level: Level, idx: number): void {
    level.rows[level.hl]?.btn.classList.remove("hl");
    level.hl = idx;
    level.rows[idx]?.btn.classList.add("hl");
  }

  /** Moves the highlight to the next enabled row in `dir` (wrapping); from -1 it starts at the first / last. */
  function move(level: Level, dir: 1 | -1): void {
    const n = level.rows.length;
    for (let k = 1; k <= n; k++) {
      const i = (((level.hl < 0 ? (dir > 0 ? -1 : n) : level.hl) + dir * k) % n + n) % n;
      if (!level.rows[i].entry.disabled) return setHl(level, i);
    }
  }

  function hover(level: Level, idx: number): void {
    if (level.rows[idx].entry.disabled) return;
    setHl(level, idx);
    if (level === levels[0]) {
      if (level.rows[idx].entry.sub) openSub(level, idx, false);
      else closeSub();
    }
  }

  function closeSub(): void {
    if (levels.length > 1) levels.pop()!.el.remove();
  }

  function openSub(parent: Level, idx: number, keyboard: boolean): void {
    closeSub();
    const { entry, btn } = parent.rows[idx];
    if (!entry.sub || entry.disabled) return;
    setHl(parent, idx);
    const sub = render(entry.sub);
    levels.push(sub);
    const r = btn.getBoundingClientRect();
    place(sub.el, r.right - 2, r.top - 5, r.left + 2);
    if (keyboard) move(sub, 1);
  }

  function activate(level: Level, idx: number): void {
    const { entry } = level.rows[idx];
    if (entry.disabled) return;
    if (entry.sub) return openSub(level, idx, true);
    closeAll(false);
    entry.run?.();
  }

  async function openMenu(i: number, keyboard: boolean): Promise<void> {
    const t = ++token;
    await defs[i].prepare?.();
    if (t !== token) return;
    for (const l of levels) l.el.remove();
    const level = render(defs[i].build());
    levels = [level];
    const r = buttons[i].getBoundingClientRect();
    place(level.el, r.left, r.bottom + 2);
    buttons.forEach((b, k) => b.classList.toggle("open", k === i));
    if (current < 0) {
      window.addEventListener("pointerdown", outside, true);
      window.addEventListener("blur", onBlur);
    }
    current = i;
    if (keyboard) move(level, 1);
  }

  function closeAll(refocus: boolean): void {
    token++;
    for (const l of levels) l.el.remove();
    levels = [];
    if (current >= 0) {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", onBlur);
    }
    current = -1;
    for (const b of buttons) b.classList.remove("open");
    if (refocus) onClose();
  }

  const outside = (e: Event) => {
    const t = e.target as Node;
    if (!levels.some((l) => l.el.contains(t)) && !buttons.some((b) => b.contains(t))) closeAll(false);
  };
  const onBlur = () => closeAll(false);

  const byAccessKey = (key: string) => defs.findIndex((d) => accessKey(d.label) === key.toLowerCase());

  window.addEventListener(
    "keydown",
    (e) => {
      if (document.querySelector(".modal-bg")) return;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const n = defs.length;
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.length === 1) {
        const i = byAccessKey(e.key);
        if (i < 0) return;
        stop();
        if (i === current) closeAll(true);
        else void openMenu(i, true);
        return;
      }
      if (current < 0) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return closeAll(false); // a shortcut: let it run
      const top = levels[levels.length - 1];
      stop();
      switch (e.key) {
        case "Escape":
          return levels.length > 1 ? closeSub() : closeAll(true);
        case "ArrowDown":
          return move(top, 1);
        case "ArrowUp":
          return move(top, -1);
        case "ArrowRight":
          if (top.rows[top.hl]?.entry.sub) return openSub(top, top.hl, true);
          return levels.length === 1 ? void openMenu((current + 1) % n, true) : undefined;
        case "ArrowLeft":
          return levels.length > 1 ? closeSub() : void openMenu((current - 1 + n) % n, true);
        case "Home":
          setHl(top, -1);
          return move(top, 1);
        case "End":
          setHl(top, -1);
          return move(top, -1);
        case "Enter":
        case " ":
          return top.hl >= 0 ? activate(top, top.hl) : undefined;
      }
      if (e.key.length === 1) {
        const k = e.key.toLowerCase();
        const i = top.rows.findIndex((r) => !r.entry.disabled && accessKey(r.entry.label) === k);
        if (i >= 0) activate(top, i);
      }
    },
    true,
  );
}

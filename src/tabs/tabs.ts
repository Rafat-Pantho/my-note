import type { EditorState } from "@codemirror/state";

export interface Tab {
  id: number;
  path: string | null;
  name: string;
  /** null while a restored file-backed tab has not been read from disk yet. */
  state: EditorState | null;
  dirty: boolean;
  encoding: string;
  lineEnding: string;
  /** The single Settings tab: no document, never saved or restored. */
  kind?: "settings";
  /** Untitled tab whose changes were thrown away at app close; not restored. */
  discarded?: boolean;
}

export interface TabBarHandlers {
  select(tab: Tab): void;
  close(tab: Tab): void;
  reorder(ids: number[]): void;
  /** Right-click on a tab, at screen position (x, y). */
  context(tab: Tab, x: number, y: number): void;
}

const DRAG_THRESHOLD = 5;

export class TabBar {
  /** Ids already shown, so only a newly opened tab plays the enter animation (not every re-render). */
  private seen: Set<number> | null = null;

  constructor(
    private host: HTMLElement,
    private handlers: TabBarHandlers,
  ) {
    host.addEventListener("wheel", (e) => {
      host.scrollLeft += e.deltaY;
    });
  }

  render(tabs: Tab[], active: Tab | undefined): void {
    const seen = this.seen;
    this.host.replaceChildren(
      ...tabs.map((t) => {
        const el = this.element(t, t === active);
        if (seen && !seen.has(t.id)) el.classList.add("enter");
        return el;
      }),
    );
    this.seen = new Set(tabs.map((t) => t.id));
    this.host.querySelector(".active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  private element(tab: Tab, active: boolean): HTMLElement {
    const el = document.createElement("div");
    el.className = "tab" + (active ? " active" : "") + (tab.dirty ? " is-dirty" : "");
    el.dataset.id = String(tab.id);
    el.title = tab.path ?? tab.name;
    el.innerHTML = '<span class="name"></span><span class="dirty" title="Unsaved changes">●</span><button class="close" title="Close (Ctrl+W)">×</button>';
    el.querySelector(".name")!.textContent = tab.name;

    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".close")) this.handlers.close(tab);
      else this.handlers.select(tab);
    });
    el.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll
    });
    el.addEventListener("auxclick", (e) => {
      if (e.button === 1) this.handlers.close(tab);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.handlers.context(tab, e.clientX, e.clientY);
    });
    this.enableDrag(el);
    return el;
  }

  /** Pointer-based reordering: HTML5 drag-drop is unreliable in WebView2 with file drop on. */
  private enableDrag(el: HTMLElement): void {
    let startX = 0;
    let down = false;
    let dragging = false;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest(".close")) return;
      down = true;
      dragging = false;
      startX = e.clientX;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!down) return;
      if (!dragging && Math.abs(e.clientX - startX) > DRAG_THRESHOLD) {
        dragging = true;
        el.classList.add("dragging");
      }
      if (!dragging) return;
      const others = [...this.host.querySelectorAll<HTMLElement>(".tab")].filter((t) => t !== el);
      const before = others.find((t) => {
        const r = t.getBoundingClientRect();
        return e.clientX < r.left + r.width / 2;
      });
      this.host.insertBefore(el, before ?? null);
    });
    const end = () => {
      if (!down) return;
      down = false;
      if (dragging) {
        el.classList.remove("dragging");
        const ids = [...this.host.querySelectorAll<HTMLElement>(".tab")].map((t) => Number(t.dataset.id));
        this.handlers.reorder(ids);
      }
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
}

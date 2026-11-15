/** The "Reopen closed tab" stack (Ctrl+Shift+T). Pure logic, no DOM. In memory only: never saved. */

export const MAX_CLOSED = 10;
/** An untitled tab bigger than this is not kept (the text would sit in memory for nothing). */
export const MAX_CLOSED_TEXT = 1_000_000;

export interface ClosedTab {
  path: string | null;
  name: string;
  encoding: string;
  lineEnding: string;
  /** Only for an untitled tab; a file tab is read from disk again. */
  text?: string;
}

interface TabInfo {
  path: string | null;
  name: string;
  encoding: string;
  lineEnding: string;
  kind?: string;
}

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What to remember about a tab being closed, or null if there is nothing worth bringing back. */
export function closedEntry(t: TabInfo, text: string | undefined): ClosedTab | null {
  if (t.kind === "settings") return null;
  const { path, name, encoding, lineEnding } = t;
  if (path) return { path, name, encoding, lineEnding };
  if (!text || text.length > MAX_CLOSED_TEXT) return null; // empty or huge untitled tab
  return { path, name, encoding, lineEnding, text };
}

export class ClosedTabs {
  private items: ClosedTab[] = [];

  get size(): number {
    return this.items.length;
  }

  /** Newest last. The same file closed twice is kept once (the newer entry); the oldest falls off at 10. */
  push(entry: ClosedTab): void {
    const p = entry.path;
    if (p) this.items = this.items.filter((e) => !e.path || !samePath(e.path, p));
    this.items.push(entry);
    if (this.items.length > MAX_CLOSED) this.items.splice(0, this.items.length - MAX_CLOSED);
  }

  /** The most recently closed tab that is not already open again; entries skipped on the way are dropped. */
  pop(isOpen: (path: string) => boolean = () => false): ClosedTab | undefined {
    for (let e = this.items.pop(); e; e = this.items.pop()) {
      if (!e.path || !isOpen(e.path)) return e;
    }
    return undefined;
  }

  clear(): void {
    this.items = [];
  }
}

/** Per-tab rollback history of accepted AI changes. Pure bookkeeping (no DOM): each entry remembers the text
 *  before and after, and where the AI text lives now (its range follows later edits). */
import type { DocLike, Mapper } from "./scope.ts";
import { mapRange } from "./scope.ts";

export interface Entry {
  id: number;
  /** e.g. "Shorten", "Change tone: Formal", or "Restore: Shorten". */
  action: string;
  /** Unix ms. */
  time: number;
  scope: "selection" | "file";
  /** The badge text at the time, e.g. "Selection, 123 words". */
  scopeLabel: string;
  /** Where the AI text is now: [from, to) in the current document. Updated by `map`. */
  from: number;
  to: number;
  /** The text this change replaced ("" for an insertion), and the text it put there. */
  before: string;
  after: string;
  /** The change was already rolled back. */
  restored?: boolean;
  /** Undone or redone with Ctrl+Z / Ctrl+Y: the text can no longer be followed reliably, so it cannot be
   *  rolled back (the undo already did it). */
  detached?: boolean;
}

export type NewEntry = Omit<Entry, "id" | "restored" | "detached">;

/** The few things we need from a CodeMirror `ChangeSet`. */
export interface RangeSource {
  iterChangedRanges(f: (fromA: number, toA: number, fromB: number, toB: number) => void): void;
}

export interface Limits {
  maxEntries: number;
  /** Total characters kept across all entries (before + after). About 2 bytes each in memory. */
  maxChars: number;
}

export const DEFAULT_LIMITS: Limits = { maxEntries: 50, maxChars: 4_000_000 };

export interface AddResult {
  /** Not stored because it alone is over the memory cap (the edit itself is still undoable with Ctrl+Z). */
  skipped: boolean;
  /** Older entries dropped to stay inside the caps. */
  dropped: number;
}

export interface RestorePlan {
  /** Replace [from, to) with `insert` to roll the entry back. */
  from: number;
  to: number;
  insert: string;
  /** The text there is not what the AI put there (edited since): rolling back would lose those edits. */
  lostEdits: boolean;
  /** What is in the document right now, for the preview of what will be lost. */
  current: string;
}

export class RollbackHistory {
  private list: Entry[] = [];
  private chars = 0;
  private nextId = 1;

  private readonly limits: Limits;

  constructor(limits: Limits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  /** Oldest first. */
  get entries(): readonly Entry[] {
    return this.list;
  }

  get totalChars(): number {
    return this.chars;
  }

  get(id: number): Entry | undefined {
    return this.list.find((e) => e.id === id);
  }

  add(e: NewEntry): AddResult {
    const size = e.before.length + e.after.length;
    if (size > this.limits.maxChars) return { skipped: true, dropped: 0 };
    this.list.push({ ...e, id: this.nextId++ });
    this.chars += size;
    let dropped = 0;
    while (this.list.length > this.limits.maxEntries || this.chars > this.limits.maxChars) {
      const old = this.list.shift()!;
      this.chars -= old.before.length + old.after.length;
      dropped++;
    }
    return { skipped: false, dropped };
  }

  /** Call after every document change (with the transaction's changes) to keep the ranges current. */
  map(m: Mapper): void {
    for (const e of this.list) Object.assign(e, mapRange(e, m));
  }

  /** Call BEFORE `map` for a change made by undo or redo: entries it touches are detached, because undo
   *  rewrites exactly the text an entry points at and the range can no longer be trusted. */
  detachTouching(changes: RangeSource): void {
    changes.iterChangedRanges((fromA, toA) => {
      for (const e of this.list) if (fromA <= e.to && toA >= e.from) e.detached = true;
    });
  }

  /** How to roll entry `id` back, or undefined if it is gone. Only the entry's own text is touched: edits
   *  elsewhere in the document stay. `lostEdits` is true if the text inside was changed after the AI put it
   *  there, which is when the user must confirm. */
  planRestore(id: number, doc: DocLike): RestorePlan | undefined {
    const e = this.get(id);
    if (!e || e.detached) return undefined;
    const to = Math.min(e.to, doc.length);
    const from = Math.min(e.from, to);
    const current = doc.sliceString(from, to);
    return { from, to, insert: e.before, lostEdits: current !== e.after, current };
  }

  markRestored(id: number): void {
    const e = this.get(id);
    if (e) e.restored = true;
  }
}

/** "Changed on disk" logic. Pure: the app compares stamps when the window regains focus (no file watcher). */

export interface Stamp {
  mtimeMs: number;
  size: number;
}

export type Change = "unchanged" | "changed" | "deleted";

/** `known` is what we saw when the file was read or saved; `now` is a fresh stat (null: the file is gone).
 *  A tab with no known stamp (never stat-ed) is never reported. */
export function compare(known: Stamp | undefined, now: Stamp | null): Change {
  if (!known) return "unchanged";
  if (!now) return "deleted";
  return now.mtimeMs !== known.mtimeMs || now.size !== known.size ? "changed" : "unchanged";
}

export type Prompt =
  | "none"
  /** Non-blocking bar: Reload / Dismiss. */
  | "bar-reload"
  /** The tab has unsaved edits: ask Reload or Keep mine. */
  | "ask"
  /** Non-blocking bar: the file is gone, Dismiss only. */
  | "bar-deleted";

export function promptFor(change: Change, dirty: boolean): Prompt {
  if (change === "unchanged") return "none";
  if (change === "deleted") return "bar-deleted";
  return dirty ? "ask" : "bar-reload";
}

/** Wording for the bar and the question. */
export function message(name: string, prompt: Prompt): string {
  if (prompt === "bar-deleted") return `${name} was deleted or moved on disk.`;
  if (prompt === "ask") return `${name} changed on disk, and you have unsaved changes here.`;
  return `${name} changed on disk.`;
}

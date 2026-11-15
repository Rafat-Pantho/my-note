/** Save all: dirty tabs that already have a file first (in tab order), then untitled ones, which open Save As one
 * at a time. The Settings tab is never saved. Pure. */
export function saveAllOrder<T extends { dirty: boolean; kind?: string; path?: string | null }>(tabs: readonly T[]): T[] {
  const dirty = tabs.filter((t) => t.dirty && t.kind !== "settings");
  return [...dirty.filter((t) => !!t.path), ...dirty.filter((t) => !t.path)];
}

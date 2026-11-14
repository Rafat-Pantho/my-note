import type { Tab } from "./tabs";

/** Unsaved text above this size is not kept in the session file (keeps writes fast). */
const MAX_SESSION_TEXT = 8 * 1024 * 1024;

export interface Prefs {
  wrap: boolean;
  zoom: number;
}

export interface SessionTab {
  path: string | null;
  name: string;
  encoding: string;
  lineEnding: string;
  dirty: boolean;
  /** Present for untitled and dirty tabs; clean file tabs are re-read from disk. */
  text?: string;
}

export interface Session {
  version: 1;
  active: number;
  prefs: Prefs;
  tabs: SessionTab[];
}

export function buildSession(tabs: Tab[], active: Tab | undefined, prefs: Prefs): Session {
  const kept = tabs.filter((t) => !t.discarded && t.kind !== "settings");
  const out: SessionTab[] = kept.map((t) => {
    const s: SessionTab = {
      path: t.path,
      name: t.name,
      encoding: t.encoding,
      lineEnding: t.lineEnding,
      dirty: t.dirty,
    };
    if ((t.dirty || !t.path) && t.state && t.state.doc.length <= MAX_SESSION_TEXT) {
      s.text = t.state.doc.toString();
    }
    return s;
  });
  return { version: 1, active: Math.max(0, kept.findIndex((t) => t === active)), prefs, tabs: out };
}

/** Defensive parse: the file may be stale, hand-edited or from a future version. */
export function parseSession(raw: unknown): Session | null {
  const r = raw as Partial<Session> | null;
  if (!r || r.version !== 1 || !Array.isArray(r.tabs)) return null;
  const tabs = r.tabs.filter(
    (t): t is SessionTab =>
      !!t && typeof t.name === "string" && typeof t.encoding === "string" && typeof t.lineEnding === "string",
  );
  const zoom = Number(r.prefs?.zoom);
  return {
    version: 1,
    active: Number.isInteger(r.active) ? (r.active as number) : 0,
    prefs: {
      wrap: r.prefs?.wrap !== false,
      zoom: Number.isFinite(zoom) ? Math.min(500, Math.max(10, zoom)) : 100,
    },
    tabs,
  };
}

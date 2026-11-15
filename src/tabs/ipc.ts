import { invoke } from "@tauri-apps/api/core";

import type { Stamp } from "./external";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Body framing shared with Rust: [u32 BE meta length][meta JSON][payload]. */
function pack(meta: object, payload: string): Uint8Array {
  const m = encoder.encode(JSON.stringify(meta));
  const p = encoder.encode(payload);
  const out = new Uint8Array(4 + m.length + p.length);
  new DataView(out.buffer).setUint32(0, m.length);
  out.set(m, 4);
  out.set(p, 4 + m.length);
  return out;
}

export interface FileData {
  text: string;
  encoding: string;
  lineEnding: string;
  size: number;
}

/** Rejects with "large:<bytes>" for files over 100 MB unless `allowLarge`. */
export async function readFile(path: string, allowLarge: boolean): Promise<FileData> {
  const buf = await invoke<ArrayBuffer>("read_file", { path, allowLarge });
  const n = new DataView(buf).getUint32(0);
  const meta = JSON.parse(decoder.decode(new Uint8Array(buf, 4, n)));
  return { ...meta, text: decoder.decode(new Uint8Array(buf, 4 + n)) };
}

export function writeFile(path: string, text: string, encoding: string, lineEnding: string) {
  return invoke<void>("write_file", pack({ path, encoding, lineEnding }, text));
}

export const pickOpenFiles = () => invoke<string[]>("pick_open_files");
export const pickSavePath = (defaultName: string) =>
  invoke<string | null>("pick_save_path", { defaultName });
/** Last opened files that still exist (paths only). */
export const recentList = () => invoke<string[]>("recent_list");
export const recentAdd = (path: string) => invoke<void>("recent_add", { path });
export const recentClear = () => invoke<void>("recent_clear");
/** Opens the chosen search engine in the system browser. Rejects with "no-engine" until one is chosen. */
export const searchWeb = (query: string) => invoke<void>("search_web", { query });
export const showInFolder = (path: string) => invoke<void>("show_in_folder", { path });
/** Starts another window (a new process) that opens these files. */
export const newWindow = (paths: string[]) => invoke<void>("new_window", { paths });
/** Modified time and size of each file (null if gone). One stat each, only when the window regains focus. */
export const fileStamps = (paths: string[]) => invoke<(Stamp | null)[]>("file_stamps", { paths });
export const takeLaunchArgs = () => invoke<string[]>("take_launch_args");
export const setTitle = (title: string) => invoke<void>("set_title", { title });
export const exitApp = () => invoke<void>("exit_app");
export const showWindow = () => invoke<void>("show_window");
export const editorReady = (marks?: string) => invoke<void>("editor_ready", { marks });

/** The raw session file (empty if there is none). Decoding is separate from loading. */
export const loadSessionBytes = (full: boolean) => invoke<ArrayBuffer>("load_session", { full });
/** Rust answers a big session file with one marker byte; ask again with `full` after the first paint. */
export const isSessionLarge = (b: ArrayBuffer) => b.byteLength === 1 && new Uint8Array(b)[0] === 0x4c;

export function decodeSession(buf: ArrayBuffer): unknown | null {
  if (buf.byteLength === 0) return null;
  try {
    return JSON.parse(decoder.decode(buf));
  } catch {
    return null;
  }
}

export function saveSession(data: unknown) {
  return invoke<void>("save_session", encoder.encode(JSON.stringify(data)));
}

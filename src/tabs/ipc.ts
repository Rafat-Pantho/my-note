import { invoke } from "@tauri-apps/api/core";

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
export const takeLaunchArgs = () => invoke<string[]>("take_launch_args");
export const setTitle = (title: string) => invoke<void>("set_title", { title });
export const exitApp = () => invoke<void>("exit_app");
export const showWindow = () => invoke<void>("show_window");
export const editorReady = () => invoke<void>("editor_ready");

export async function loadSession(): Promise<unknown | null> {
  const buf = await invoke<ArrayBuffer>("load_session");
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

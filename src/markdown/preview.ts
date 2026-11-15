/** The Markdown preview pane. Lazy chunk (marked + DOMPurify): loaded the first time a view other than Source is
 *  shown. What it shows is the sanitized output of `render.ts`, post-processed so that nothing in it can navigate
 *  or load anything by itself:
 *   - links lose their `href`; a click asks first and then Rust opens http, https or mailto in the system browser;
 *   - remote images are blocked until the user agrees, once per file; then Rust downloads them (the page never
 *     makes a request) and they are shown as inline data. */
import DOMPurify from "dompurify";
import { invoke } from "@tauri-apps/api/core";
import { modal } from "../editor/dialog";
import { imageSource, safeLink } from "./links";
import { createRenderer } from "./render";

const renderer = createRenderer(DOMPurify as never);
const MAX_CHARS = 2_000_000;
const MAX_IMAGES_PER_PASS = 30;
const MIME = ["", "image/png", "image/jpeg", "image/gif", "image/webp"];

/** Files (tabs) whose owner agreed to load remote images. Forgotten when the tab goes away. */
const agreed = new WeakSet<object>();
/** Downloaded images by address: a data URI, or "" for one that failed. Bounded. */
const images = new Map<string, string>();
const MAX_CACHED = 60;

function toDataUri(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const kind = bytes[0];
  let bin = "";
  for (let i = 1; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${MIME[kind] ?? "image/png"};base64,${btoa(bin)}`;
}

async function fetchImage(url: string): Promise<void> {
  try {
    const data = toDataUri(await invoke<ArrayBuffer>("fetch_image", { url }));
    if (images.size >= MAX_CACHED) images.delete(images.keys().next().value as string);
    images.set(url, data);
  } catch {
    images.set(url, "");
  }
}

const note = (text: string) => {
  const s = document.createElement("span");
  s.className = "md-note";
  s.textContent = text;
  return s;
};

export interface PreviewHost {
  flash(text: string): void;
}

export class Preview {
  private lastSource = "";
  private lastKey: object = this;
  private fetching = false;

  constructor(
    readonly pane: HTMLElement,
    private host: PreviewHost,
  ) {
    pane.addEventListener("click", (e) => {
      const a = (e.target as Element).closest<HTMLElement>("[data-href]");
      if (a) {
        e.preventDefault();
        void this.openLink(a.dataset.href!);
      }
    });
    pane.addEventListener("keydown", (e) => {
      const a = (e.target as Element).closest<HTMLElement>("[data-href]");
      if (a && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        void this.openLink(a.dataset.href!);
      }
    });
  }

  /** Asks, then hands the address to Rust (which checks the scheme again). */
  private async openLink(url: string): Promise<void> {
    if (!safeLink(url)) return;
    const shown = url.length > 300 ? `${url.slice(0, 300)}...` : url;
    const r = await modal({ message: `Open this link in your browser?\n\n${shown}`, buttons: ["Open", "Cancel"] });
    if (r.button !== "Open") return;
    try {
      await invoke("open_link", { url });
    } catch (e) {
      this.host.flash(String(e));
    }
  }

  /** Renders `source` (keeping the scroll position). `key` is the tab: remote-image consent belongs to it. */
  render(source: string, key: object): void {
    this.lastSource = source;
    this.lastKey = key;
    const text = source.length > MAX_CHARS ? source.slice(0, MAX_CHARS) : source;
    const frag = renderer.toFragment(text);

    for (const a of [...frag.querySelectorAll("a")]) {
      const url = safeLink(a.getAttribute("href") ?? "");
      a.removeAttribute("href");
      if (url) {
        a.dataset.href = url;
        a.setAttribute("role", "link");
        a.tabIndex = 0;
        a.title = url;
      } else {
        a.replaceWith(...a.childNodes);
      }
    }

    const blocked = new Set<string>();
    const wanted: string[] = [];
    for (const img of [...frag.querySelectorAll("img")]) {
      const alt = img.getAttribute("alt") || "image";
      const src = imageSource(img.getAttribute("src") ?? "");
      if (!src) {
        img.replaceWith(note(`[${alt}: not shown]`));
      } else if (src.kind === "data") {
        img.setAttribute("src", src.url); // inline raster data (already validated)
      } else {
        const data = agreed.has(key) ? images.get(src.url) : undefined;
        img.removeAttribute("src");
        if (data) {
          img.setAttribute("src", data);
        } else if (data === "") {
          img.replaceWith(note(`[${alt}: could not be loaded]`));
        } else if (agreed.has(key)) {
          img.replaceWith(note(`[${alt}: loading...]`));
          wanted.push(src.url);
        } else {
          img.replaceWith(note(`[${alt}: remote image]`));
          blocked.add(src.url);
        }
      }
    }
    for (const box of frag.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) box.disabled = true;

    const body = document.createElement("article");
    body.className = "md-body";
    body.append(frag);
    const top = this.pane.scrollTop;
    const nodes: Node[] = [];
    if (source.length > MAX_CHARS) nodes.push(this.banner("The preview shows only the first 2 million characters of this file."));
    if (blocked.size) nodes.push(this.imageBanner(blocked.size, [...blocked]));
    nodes.push(body);
    this.pane.replaceChildren(...nodes);
    this.pane.scrollTop = top;

    if (wanted.length && !this.fetching) void this.load(wanted);
  }

  private banner(text: string): HTMLElement {
    const b = document.createElement("div");
    b.className = "md-banner";
    b.append(text);
    return b;
  }

  private imageBanner(count: number, urls: string[]): HTMLElement {
    const b = this.banner(`${count} remote image${count === 1 ? " is" : "s are"} not loaded. `);
    const btn = document.createElement("button");
    btn.textContent = "Load images...";
    btn.onclick = async () => {
      const hosts = [...new Set(urls.map((u) => new URL(u).host))].slice(0, 8);
      const r = await modal({
        message:
          `Load ${count} image${count === 1 ? "" : "s"} from the internet?\n\n${hosts.join("\n")}\n\n` +
          "This connects to those servers (they see your IP address). You are asked once for this file.",
        buttons: ["Load", "Cancel"],
      });
      if (r.button !== "Load") return;
      agreed.add(this.lastKey);
      this.render(this.lastSource, this.lastKey);
    };
    b.append(btn);
    return b;
  }

  /** Downloads the images the page is waiting for (a few at a time), then draws again. */
  private async load(urls: string[]): Promise<void> {
    this.fetching = true;
    try {
      for (const u of urls.slice(0, MAX_IMAGES_PER_PASS)) if (!images.has(u)) await fetchImage(u);
    } finally {
      this.fetching = false;
    }
    this.render(this.lastSource, this.lastKey);
  }

  clear(): void {
    this.pane.replaceChildren();
    this.lastSource = "";
  }
}

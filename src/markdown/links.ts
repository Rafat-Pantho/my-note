/** Which addresses the Markdown preview may use. Pure (tested in links.test.ts); Rust checks again before
 *  anything is opened or downloaded (`web::link_ok`, `web::image_url_ok`). */

const CONTROL_OR_SPACE = /[\u0000- \u007f-\u009f\u2028\u2029]/u;

/** A link that may be opened in the system browser: http, https or mailto, nothing else. Returns the
 *  normalized address, or null. Relative links, `#anchors`, `javascript:`, `data:`, `file:`, `vbscript:` and
 *  every other scheme are refused, whatever the case or the characters hidden inside the scheme. */
export function safeLink(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048 || CONTROL_OR_SPACE.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === "http:" || u.protocol === "https:") return u.hostname ? u.href : null;
  if (u.protocol === "mailto:") return u.pathname ? u.href : null;
  return null;
}

export type ImageSource = { kind: "remote"; url: string } | { kind: "data"; url: string };

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i;
const MAX_DATA_IMAGE = 3 * 1024 * 1024;

/** What an `![](...)` may point at: an http(s) address (blocked until the user allows remote images for the
 *  file) or an inline PNG/JPEG/GIF/WebP data URI. SVG, other data types, local paths and every other scheme
 *  are refused. */
export function imageSource(raw: string): ImageSource | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length <= MAX_DATA_IMAGE && DATA_IMAGE.test(raw)) return { kind: "data", url: raw };
  const u = raw.length > 2048 || CONTROL_OR_SPACE.test(raw) ? null : safeLink(raw);
  return u && !u.startsWith("mailto:") ? { kind: "remote", url: u } : null;
}

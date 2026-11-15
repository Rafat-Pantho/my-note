/** Markdown -> safe HTML. The parser is `marked`; its output is not trusted: raw HTML in the source is turned
 *  into plain text before parsing finishes, and everything then goes through DOMPurify with an allow-list of
 *  tags and attributes, links limited to http / https / mailto and images to http(s) or inline raster data
 *  URIs. The sanitizer is passed in so tests can use a jsdom window (tested in render.test.ts). */
import { Marked } from "marked";
import { imageSource, safeLink } from "./links.ts";

/** The part of DOMPurify we use. */
export interface Purify {
  sanitize(dirty: string, config?: Record<string, unknown>): unknown;
  addHook(name: string, hook: (node: Element, data?: { attrName: string; attrValue: string; keepAttr: boolean }) => void): void;
}

const TAGS = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "code", "pre", "blockquote",
  "ul", "ol", "li", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "input",
];
const ATTRS = ["href", "src", "alt", "title", "align", "start", "type", "checked", "disabled"];

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface Renderer {
  /** Safe HTML text. */
  toHtml(source: string): string;
  /** The same, as a detached fragment ready to insert (never re-parsed from a string). */
  toFragment(source: string): DocumentFragment;
}

export function createRenderer(purify: Purify): Renderer {
  const md = new Marked({ gfm: true, breaks: false, async: false });
  md.use({
    renderer: {
      // No raw HTML: block and inline HTML both come out as visible text.
      html: (token: { text: string }) => escapeHtml(token.text),
    },
  });

  purify.addHook("uponSanitizeAttribute", (node, data) => {
    if (!data) return;
    const name = data.attrName;
    if (name === "href" && !safeLink(data.attrValue)) data.keepAttr = false;
    if (name === "src" && !imageSource(data.attrValue)) data.keepAttr = false;
    if (name === "type" && !(node.nodeName === "INPUT" && data.attrValue === "checkbox") && node.nodeName !== "OL") {
      data.keepAttr = false;
    }
    if (name === "align" && !/^(left|right|center)$/i.test(data.attrValue)) data.keepAttr = false;
    if (name === "start" && !/^\d{1,9}$/.test(data.attrValue)) data.keepAttr = false;
  });
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "INPUT") {
      if (node.getAttribute("type") !== "checkbox") node.remove();
      else node.setAttribute("disabled", "");
    }
  });

  const config = {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRS,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // Plain values of these must not be tested against the address pattern below.
    ADD_URI_SAFE_ATTR: ["align", "type", "start", "checked", "disabled"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|data:image\/(?:png|jpe?g|gif|webp);base64,)/i,
  };
  const parse = (source: string) => md.parse(source, { async: false });

  return {
    toHtml: (source) => String(purify.sanitize(parse(source), config)),
    toFragment: (source) => purify.sanitize(parse(source), { ...config, RETURN_DOM_FRAGMENT: true }) as DocumentFragment,
  };
}

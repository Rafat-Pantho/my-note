/** Which files get spell check and autocorrect, by file extension. Pure: no DOM, no IPC (tested in spelltypes.test.ts). */

/** The word for "a file name with no extension" in the list (a real extension is never written in brackets). */
export const NO_EXTENSION = "(none)";
export const DEFAULT_SPELL_EXTENSIONS = `txt ${NO_EXTENSION}`;

/** Extension-less names that are code or config, not prose. */
const CODE_NAMES = new Set(["makefile", "dockerfile", "gemfile", "rakefile", "procfile", "vagrantfile", "justfile"]);

/** The list as the user typed it (spaces, commas or semicolons; dots and case ignored) -> a set. */
export function parseExtensions(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const e = raw.trim().toLowerCase().replace(/^\*?\./, "");
    if (e) out.add(e === "none" || e === "(none)" ? NO_EXTENSION : e);
  }
  return out;
}

/** The extension of a path in lower case, NO_EXTENSION for a plain name with none, or null for a name that is
 *  never prose (Makefile, .gitignore): those match nothing, not even "(none)". */
export function extensionOf(path: string): string | null {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return CODE_NAMES.has(name) ? null : NO_EXTENSION;
  if (dot === 0) return null; // ".gitignore" is config
  if (dot === name.length - 1) return NO_EXTENSION; // "notes." has no extension
  return name.slice(dot + 1);
}

/** How the tokenizer reads a file: Markdown has code spans, fences and link targets to skip. */
export type TextKind = "text" | "markdown";

const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd", "mkdn"]);

/** What a tab needs from spell check / autocorrect, or null for nothing. An unsaved tab follows the `untitled`
 *  switch; a saved file follows the extension list. */
export function spellKindFor(path: string | null, types: Record<string, boolean>, extensions: string): TextKind | null {
  if (!path) return types.untitled ? "text" : null;
  const ext = extensionOf(path);
  if (ext === null || !parseExtensions(extensions).has(ext)) return null;
  return MARKDOWN.has(ext) ? "markdown" : "text";
}

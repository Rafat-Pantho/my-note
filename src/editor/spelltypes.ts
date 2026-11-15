/** Which file types get spell check and autocorrect. Pure: no DOM, no IPC (tested in spelltypes.test.ts). */

export type FileType = "untitled" | "text" | "markdown" | "web" | "data" | "code" | "other";

/** In the order the settings list shows them. Rust keeps the same keys (`spell::FILE_TYPES`). */
export const FILE_TYPES: { id: FileType; label: string; hint: string }[] = [
  { id: "untitled", label: "Untitled (not saved yet)", hint: "" },
  { id: "text", label: "Plain text", hint: ".txt, files with no extension" },
  { id: "markdown", label: "Markdown", hint: ".md, .markdown" },
  { id: "web", label: "Web", hint: ".html, .xml, .css, .svg" },
  { id: "data", label: "Data and config", hint: ".json, .yaml, .toml, .ini, .csv, .log" },
  { id: "code", label: "Source code", hint: ".js, .ts, .py, .rs, .c, .java, .sh ..." },
  { id: "other", label: "Everything else", hint: "" },
];

const BY_EXTENSION: Record<string, FileType> = {};
const add = (type: FileType, list: string) => {
  for (const e of list.split(" ")) BY_EXTENSION[e] = type;
};
add("text", "txt text");
add("markdown", "md markdown mdown mkd mkdn");
add("web", "html htm xhtml xml svg css scss less vue svelte");
add("data", "json jsonc yaml yml toml csv tsv ini cfg conf env log properties lock");
add(
  "code",
  "js mjs cjs ts tsx jsx py rs c h cpp hpp cc cs java go rb php sh bash zsh ps1 bat cmd sql swift kt lua pl r dart scala hs ex exs mdx",
);

/** Extension-less names that are code or config, not prose. */
const CODE_NAMES = new Set(["makefile", "dockerfile", "gemfile", "rakefile", "procfile", "vagrantfile", "justfile"]);

/** The type of a tab from its path (null = never saved). */
export function fileTypeOf(path: string | null): FileType {
  if (!path) return "untitled";
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return CODE_NAMES.has(name) ? "code" : name.startsWith(".") ? "data" : "text"; // ".gitignore" is config
  return BY_EXTENSION[name.slice(dot + 1)] ?? "other";
}

/** How the tokenizer reads a file: Markdown has code spans, fences and link targets to skip. */
export type TextKind = "text" | "markdown";

/** What a tab needs from spell check / autocorrect, or null for nothing. `types` is the saved on/off map. */
export function spellKindFor(path: string | null, types: Record<string, boolean>): TextKind | null {
  const type = fileTypeOf(path);
  if (!types[type]) return null;
  return type === "markdown" ? "markdown" : "text";
}

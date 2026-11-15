/** Names for the invisible characters shown by View > Show control characters. Pure. */

const NAMES: Record<number, string> = {
  0x00ad: "SHY", 0x061c: "ALM", 0x200b: "ZWSP", 0x200c: "ZWNJ", 0x200d: "ZWJ", 0x200e: "LRM", 0x200f: "RLM",
  0x2028: "LS", 0x2029: "PS", 0x202a: "LRE", 0x202b: "RLE", 0x202c: "PDF", 0x202d: "LRO", 0x202e: "RLO",
  0x2060: "WJ", 0x2066: "LRI", 0x2067: "RLI", 0x2068: "FSI", 0x2069: "PDI", 0xfeff: "BOM",
};

/** Short label for a code point: a known name, or "U+00XX" (C0/C1 controls and the rest). */
export function controlLabel(code: number): string {
  return NAMES[code] ?? `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Characters CodeMirror's default list misses (it has ZWSP, LRM, RLM, LRO, RLO, LRI, RLI, PDI, SHY, ALM, BOM and
 *  the C0/C1 controls): joiners, the other embeddings, FSI and the word-joiner / invisible operators. */
export const EXTRA_CONTROL_CHARS = /[‌‍‪‫‬⁨⁠-⁤]/;

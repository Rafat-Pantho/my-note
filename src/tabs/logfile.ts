/** Notepad's .LOG feature. Pure. A file whose first line is exactly `.LOG` gets a date and time line at the end
 * each time it is opened. */

/** First line exactly `.LOG` (case-sensitive, no spaces), ended by a line break or the end of the text. */
export function isLogFile(text: string): boolean {
  return text === ".LOG" || text.startsWith(".LOG\n") || text.startsWith(".LOG\r");
}

/** The text to append: a line break first unless the text already ends with one, then the stamp and a line break. */
export function logAppendix(text: string, stamp: string): string {
  const lead = text === "" || text.endsWith("\n") || text.endsWith("\r") ? "" : "\n";
  return `${lead}${stamp}\n`;
}

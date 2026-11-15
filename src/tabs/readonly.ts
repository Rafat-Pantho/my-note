/** Read-only decisions. Pure. */

/** A write error that means "this file cannot be written" (as opposed to a full disk or a vanished folder). */
export function isPermissionError(message: string): boolean {
  return /access is denied|permission denied|read-only|os error (5|13|30)\b/i.test(message);
}

/** What Save does for a tab: write in place, or ask for Save as first (the file is read-only). */
export function saveAction(t: { readOnly?: boolean; path: string | null }, saveAs: boolean): "write" | "offer-save-as" {
  return !saveAs && !!t.path && t.readOnly === true ? "offer-save-as" : "write";
}

/** Turning an accepted result into ONE document change. `planChange` decides where the text goes (pure);
 *  `changeSpec` wraps it as a single CodeMirror transaction that undo treats as its own step. */
import { isolateHistory } from "@codemirror/commands";
import type { TransactionSpec } from "@codemirror/state";
import type { DocLike } from "./scope.ts";

/** replace = swap the scope's text; below = after the scope's last line; append = right after the scope's
 *  last character (continuing it); cursor = at a position (used when the source text changed). */
export type Placement = "replace" | "below" | "append" | "cursor";

export interface Plan {
  from: number;
  to: number;
  insert: string;
}

export function planChange(
  doc: DocLike,
  scope: { from: number; to: number },
  placement: Placement,
  result: string,
  cursor = 0,
): Plan {
  switch (placement) {
    case "replace":
      return { from: scope.from, to: scope.to, insert: result };
    case "cursor": {
      const at = Math.min(Math.max(cursor, 0), doc.length);
      return { from: at, to: at, insert: result };
    }
    case "append": {
      const at = scope.to;
      const before = at > 0 ? doc.sliceString(at - 1, at) : "";
      // Continue the sentence: add a space unless the text ends in whitespace or the reply starts with
      // whitespace or closing punctuation.
      const needsSpace = before !== "" && !/\s/.test(before) && !/^[\s.,;:!?)\]}]/.test(result);
      return { from: at, to: at, insert: (needsSpace ? " " : "") + result };
    }
    case "below": {
      const text = doc.sliceString(0, doc.length);
      const body = result.replace(/\n+$/, "");
      if (text.length === 0) return { from: 0, to: 0, insert: body };
      // A selection that ends right after a line break belongs to the line before it.
      const end = scope.to > scope.from && text[scope.to - 1] === "\n" ? scope.to - 1 : scope.to;
      const nl = text.indexOf("\n", end);
      // The file's own final newline is not a line to insert before: that is the end of the file.
      const pos = nl < 0 || nl === text.length - 1 ? text.length : nl;
      if (pos === text.length) {
        // End of the file: one blank line between (the file's own final newline counts).
        return { from: pos, to: pos, insert: (text.endsWith("\n") ? "\n" : "\n\n") + body };
      }
      return { from: pos, to: pos, insert: `\n\n${body}\n` };
    }
  }
}

/** One transaction = one undo step (isolated from typing before and after), selecting the new text. */
export function changeSpec(plan: Plan, userEvent: string): TransactionSpec {
  return {
    changes: { from: plan.from, to: plan.to, insert: plan.insert },
    selection: { anchor: plan.from, head: plan.from + plan.insert.length },
    scrollIntoView: true,
    userEvent,
    annotations: isolateHistory.of("full"),
  };
}

/** Minimal word-level diff (Myers' O(ND) algorithm) with no dependency. Lazy-loaded with the preview. Pure.
 *  Texts are cut into words, punctuation marks and whitespace runs; the result is a list of runs that are
 *  equal, deleted from `a` or inserted from `b`, in reading order. Concatenating the eq+del runs gives `a`
 *  back, and eq+ins gives `b` (tested). */

export type DiffOp = { t: "eq" | "del" | "ins"; s: string };

const TOKEN = /\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_]/gu;

export const tokenize = (s: string): string[] => s.match(TOKEN) ?? [];

/** Beyond this many edits the exact diff would use too much memory/time; we show a coarse one instead. */
const MAX_EDITS = 1500;

/** Edit script between two token arrays, in forward order: 0 = equal token, -1 = delete a[i], 1 = insert b[j].
 *  Returns null if the texts differ by more than MAX_EDITS tokens. */
function myers(a: string[], b: string[]): number[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = []; // v as it was before each round (<= MAX_EDITS rounds of a few KB)
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, d, off);
    }
  }
  return null;
}

/** Walks the saved rounds backwards to rebuild the path. */
function backtrack(trace: Int32Array[], n: number, m: number, dEnd: number, off: number): number[] {
  const steps: number[] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      steps.push(0);
      x--;
      y--;
    }
    steps.push(x === prevX ? 1 : -1);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    steps.push(0);
    x--;
    y--;
  }
  return steps.reverse();
}

/** Word-level diff of `a` (original) against `b` (result). */
export function diffWords(a: string, b: string): DiffOp[] {
  if (a === b) return a ? [{ t: "eq", s: a }] : [];
  const ta = tokenize(a);
  const tb = tokenize(b);
  let start = 0;
  while (start < ta.length && start < tb.length && ta[start] === tb[start]) start++;
  let endA = ta.length;
  let endB = tb.length;
  while (endA > start && endB > start && ta[endA - 1] === tb[endB - 1]) {
    endA--;
    endB--;
  }
  const ma = ta.slice(start, endA);
  const mb = tb.slice(start, endB);

  const ops: DiffOp[] = [];
  const push = (t: DiffOp["t"], s: string) => {
    if (!s) return;
    const last = ops[ops.length - 1];
    if (last && last.t === t) last.s += s;
    else ops.push({ t, s });
  };
  push("eq", ta.slice(0, start).join(""));

  const steps = ma.length && mb.length ? myers(ma, mb) : null;
  if (steps) {
    let i = 0;
    let j = 0;
    // Deletions before insertions inside one changed block reads naturally ("old new").
    let dels = "";
    let inss = "";
    const flush = () => {
      push("del", dels);
      push("ins", inss);
      dels = inss = "";
    };
    for (const s of steps) {
      if (s === 0) {
        flush();
        push("eq", ma[i]);
        i++;
        j++;
      } else if (s < 0) dels += ma[i++];
      else inss += mb[j++];
    }
    flush();
  } else {
    // One side empty, or too different for an exact diff: show it as a replacement.
    push("del", ma.join(""));
    push("ins", mb.join(""));
  }
  push("eq", ta.slice(endA).join(""));
  return ops;
}

/** Words added and removed, for a one-line summary like "+12 words, -5 words". */
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  const count = (s: string) => tokenize(s).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.t === "ins") added += count(o.s);
    else if (o.t === "del") removed += count(o.s);
  }
  return { added, removed };
}

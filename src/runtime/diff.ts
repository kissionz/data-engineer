/**
 * Minimal Myers diff implementation producing standard unified diff output.
 * No external dependencies.
 */

export interface DiffOptions {
  /** Number of context lines around each hunk (default: 3). */
  context?: number;
}

interface Edit {
  type: "equal" | "insert" | "delete";
  oldIndex: number;
  newIndex: number;
  line: string;
}

/**
 * Compute a unified diff between two strings.
 * Returns an empty string if the texts are identical.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  filePath: string,
  options: DiffOptions = {},
): string {
  const contextLines = options.context ?? 3;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const edits = myersDiff(oldLines, newLines);

  if (edits.every((e) => e.type === "equal")) {
    return "";
  }

  const hunks = buildHunks(edits, contextLines);

  const header = [`--- a/${filePath}`, `+++ b/${filePath}`];
  const output: string[] = [...header];

  for (const hunk of hunks) {
    output.push(formatHunkHeader(hunk));
    for (const edit of hunk.edits) {
      switch (edit.type) {
        case "equal":
          output.push(` ${edit.line}`);
          break;
        case "delete":
          output.push(`-${edit.line}`);
          break;
        case "insert":
          output.push(`+${edit.line}`);
          break;
      }
    }
  }

  return output.join("\n");
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  edits: Edit[];
}

function formatHunkHeader(hunk: Hunk): string {
  return `@@ -${hunk.oldStart + 1},${hunk.oldCount} +${hunk.newStart + 1},${hunk.newCount} @@`;
}

function buildHunks(edits: Edit[], context: number): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;

  while (i < edits.length) {
    // Skip equal lines until we find a change
    if (edits[i].type === "equal") {
      i += 1;
      continue;
    }

    // Found a change. Back up for context.
    const contextStart = Math.max(0, i - context);
    let j = i;

    // Find the end of contiguous changes (with possible gaps < 2*context)
    while (j < edits.length) {
      if (edits[j].type !== "equal") {
        j += 1;
        continue;
      }
      // Count how many equal lines follow
      let equalRun = 0;
      let k = j;
      while (k < edits.length && edits[k].type === "equal") {
        equalRun += 1;
        k += 1;
      }
      if (equalRun > context * 2 || k >= edits.length) {
        break;
      }
      j = k;
    }

    const contextEnd = Math.min(edits.length, j + context);
    const hunkEdits = edits.slice(contextStart, contextEnd);

    let oldCount = 0;
    let newCount = 0;
    let oldStart = 0;
    let newStart = 0;

    if (hunkEdits.length > 0) {
      oldStart = hunkEdits[0].oldIndex;
      newStart = hunkEdits[0].newIndex;
    }

    for (const edit of hunkEdits) {
      if (edit.type === "equal" || edit.type === "delete") {
        oldCount += 1;
      }
      if (edit.type === "equal" || edit.type === "insert") {
        newCount += 1;
      }
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, edits: hunkEdits });
    i = contextEnd;
  }

  return hunks;
}

/**
 * Myers diff algorithm (linear space, O(ND) time).
 * Returns a sequence of Edit operations.
 */
function myersDiff(oldLines: string[], newLines: string[]): Edit[] {
  const N = oldLines.length;
  const M = newLines.length;
  const MAX = N + M;

  if (MAX === 0) {
    return [];
  }

  // Shortcut: identical
  if (N === M && oldLines.every((line, i) => line === newLines[i])) {
    return oldLines.map((line, i) => ({
      type: "equal" as const,
      oldIndex: i,
      newIndex: i,
      line,
    }));
  }

  // V[k] stores the furthest-reaching x on diagonal k
  const V: Map<number, number>[] = [];
  const trace: Map<number, number>[] = [];

  let found = false;

  for (let d = 0; d <= MAX; d += 1) {
    const v = new Map<number, number>();
    const prev = d > 0 ? V[d - 1] : new Map<number, number>();

    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (prev.get(k - 1) ?? -1) < (prev.get(k + 1) ?? 0))) {
        x = prev.get(k + 1) ?? 0; // move down
      } else {
        x = (prev.get(k - 1) ?? 0) + 1; // move right
      }

      let y = x - k;

      // Follow diagonal (equal lines)
      while (x < N && y < M && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }

      v.set(k, x);

      if (x >= N && y >= M) {
        trace.push(v);
        found = true;
        break;
      }
    }

    if (found) break;
    V.push(v);
    trace.push(v);
  }

  // Backtrack to find the actual edit script
  const edits: Edit[] = [];
  let x = N;
  let y = M;

  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d -= 1) {
    const k = x - y;
    const prev = d > 0 ? trace[d - 1] : new Map<number, number>();

    let prevK: number;
    if (k === -d || (k !== d && (prev.get(k - 1) ?? -1) < (prev.get(k + 1) ?? 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = prev.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    // Diagonal moves (equal)
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      edits.unshift({ type: "equal", oldIndex: x, newIndex: y, line: oldLines[x] });
    }

    if (d > 0) {
      if (x === prevX) {
        // Insertion
        y -= 1;
        edits.unshift({ type: "insert", oldIndex: x, newIndex: y, line: newLines[y] });
      } else {
        // Deletion
        x -= 1;
        edits.unshift({ type: "delete", oldIndex: x, newIndex: y, line: oldLines[x] });
      }
    }
  }

  return edits;
}

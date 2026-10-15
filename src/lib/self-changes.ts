/**
 * What the AI has changed about *this* app — and how a person gets it in.
 *
 * The mirror in the AI Builder's sandbox is the one place the hub is asked to
 * change **itself**: the
 * pages, the styling and the behaviour of the thing somebody is looking at,
 * rather than a new app beside it. A browser cannot write to the project on
 * disk — this app runs in a tab, and a tab cannot save its own source — so a
 * change travels in two halves:
 *
 *  * **the change itself.** The hub's own builder writes the files it changes
 *    onto its bench, which is a real filesystem built out of rows
 *    (`convex/workspace.ts`), and `api.backup.changed` reads that bench back
 *    against the shipped snapshot: the paths that are part of this app and no
 *    longer match how it shipped. That is the *only* place a change to this app
 *    is ever recorded, and it is what a backup merges over the shipped copy.
 *  * **the way out.** Files in a database are not a fixed app. This module is
 *    the second half: it turns the list into something a person can act on — a
 *    readable diff of each changed file, a patch to copy, exactly which files
 *    to carry, and a name for the archive of them.
 *
 * Everything here is plain functions over text: no React, no IndexedDB, no
 * network. That is what lets `bun scripts/this-app-check.ts` walk the whole of
 * it end to end.
 */

/** One line of a diff, as a reader wants to see it. */
export type DiffLine = {
  kind: "same" | "add" | "del" | "gap";
  text: string;
};

export type Diff = {
  lines: DiffLine[];
  /** Lines the change added, counted over the whole change, clipping or not. */
  added: number;
  /** Lines the change took away, counted the same way. */
  removed: number;
  /** True when there is no change at all — the two texts are identical. */
  same: boolean;
  /** True when the middle was left out to keep the reading short. */
  clipped: boolean;
};

/**
 * A line diff, as the window around what changed.
 *
 * This is deliberately **not** a full LCS: the files this app is made of run to
 * thousands of lines, and the table a real diff needs between two of them is
 * millions of cells — computed in a browser tab, every time somebody expands a
 * row. What is here instead is the shape an edit actually has: the lines both
 * versions share at the top, the lines they share at the bottom, and the change
 * in between, shown with a little context either side.
 *
 * It is honest about the trade that costs: if a file changed in two places far
 * apart, the whole span between them reads as changed, because that is the one
 * window being shown. A change that reaches a whole file is clamped rather than
 * pasted out line by line, and says so.
 */
export function diffLines(
  before: string,
  after: string,
  options: { context?: number; maxLines?: number } = {},
): Diff {
  const context = Math.max(0, options.context ?? 3);
  const maxLines = Math.max(2, options.maxLines ?? 400);
  const a = before.split("\n");
  const b = after.split("\n");

  if (before === after) {
    const head = a.slice(0, Math.min(a.length, 12));
    return {
      lines: head.map((text): DiffLine => ({ kind: "same", text })),
      added: 0,
      removed: 0,
      same: true,
      clipped: a.length > head.length,
    };
  }

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA -= 1;
    tailB -= 1;
  }

  const added = tailB - head;
  const removed = tailA - head;

  const lines: DiffLine[] = [];
  for (let i = Math.max(0, head - context); i < head; i += 1) {
    lines.push({ kind: "same", text: a[i] });
  }
  for (let i = head; i < tailA; i += 1) lines.push({ kind: "del", text: a[i] });
  for (let i = head; i < tailB; i += 1) lines.push({ kind: "add", text: b[i] });
  for (let i = tailA; i < Math.min(a.length, tailA + context); i += 1) {
    lines.push({ kind: "same", text: a[i] });
  }

  if (lines.length <= maxLines) {
    return { lines, added, removed, same: false, clipped: false };
  }

  // Keep both ends of the change and say plainly what is missing, rather than
  // handing a component four hundred lines of a rewrite to draw.
  const half = Math.floor(maxLines / 2);
  const shown: DiffLine[] = [
    ...lines.slice(0, half),
    {
      kind: "gap",
      text: `… ${lines.length - maxLines} more line(s) of this change`,
    },
    ...lines.slice(lines.length - half),
  ];

  return { lines: shown, added, removed, same: false, clipped: true };
}

/**
 * A diff as a patch anybody can apply: one file, one hunk, git's own shape.
 *
 * `null` when the change is too large to be a patch worth pasting — a patch
 * that has to be clamped cannot be applied, and one that silently cannot apply
 * is worse than none. The caller says so and offers the files instead.
 */
export function patchText(
  path: string,
  before: string,
  after: string,
  options: { context?: number; maxLines?: number } = {},
): string | null {
  const context = Math.max(0, options.context ?? 3);
  const maxLines = Math.max(2, options.maxLines ?? 800);
  if (before === after) return null;

  const a = before.split("\n");
  const b = after.split("\n");

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA -= 1;
    tailB -= 1;
  }

  if (tailA - head + (tailB - head) > maxLines) return null;

  // The lines above the change are the same in both files, so one start index
  // serves both sides of the hunk; each side ends a different number of lines
  // later, which is exactly what the counts in the header say.
  const start = Math.max(0, head - context);
  const endA = Math.min(a.length, tailA + context);
  const endB = Math.min(b.length, tailB + context);

  const body: string[] = [];
  for (let i = start; i < head; i += 1) body.push(` ${a[i]}`);
  for (let i = head; i < tailA; i += 1) body.push(`-${a[i]}`);
  for (let i = head; i < tailB; i += 1) body.push(`+${b[i]}`);
  for (let i = tailA; i < endA; i += 1) body.push(` ${a[i]}`);

  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start + 1},${endA - start} +${start + 1},${endB - start} @@`,
    ...body,
  ].join("\n");
}

/**
 * Exactly the files that changed, taken out of a whole-bench export.
 *
 * The export hands over every file on the bench; only some of them are this
 * app. Filtering by the paths `api.backup.changed` named is what keeps a
 * scratch file, a note or a test the AI wrote for itself out of the archive a
 * person is about to carry into their project.
 */
export function changedBundle(
  exported: { path: string; content: string }[],
  paths: readonly string[],
): { path: string; content: string }[] {
  const wanted = new Set(paths);
  return exported
    .filter((file) => wanted.has(file.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The name of the archive those files are saved as. */
export function changesZipName(at: string | number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "this-app-changes";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `this-app-changes-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}`;
}

/** How a change reads in one line, for the box's own header. */
export function changeSummary(input: {
  files: number;
  added: number;
  removed: number;
}): string {
  if (!input.files) return "Nothing about this app has been changed yet.";
  const files = `${input.files} file${input.files === 1 ? "" : "s"}`;
  return `${files} changed — ${input.added} line${
    input.added === 1 ? "" : "s"
  } added, ${input.removed} line${input.removed === 1 ? "" : "s"} removed.`;
}

/** The patch for a whole change, or null the moment one file is too big. */
export function changePatch(
  files: { path: string; before: string; after: string }[],
): string | null {
  const parts: string[] = [];
  for (const file of files) {
    const patch = patchText(file.path, file.before, file.after);
    if (patch === null) return null;
    parts.push(patch);
  }
  return parts.length ? `${parts.join("\n\n")}\n` : null;
}

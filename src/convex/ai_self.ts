/**
 * The builder reading — and patching — its own source.
 *
 * `self_source.ts` is a snapshot shipped to the backend by
 * `bun run snapshot:self`. Everything here works on that copy and never on the
 * live project, so every answer says which snapshot it came from and that the
 * person still has to apply anything it changes.
 */
import { SELF_SNAPSHOT_AT, SELF_SOURCE } from "./self_source";

const OWN_SOURCE = SELF_SOURCE;
const OWN_PATHS = Object.keys(OWN_SOURCE).sort();

/** How much of one file to hand back, so a single read cannot flood the context. */
const OWN_READ_CHARS = 32_000;
const OWN_READ_LINES = 900;

/** A path short enough for the one-line note under a reply. */
export function shortPath(path: string) {
  return path.length > 48 ? `…${path.slice(-47)}` : path;
}

/**
 * Reading itself. Three modes, because that is how you actually look at code:
 * the index, one file (optionally a slice of a big one), or a grep.
 */
export function readOwnCode(
  path: string | null,
  search: string | null,
  from: number | null,
  to: number | null,
) {
  if (search) {
    const needle = search.toLowerCase();
    const hits: string[] = [];
    let truncated = false;

    for (const name of OWN_PATHS) {
      const lines = OWN_SOURCE[name].split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLowerCase().includes(needle)) continue;
        if (hits.length >= 160) {
          truncated = true;
          break;
        }
        hits.push(`${name}:${index + 1}: ${lines[index].trim().slice(0, 160)}`);
      }
      if (truncated) break;
    }

    return hits.length
      ? `My own source, snapshot taken ${SELF_SNAPSHOT_AT}. Lines matching “${search}”${truncated ? " (stopped at 160)" : ""}:\n${hits.join("\n")}\n\nRead one in full with read_own_code and its path.`
      : `My own source, snapshot taken ${SELF_SNAPSHOT_AT}. Nothing matches “${search}”.`;
  }

  if (!path) {
    return `My own source — a snapshot taken ${SELF_SNAPSHOT_AT}, ${OWN_PATHS.length} files. It is a copy, not the live project, so say so rather than calling it current.\n${OWN_PATHS.join(
      "\n",
    )}\n\nRead one with {"tool":"read_own_code","path":"src/convex/ai.ts"}, page a big one with "from" and "to", or grep them all with {"tool":"read_own_code","search":"some text"}.`;
  }

  const wanted = path.trim().replace(/^\.\//, "");
  const exact = OWN_SOURCE[wanted];

  if (!exact) {
    const near = OWN_PATHS.filter((name) => name.includes(wanted)).slice(0, 8);
    return near.length
      ? `There is no ${wanted} in my own source. Did you mean one of these?\n${near.join("\n")}`
      : `There is no ${wanted} in my own source. Call read_own_code with no path to see all of it.`;
  }

  const lines = exact.split("\n");
  const start = from ? Math.min(from - 1, lines.length) : 0;
  const end = to ? Math.min(to, lines.length) : lines.length;
  let slice = lines.slice(start, end).join("\n");
  let clipped = "";

  if (slice.length > OWN_READ_CHARS || end - start > OWN_READ_LINES) {
    slice = slice
      .slice(0, OWN_READ_CHARS)
      .split("\n")
      .slice(0, OWN_READ_LINES)
      .join("\n");
    clipped = `\n\n… clipped. ${wanted} is ${lines.length} lines. Ask again with "from" and "to" for the rest.`;
  }

  return `My own ${wanted}, lines ${start + 1}-${Math.min(
    end,
    lines.length,
  )} of ${lines.length}, snapshot taken ${SELF_SNAPSHOT_AT}:\n\n${slice}${clipped}`;
}

/** The smallest honest picture of a change: the lines around it, marked. */
function hunkDiff(before: string, after: string) {
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

  const context = 3;
  const out: string[] = [];

  for (let i = Math.max(0, head - context); i < head; i += 1) {
    out.push(`  ${a[i]}`);
  }
  for (let i = head; i < tailA; i += 1) out.push(`- ${a[i]}`);
  for (let i = head; i < tailB; i += 1) out.push(`+ ${b[i]}`);
  for (let i = tailA; i < Math.min(a.length, tailA + context); i += 1) {
    out.push(`  ${a[i]}`);
  }

  return out.join("\n").slice(0, 12_000);
}

/**
 * Apply the builder's change to its own source — inside the copy it can see,
 * never in the real project. The fixed file is saved onto its bench so the
 * person can take it and put it back where it belongs.
 */
export function patchOwnCode(path: string, search: string, replace: string) {
  const wanted = path.trim().replace(/^\.\//, "");
  const before = OWN_SOURCE[wanted];

  if (!before) {
    const near = OWN_PATHS.filter((name) => name.includes(wanted)).slice(0, 8);
    return {
      ok: false as const,
      message: near.length
        ? `There is no ${wanted} in my own source. Did you mean one of these?\n${near.join("\n")}`
        : `There is no ${wanted} in my own source. Call read_own_code with no path to see all of it.`,
    };
  }

  let count = 0;
  let at = -1;
  let cursor = 0;

  for (;;) {
    const found = before.indexOf(search, cursor);
    if (found < 0) break;
    count += 1;
    if (count === 1) at = found;
    cursor = found + Math.max(1, search.length);
  }

  if (count === 0) {
    return {
      ok: false as const,
      message: `That text is not in ${wanted}, so nothing changed. "search" has to match character for character, whitespace included — read the file and copy the exact lines.`,
    };
  }

  if (count > 1) {
    return {
      ok: false as const,
      message: `That text appears ${count} times in ${wanted}, so I cannot tell which one you mean. Include more of the surrounding lines so it is unique.`,
    };
  }

  const after = before.slice(0, at) + replace + before.slice(at + search.length);

  return {
    ok: true as const,
    path: wanted,
    content: after,
    message: `Changed ${wanted} in the snapshot. This is the copy, not the live project — the person still has to apply it. Diff:\n\n${hunkDiff(
      before,
      after,
    )}`,
  };
}

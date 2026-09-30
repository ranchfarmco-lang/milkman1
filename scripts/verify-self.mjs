/**
 * Targeted checks for the AI Builder's ability to read and repair its own code.
 *
 *   bun run verify:self
 *
 * The builder is told to fix bugs in this app, but it runs inside Convex with no
 * filesystem, so it works from `src/convex/self_source.ts` — a copy of the
 * project packed there by `bun run snapshot:self`. Two things can quietly break:
 *
 *   1. the read/patch helpers (`readOwnCode`, `patchOwnCode` in
 *      `src/convex/ai_self.ts`)
 *      could stop finding files, mis-count line numbers, or apply an edit in the
 *      wrong place, and the builder would confidently report nonsense;
 *   2. the snapshot could go stale, so the builder is reading last week's code.
 *
 * (2) is the failure nobody notices, so it is checked file-by-file against the
 * real tree. That means editing a covered file — including this script —
 * requires re-running `bun run snapshot:self` before this passes again.
 */

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { SELF_SNAPSHOT_AT, SELF_SOURCE } from "../src/convex/self_source.ts";
import { readOwnCode, patchOwnCode } from "../src/convex/ai_self.ts";
import { cleanPath } from "../src/convex/workspace.ts";
import { collectFiles } from "./snapshot-self.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}\n    ${error instanceof Error ? error.message : error}`);
  }
}

const asLines = (text) => text.split("\n");
const rel = (absolute) => relative(ROOT, absolute).split(sep).join("/");

/* --- 1. Paths on the bench cannot escape the bench ------------------------ */

check("cleanPath keeps a plain path", () => {
  assert.equal(cleanPath("app/main.py"), "app/main.py");
});

check("cleanPath drops ./ and duplicate slashes", () => {
  assert.equal(cleanPath("./a//b/./c"), "a/b/c");
});

check("cleanPath cannot climb above the root", () => {
  assert.equal(cleanPath("../../etc/passwd"), "etc/passwd");
  assert.equal(cleanPath("a/../../b"), "b");
  assert.equal(cleanPath(".."), "");
});

check("cleanPath normalises windows separators", () => {
  assert.equal(cleanPath("a\\b\\c.txt"), "a/b/c.txt");
});

check("cleanPath survives empty and absurd input", () => {
  assert.equal(cleanPath("   "), "");
  assert.equal(cleanPath("/".repeat(50)), "");
  assert.equal(cleanPath("x".repeat(500)).length, 80);
});

/* --- 2. Reading its own source -------------------------------------------- */

const SELF_PATH = "src/convex/ai.ts";
const SELF_TEXT = SELF_SOURCE[SELF_PATH];

check("the self-read helpers are real functions", () => {
  assert.equal(typeof readOwnCode, "function");
  assert.equal(typeof patchOwnCode, "function");
});

check("no arguments lists every snapshot file", () => {
  const out = readOwnCode(null, null, null, null);
  const names = Object.keys(SELF_SOURCE);
  assert.match(out, /snapshot taken/);
  assert.ok(out.includes(SELF_SNAPSHOT_AT), "should state when the snapshot was taken");
  for (const name of names) {
    assert.ok(out.includes(name), `index is missing ${name}`);
  }
});

check("a path returns that file with real line numbers", () => {
  const out = readOwnCode(SELF_PATH, null, null, null);
  const lines = asLines(SELF_TEXT);
  assert.ok(out.includes(`My own ${SELF_PATH}, lines 1-${lines.length} of ${lines.length}`));
  assert.ok(out.includes(lines[0]), "first line should be in the returned slice");
  assert.ok(out.includes(lines[7].trim()) || out.includes(lines[7]), "line 8 should be present");
});

check("from/to returns exactly that window", () => {
  const lines = asLines(SELF_TEXT);
  const out = readOwnCode(SELF_PATH, null, 12, 18);
  assert.ok(out.includes("lines 12-18 of"), `wrong header: ${out.slice(0, 120)}`);
  const body = out.split(":\n\n")[1];
  assert.equal(body, lines.slice(11, 18).join("\n"));
});

check("an out-of-range slice clamps instead of throwing", () => {
  const lines = asLines(SELF_TEXT);
  const out = readOwnCode(SELF_PATH, null, lines.length + 500, lines.length + 900);
  assert.ok(out.includes(`of ${lines.length}`));
});

check("a near-miss path suggests the real one", () => {
  const out = readOwnCode("convex/ai.ts", null, null, null);
  assert.match(out, /There is no convex\/ai\.ts/);
  assert.ok(out.includes(SELF_PATH), "should suggest the full path");
});

check("an unknown path says so and points at the index", () => {
  const out = readOwnCode("src/convex/zzz-nothing.ts", null, null, null);
  assert.match(out, /There is no src\/convex\/zzz-nothing\.ts/);
  assert.match(out, /read_own_code with no path/);
});

check("a search reports the right file and line for every hit", () => {
  const needle = "GROQ_API_KEY";
  const out = readOwnCode(null, needle, null, null);
  assert.match(out, new RegExp(`Lines matching`));

  const hits = out.split("\n").filter((line) => /:\d+: /.test(line) && !line.startsWith("Lines"));
  assert.ok(hits.length > 0, `no hits for ${needle}`);

  for (const hit of hits) {
    const match = /^(.*?):(\d+): (.*)$/.exec(hit);
    assert.ok(match, `unparseable hit: ${hit}`);
    const [, path, lineNo, text] = match;
    const source = SELF_SOURCE[path];
    assert.ok(source, `hit names a file that is not in the snapshot: ${path}`);
    assert.equal(
      text,
      asLines(source)[Number(lineNo) - 1].trim().slice(0, 160),
      `line ${lineNo} of ${path} does not match the snapshot`,
    );
  }
});

// Assembled at runtime: this file is part of the snapshot, so a literal needle
// would find itself and the check would be meaningless.
const ABSENT = ["zzz", "no", "such", "identifier"].join("_");

check("a search with no matches says so plainly", () => {
  assert.equal(SELF_SOURCE["scripts/verify-self.mjs"].includes(ABSENT), false);
  const out = readOwnCode(null, ABSENT, null, null);
  assert.match(out, /Nothing matches/);
});

/* --- 3. Patching its own source ------------------------------------------- */

/** A single line of a real file, chosen because it appears exactly once. */
function uniqueLine(path) {
  const lines = asLines(SELF_SOURCE[path]);
  const line = lines.find(
    (candidate) =>
      candidate.includes("export const systems = query(") &&
      lines.filter((other) => other === candidate).length === 1,
  );
  assert.ok(line, `could not find a unique anchor line in ${path}`);
  return line;
}

check("patching an unknown file changes nothing", () => {
  const result = patchOwnCode("src/convex/zzz-nothing.ts", "a", "b");
  assert.equal(result.ok, false);
  assert.match(result.message, /There is no src\/convex\/zzz-nothing\.ts/);
});

check("text that is not there is refused, character for character", () => {
  const result = patchOwnCode(SELF_PATH, "__no_such_snippet__", "x");
  assert.equal(result.ok, false);
  assert.match(result.message, /not in src\/convex\/ai\.ts/);
  assert.match(result.message, /character for character/);
});

check("an ambiguous match is refused instead of guessed", () => {
  const result = patchOwnCode(SELF_PATH, '"', "x");
  assert.equal(result.ok, false);
  assert.match(result.message, /appears \d+ times/);
  assert.match(result.message, /more of the surrounding lines/);
});

check("a unique match is applied, once, line for line", () => {
  const anchor = uniqueLine(SELF_PATH);
  const marker = " /* verified */";
  const result = patchOwnCode(SELF_PATH, anchor, anchor + marker);

  assert.equal(result.ok, true);
  assert.equal(result.path, SELF_PATH);
  assert.ok(result.content.includes(marker), "replacement should be in the result");

  const before = asLines(SELF_TEXT);
  const after = asLines(result.content);
  assert.equal(after.length, before.length, "a one-line edit should not change the line count");
  assert.equal(
    result.content.split(marker).join(""),
    SELF_TEXT,
    "the generated patch must be the original text with the marker inserted and nothing else",
  );
});

check("the diff shows the real before and after lines", () => {
  const anchor = uniqueLine(SELF_PATH);
  const marker = " /* verified */";
  const [, before] = /^(.*)$/m.exec(anchor) ?? [];
  const result = patchOwnCode(SELF_PATH, anchor, anchor + marker);
  assert.ok(result.message.includes(`- ${before}`), "diff is missing the removed line");
  assert.ok(
    result.message.includes(`+ ${before}${marker}`),
    "diff is missing the added line",
  );
  assert.match(result.message, /not the live project/);
});

check("a leading ./ is tolerated when naming a file", () => {
  const anchor = uniqueLine(SELF_PATH);
  const result = patchOwnCode(`./${SELF_PATH}`, anchor, anchor);
  assert.equal(result.ok, true);
  assert.equal(result.path, SELF_PATH);
  assert.equal(result.content, SELF_TEXT, "an identity patch should change nothing");
});

/* --- 4. The snapshot is the real, current project ------------------------- */

const ON_DISK = (await collectFiles()).map(rel).sort();
const IN_SNAPSHOT = Object.keys(SELF_SOURCE).sort();

check("the snapshot was taken at a believable time", () => {
  const taken = Date.parse(SELF_SNAPSHOT_AT);
  assert.ok(Number.isFinite(taken), `SELF_SNAPSHOT_AT is not a date: ${SELF_SNAPSHOT_AT}`);
  assert.ok(taken <= Date.now() + 60_000, "snapshot is dated in the future");
});

check("the snapshot covers every file it should", () => {
  const missing = ON_DISK.filter((path) => !(path in SELF_SOURCE));
  assert.equal(
    missing.length,
    0,
    `not in the snapshot: ${missing.slice(0, 10).join(", ")} — run: bun run snapshot:self`,
  );
});

check("the snapshot has nothing left over from files since deleted", () => {
  const extra = IN_SNAPSHOT.filter((path) => !ON_DISK.includes(path));
  assert.equal(
    extra.length,
    0,
    `in the snapshot but not on disk: ${extra.slice(0, 10).join(", ")} — run: bun run snapshot:self`,
  );
});

const STALE = [];

for (const path of IN_SNAPSHOT) {
  if (!ON_DISK.includes(path)) continue;
  const info = await stat(join(ROOT, path)).catch(() => null);
  if (!info?.isFile()) continue;
  const onDisk = await readFile(join(ROOT, path), "utf8");
  if (onDisk !== SELF_SOURCE[path]) STALE.push(path);
}

check("every snapshotted file is byte-identical to the file on disk", () => {
  assert.equal(
    STALE.length,
    0,
    `stale copy of: ${STALE.slice(0, 10).join(", ")} — run: bun run snapshot:self`,
  );
});

/* --- Report --------------------------------------------------------------- */

if (failures.length) {
  console.error(`\n${failures.length} failed, ${passed} passed:\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error("\nThe builder reads its own code from the snapshot — fix the above.\n");
  process.exit(1);
}

console.log(
  `\n✓ ${passed} checks passed — self-read, self-patch and snapshot (${IN_SNAPSHOT.length} files) are sound.\n`,
);

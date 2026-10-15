/**
 * Changing *this* app: the diff, the patch, and the way the change gets in.
 *
 * The mirror in the AI Builder's sandbox is the one place the hub is asked to
 * change itself, and it rests on two things that fail quietly if they are wrong:
 *
 *   1. **the reading** — `src/lib/self-changes.ts`. If the diff lies about what
 *      changed, or the patch it hands over cannot be applied, or the zip carries
 *      the whole bench instead of the changed files, a person carries the wrong
 *      thing into their project and believes the app is fixed.
 *   2. **the wiring** — the request has to reach the builder as *this app*, the
 *      changed list has to come from the one merge that a backup also uses, and
 *      the whole job has to be a box of the AI Builder page — the sandbox
 *      holding this project's own copy — rather than a page beside it. Each of
 *      those is a sentence somebody can delete without noticing.
 *   3. **the merge** — what a download actually carries. Every download in the
 *      hub is the app's own copy, and only work written *after* that copy was
 *      taken may ride on top; an older file left on the bench overwriting
 *      newer code in a download is the failure this section exists for.
 *   4. **the package** — the app baked into the offline brain. The brain is the
 *      download most people take, and it used to be the tools without the
 *      application; it now ships this app's own source archive, and every way
 *      out of the hub picks that archive up. An archive that stops being built,
 *      or a download that stops carrying it, is the failure here.
 *
 * So the first half walks the pure functions end to end, and the second reads
 * the files that hold the promise. The last checks are source checks on purpose,
 * in the same spirit as `scripts/builder-agent-check.ts`: "there is only one of
 * this" is exactly the property an innocuous-looking edit can quietly undo.
 *
 * Run with: bun scripts/this-app-check.ts
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { carryBenchFiles } from "../src/convex/backup";
import { SELF_OMITTED, SELF_SOURCE } from "../src/convex/self_source";
import { readableSize } from "../src/lib/download";
import {
  FILE_SIZES,
  FULL_PACKAGE,
  FULL_PACKAGE_SIZE,
} from "../src/lib/offline-brain";
import { buildSelfInstaller, bytesToBase64 } from "../src/lib/offline-bundle";
import {
  PACKAGE_BINARY_FILES,
  PACKAGE_FILES,
  installerBytes,
  measuredBytes,
  type PackageMeasure,
} from "../src/lib/offline-brain-files";
import {
  changePatch,
  changeSummary,
  changedBundle,
  changesZipName,
  diffLines,
  patchText,
} from "../src/lib/self-changes";

const ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures += 1;
}

const read = (path: string) => readFile(join(ROOT, path), "utf8");

/* ------------------------------------------------------------- the diff */

const BEFORE = [
  "export function greet(name: string) {",
  "  return `Hello, ${name}`;",
  "}",
  "",
  "export const VERSION = 1;",
].join("\n");

check(
  "identical text is no change at all",
  (() => {
    const diff = diffLines(BEFORE, BEFORE);
    return diff.same && diff.added === 0 && diff.removed === 0;
  })(),
);

check(
  "a changed line is one removal and one addition, with the lines around it",
  (() => {
    const after = BEFORE.replace("Hello,", "Hi,");
    const diff = diffLines(BEFORE, after);
    const added = diff.lines.filter((line) => line.kind === "add");
    const removed = diff.lines.filter((line) => line.kind === "del");
    return (
      !diff.same &&
      diff.added === 1 &&
      diff.removed === 1 &&
      added[0]?.text.includes("Hi,") === true &&
      removed[0]?.text.includes("Hello,") === true &&
      diff.lines.some((line) => line.kind === "same")
    );
  })(),
);

check(
  "an added line counts as added, never as removed",
  (() => {
    const after = BEFORE.replace(
      "export const VERSION = 1;",
      "export const VERSION = 2;\nexport const NAME = 'hub';",
    );
    const diff = diffLines(BEFORE, after);
    return diff.added === 2 && diff.removed === 1;
  })(),
);

check(
  "a deleted line counts as removed, and takes nothing with it",
  (() => {
    const after = BEFORE.split("\n")
      .filter((line) => line !== "}")
      .join("\n");
    const diff = diffLines(BEFORE, after);
    return diff.removed === 1 && diff.added === 0;
  })(),
);

check(
  "the diff is honest: what it shows rebuilds both files",
  (() => {
    // A diff a person reads must be able to produce *both* versions, or it is
    // describing a change nobody can carry out. Context lines plus the removal
    // block are the before; context plus the addition block are the after.
    const after = BEFORE.replace("VERSION = 1", "VERSION = 42").replace(
      "greet",
      "sayHello",
    );
    const diff = diffLines(BEFORE, after);
    const before = diff.lines
      .filter((line) => line.kind === "same" || line.kind === "del")
      .map((line) => line.text)
      .join("\n");
    const rebuilt = diff.lines
      .filter((line) => line.kind === "same" || line.kind === "add")
      .map((line) => line.text)
      .join("\n");
    return before === BEFORE && rebuilt === after;
  })(),
);

check(
  "a whole-file change is clamped, and says so",
  (() => {
    const before = Array.from({ length: 900 }, (_, i) => `old line ${i}`).join(
      "\n",
    );
    const after = Array.from({ length: 900 }, (_, i) => `new line ${i}`).join(
      "\n",
    );
    const diff = diffLines(before, after, { maxLines: 60 });
    return (
      diff.clipped &&
      diff.lines.length === 61 &&
      diff.lines.some((line) => line.kind === "gap") &&
      diff.added === 900 &&
      diff.removed === 900
    );
  })(),
);

check(
  "clamping never changes the counts",
  (() => {
    const before = "a\nb\nc\nd\ne";
    const after = "a\nB\nc\nD\ne";
    const whole = diffLines(before, after, { maxLines: 100 });
    const cut = diffLines(before, after, { maxLines: 4 });
    return whole.added === cut.added && whole.removed === cut.removed;
  })(),
);

/* ------------------------------------------------------------ the patch */

check(
  "an unchanged file has no patch to hand over",
  patchText("src/a.ts", BEFORE, BEFORE) === null,
);

check(
  "the patch names both sides of the file, and holds one hunk",
  (() => {
    const after = BEFORE.replace("VERSION = 1", "VERSION = 2");
    const patch = patchText("src/a.ts", BEFORE, after);
    if (!patch) return false;
    const lines = patch.split("\n");
    return (
      lines[0] === "--- a/src/a.ts" &&
      lines[1] === "+++ b/src/a.ts" &&
      lines[2]?.startsWith("@@ -") === true &&
      lines.filter((line) => line.startsWith("@@")).length === 1 &&
      lines.includes("-export const VERSION = 1;") &&
      lines.includes("+export const VERSION = 2;")
    );
  })(),
);

check(
  "the patch's own counts match the lines it carries",
  (() => {
    // This is the property a patch tool checks before it applies anything: the
    // header has to describe the body exactly, or the patch is rejected.
    const after = BEFORE.replace("VERSION = 1", "VERSION = 2").replace(
      "  return",
      "  // say it\n  return",
    );
    const patch = patchText("src/lib/a.ts", BEFORE, after, { context: 3 });
    if (!patch) return false;
    const [header] = patch.split("\n").slice(2);
    const match = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(header ?? "");
    if (!match) return false;
    const body = patch.split("\n").slice(3);
    const olds = body.filter(
      (line) => line.startsWith(" ") || line.startsWith("-"),
    ).length;
    const news = body.filter(
      (line) => line.startsWith(" ") || line.startsWith("+"),
    ).length;
    return Number(match[2]) === olds && Number(match[4]) === news;
  })(),
);

check(
  "a patch that would have to be clamped is refused rather than faked",
  (() => {
    const before = Array.from({ length: 500 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 500 }, (_, i) => `new ${i}`).join("\n");
    return patchText("src/a.ts", before, after, { maxLines: 100 }) === null;
  })(),
);

check(
  "the whole change is one patch, file after file",
  (() => {
    const patch = changePatch([
      { path: "src/a.ts", before: "one\ntwo", after: "one\n2" },
      { path: "src/b.ts", before: "three", after: "three\nfour" },
    ]);
    return (
      patch !== null &&
      patch.includes("--- a/src/a.ts") &&
      patch.includes("--- a/src/b.ts") &&
      patch.indexOf("src/a.ts") < patch.indexOf("src/b.ts")
    );
  })(),
);

check(
  "one file too big refuses the whole patch, rather than half of one",
  (() => {
    const huge = Array.from({ length: 500 }, (_, i) => `old ${i}`).join("\n");
    const huger = Array.from({ length: 500 }, (_, i) => `new ${i}`).join("\n");
    return (
      changePatch([
        { path: "src/a.ts", before: "one", after: "two" },
        { path: "src/b.ts", before: huge, after: huger },
      ]) === null
    );
  })(),
);

/* ------------------------------------------------ carrying the files in */

const BENCH = [
  { path: "src/later.ts", content: "changed later" },
  { path: "src/components/BuilderMirror.tsx", content: "changed" },
  { path: "NOTES.md", content: "the AI's own notes — not part of the app" },
  { path: "src/convex/backup.ts", content: "changed too" },
];

check(
  "only the files the changed list names are carried",
  (() => {
    const bundle = changedBundle(BENCH, [
      "src/convex/backup.ts",
      "src/components/BuilderMirror.tsx",
    ]);
    // Which of the two comes out first is not the promise — that both of the
    // named files are carried, and nothing else is, is.
    return (
      bundle.length === 2 &&
      bundle.some((file) => file.path === "src/convex/backup.ts") &&
      bundle.some((file) => file.path === "src/components/BuilderMirror.tsx") &&
      bundle.every((file) => file.content.length > 0)
    );
  })(),
);

check(
  "…a scratch file the AI kept is left behind",
  changedBundle(BENCH, ["src/components/BuilderMirror.tsx"]).every(
    (file) => file.path !== "NOTES.md",
  ),
);

check(
  "…and a path with nothing on the bench simply carries nothing",
  changedBundle(BENCH, ["src/gone.ts"]).length === 0,
);

check(
  "the archive is named for the app and the day",
  changesZipName("2026-10-10T12:00:00.000Z") ===
    "this-app-changes-2026-10-10" &&
    changesZipName("not a date") === "this-app-changes",
);

check(
  "the header reads as a sentence, singular and plural",
  changeSummary({ files: 0, added: 0, removed: 0 }).startsWith("Nothing") &&
    changeSummary({ files: 1, added: 1, removed: 1 }) ===
      "1 file changed — 1 line added, 1 line removed." &&
    changeSummary({ files: 3, added: 12, removed: 4 }) ===
      "3 files changed — 12 lines added, 4 lines removed.",
);

/* ------------------------------------- what a download carries, and when */

// Every download in the hub — the Control Room's backups, the Offline Brain's
// editions — is built from the app's own copy with the builder's bench merged
// over it. The rule under test here is that only work *newer* than the copy
// rides on it: whatever is older than the app is older than the app, and a
// download must not hand back an old file under the current app's name.
const SHIPPED = {
  "src/a.ts": "one",
  "src/b.ts": "two",
  "src/pages/App.tsx": "three",
};
const TAKEN = Date.parse("2026-10-10T00:00:00.000Z");

const carried = carryBenchFiles(
  SHIPPED,
  [
    { path: "src/a.ts", content: "newer", updatedAt: TAKEN + 60_000 },
    { path: "src/b.ts", content: "older", updatedAt: TAKEN - 60_000 },
    { path: "src/pages/App.tsx", content: "three", updatedAt: TAKEN + 60_000 },
    { path: "NOTES.md", content: "scratch", updatedAt: TAKEN + 60_000 },
  ],
  TAKEN,
);

check(
  "work newer than the app's own copy rides on it",
  carried.files["src/a.ts"] === "newer" &&
    carried.patched.join(",") === "src/a.ts",
);
check(
  "an older working file never overwrites newer app code",
  carried.files["src/b.ts"] === "two" &&
    carried.superseded.join(",") === "src/b.ts",
);
check(
  "a working file that already matches is neither newer nor superseded",
  !carried.patched.includes("src/pages/App.tsx") &&
    !carried.superseded.includes("src/pages/App.tsx"),
);
check(
  "a scratch file the AI kept is never carried either way",
  !carried.patched.includes("NOTES.md") &&
    !carried.superseded.includes("NOTES.md"),
);
check(
  "an unreadable copy date carries nothing at all, rather than something older",
  carryBenchFiles(
    SHIPPED,
    [{ path: "src/a.ts", content: "newer", updatedAt: TAKEN }],
    Number.POSITIVE_INFINITY,
  ).patched.length === 0,
);

/* ---------------------- the sizes: measured, never remembered ---------- */

// The Offline Brain page prints a size beside every download. Those were
// written into the catalog on the day they were typed, so a page full of
// figures could stay identical while the files behind them changed — the exact
// way a person is told a download is current when it is not. The page now asks
// the hub for every packaged file when it opens and reads each size off the
// answer, and the installer's size is worked out from that measurement rather
// than remembered. These checks hold both halves up.
const measured: PackageMeasure = {
  files: 3,
  bytes: 4096,
  sizes: {
    "README.md": 1024,
    "brain/brain.py": 2048,
    "source/freebuff-source.zip": 1024,
  },
  missing: [],
  at: Date.parse("2026-10-10T12:00:00.000Z"),
};

check(
  "a total is only printed when every file in it answered",
  measuredBytes(measured, ["README.md", "brain/brain.py"]) === 3072 &&
    measuredBytes(measured, ["README.md", "nope.sh"]) === null &&
    measuredBytes(null, ["README.md"]) === null &&
    measuredBytes(measured, []) === null,
);

check(
  "the installer's size comes from the measurement, and is nothing without it",
  (() => {
    // A synthetic package: every text file 10 bytes, every archive 300. The
    // installer holds the text as it is, one newline per file it adds,
    const sizes = Object.fromEntries([
      ...PACKAGE_FILES.map((path) => [path, 10]),
      ...PACKAGE_BINARY_FILES.map((path) => [path, 300]),
    ]);
    const all: PackageMeasure = { ...measured, sizes, missing: [] };
    // …and the archives as base64 of their bytes together: four characters for
    // every three (300 each → four thirds of the total), wrapped at 76 columns,
    // one character per line break. Written out as the rule rather than as the
    // number it comes to, so a third archive does not quietly make this stale.
    const archiveBytes = 300 * PACKAGE_BINARY_FILES.length;
    const encoded = 4 * Math.ceil(archiveBytes / 3);
    const wrapped = encoded + Math.ceil(encoded / 76);
    const expected = PACKAGE_FILES.length * 10 + PACKAGE_FILES.length + wrapped;

    // One file missing is not "about this size" — it is a figure that would be
    // wrong, so nothing is printed at all.
    const withOneMissing: PackageMeasure = {
      ...all,
      sizes: { ...sizes, [PACKAGE_FILES[0]]: undefined } as Record<
        string,
        number
      >,
    };

    return (
      installerBytes(null) === null &&
      installerBytes(measured) === null &&
      installerBytes(withOneMissing) === null &&
      installerBytes(all) === expected
    );
  })(),
);

check(
  "the figure the page prints is the size of the installer you get, to the printed tenth of a megabyte",
  await (async () => {
    // The real package, the real script, the real bytes — measured the way the
    // page measures it (ask each file for its size) and then built the way a
    // download builds it. If the two ever stopped agreeing at the precision the
    // page prints, this fails.
    const files = [];
    const sizes: Record<string, number> = {};
    for (const path of PACKAGE_FILES) {
      const text = await read(`public/offline-brain/${path}`);
      files.push({ path, text });
      sizes[path] = Buffer.byteLength(text);
    }
    const archives = [];
    let binaryBytes = 0;
    for (const path of PACKAGE_BINARY_FILES) {
      const bytes = new Uint8Array(
        await readFile(join(ROOT, `public/offline-brain/${path}`)),
      );
      archives.push({ path, base64: bytesToBase64(bytes) });
      sizes[path] = bytes.length;
      binaryBytes += bytes.length;
    }
    const real = buildSelfInstaller(
      files,
      "recommended",
      "https://hub/",
      445,
      archives,
    );
    const estimate = installerBytes({
      files: Object.keys(sizes).length,
      bytes: Object.values(sizes).reduce((sum, n) => sum + n, 0),
      sizes,
      missing: [],
      at: Date.now(),
    });
    return (
      binaryBytes > 18_000_000 &&
      estimate !== null &&
      readableSize(estimate) === readableSize(Buffer.byteLength(real))
    );
  })(),
);

/* ------------------------------ the whole app, baked into the package --- */

// The offline brain used to be the tools without the application: the Python
// brain, every installer, and the reference implementation it was modelled on,
// while the app those tools belong to stayed behind on the hub. It now carries
// the app itself, baked in (`bun run snapshot:app` → `scripts/pack-this-app.mjs`),
// and the checks here hold both halves up: that the archive really is this app's
// own file set, and that the snapshot every Control Room download is built from
// is the whole app rather than most of it.
const APP_ARCHIVE = "source/this-app-source.zip";
const appArchiveBytes = await readFile(
  join(ROOT, "public", "offline-brain", APP_ARCHIVE),
).catch(() => null);

/** A zip keeps every entry's name uncompressed, so a name can be looked for. */
const inArchive = (bytes: Buffer, path: string) =>
  bytes.includes(Buffer.from(`app/${path}`, "utf8"));

check(
  "the package carries this app, not only the tools it was built with",
  PACKAGE_BINARY_FILES.includes(APP_ARCHIVE) &&
    PACKAGE_FILES.includes("scripts/capture-this-app.sh"),
  `${PACKAGE_FILES.length} text files + ${PACKAGE_BINARY_FILES.length} archives`,
);

check(
  "the archive is really built, and really a zip",
  appArchiveBytes !== null &&
    appArchiveBytes.length > 1_000_000 &&
    appArchiveBytes[0] === 0x50 &&
    appArchiveBytes[1] === 0x4b,
  appArchiveBytes
    ? readableSize(appArchiveBytes.length)
    : "public/offline-brain/source/this-app-source.zip is missing — run: bun run snapshot:app",
);

check(
  "…and it holds the whole app: every file the snapshot covers is inside it",
  appArchiveBytes !== null &&
    Object.keys(SELF_SOURCE).every((path) => inArchive(appArchiveBytes, path)),
  `${Object.keys(SELF_SOURCE).length} files checked`,
);

check(
  "…with the snapshot's two generated halves written in, so the copy builds",
  appArchiveBytes !== null &&
    inArchive(appArchiveBytes, "src/convex/self_source.ts") &&
    inArchive(appArchiveBytes, "public/self-source.json"),
);

check(
  "the snapshot the downloads are built from is the whole app, nothing omitted",
  SELF_OMITTED.length === 0 && Object.keys(SELF_SOURCE).length > 400,
  SELF_OMITTED.length
    ? `left out: ${SELF_OMITTED.slice(0, 5).join(", ")} — raise the cap or re-run: bun run snapshot:self`
    : `${Object.keys(SELF_SOURCE).length} files`,
);

/* ----------------------------------------------------- what it says it weighs --- */

// Every figure the Offline Brain page can print before the hub has answered comes
// from `FILE_SIZES`, and a figure that cannot move when the file does is how a
// page of labels goes on looking healthy while describing a package that changed
// months ago: the reference archive was listed at its real 18.9 MB, and fifteen
// smaller rows were stale by up to three kilobytes each.
//
// So the table is held to the files themselves, both ways: every packaged path
// has a figure, every figure names a packaged file, and the figure is what that
// file measures on disk — rounded the way the catalog writes it. The installer's
// own weight is held to the script that is really built, at the precision it is
// printed.

/** The catalog's way of writing a size: bytes whole, KB and MB to a tenth. */
function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PACKAGED = [...PACKAGE_FILES, ...PACKAGE_BINARY_FILES];
const unweighed = PACKAGED.filter((path) => !(path in FILE_SIZES));
const unknown = Object.keys(FILE_SIZES).filter(
  (path) => !PACKAGED.includes(path),
);

check(
  "every packaged file has a figure, and every figure names a packaged file",
  unweighed.length === 0 && unknown.length === 1 && unknown[0] === FULL_PACKAGE,
  `${unweighed.length} unweighed (${unweighed.slice(0, 4).join(", ")}), ` +
    `${unknown.length} naming nothing (${unknown.slice(0, 4).join(", ")})`,
);

const mismeasured: string[] = [];
for (const path of PACKAGED) {
  const info = await stat(join(ROOT, "public", "offline-brain", path)).catch(
    () => null,
  );
  if (!info) {
    mismeasured.push(`${path} is not on disk`);
    continue;
  }
  const says = FILE_SIZES[path];
  const is = sizeLabel(info.size);
  if (says !== is) mismeasured.push(`${path}: says ${says}, is ${is}`);
}

check(
  "every figure the catalog quotes is the size of the file on disk",
  mismeasured.length === 0,
  mismeasured.length ? mismeasured.slice(0, 5).join(" | ") : `${PACKAGED.length} files`,
);

// The one-file installer, built here for real from the files this hub serves.
const installerText = [];
for (const path of PACKAGE_FILES) {
  installerText.push({ path, text: await read(`public/offline-brain/${path}`) });
}
const installerArchives = [];
for (const path of PACKAGE_BINARY_FILES) {
  installerArchives.push({
    path,
    base64: bytesToBase64(
      new Uint8Array(await readFile(join(ROOT, "public", "offline-brain", path))),
    ),
  });
}
const realInstaller = buildSelfInstaller(
  installerText,
  "recommended",
  "https://hub/",
  445,
  installerArchives,
);
const realInstallerBytes = Buffer.byteLength(realInstaller);

check(
  "the installer's quoted weight is the installer that is really built",
  Number(FULL_PACKAGE_SIZE.replace(/[^0-9.]/g, "")) ===
    Math.round(realInstallerBytes / (1024 * 1024)),
  `${FULL_PACKAGE_SIZE} against ${readableSize(realInstallerBytes)} built here`,
);

// The second half of the same promise, one file further out: the archive has to
// survive being *saved* as well as served. Both ignore lists start from a rule
// that excludes every `.zip` — an archive left in the project root would
// otherwise be packed into the next archive, and the one after that — and each
// one has to name the app's own archive back in, or a clone, a push and a Docker
// build all quietly lack the thing every download button offers.
const ignoreLists = [
  await read(".gitignore"),
  await read(".dockerignore"),
];
check(
  "the app's own archive is kept in what is saved, cloned and built",
  ignoreLists.every((rules) =>
    rules.includes("!public/offline-brain/source/this-app-source.zip"),
  ),
  ignoreLists.filter(
    (rules) => !rules.includes("!public/offline-brain/source/this-app-source.zip"),
  ).length + " ignore list(s) would drop it",
);

/* ------------------------------------------- the promise, in the sources */

const page = await read("src/components/BuilderMirror.tsx");
const sandbox = await read("src/components/BuilderApps.tsx");
const routesFile = "src/pages/ThisApp.tsx";
const prompts = await read("src/convex/ai_prompts.ts");
const turn = await read("src/convex/ai_turn.ts");
const chat = await read("src/hooks/use-chat.ts");
const backup = await read("src/convex/backup.ts");
const routes = await read("src/main.tsx");
const shell = await read("src/pages/AppShell.tsx");
const controlRoom = await read("src/pages/ControlRoom.tsx");
const panel = await read("src/components/BuilderCrewPanel.tsx");
const actions = await read("src/lib/assistant-actions.ts");
const backupPanel = await read("src/components/BackupPanel.tsx");
const brainPage = await read("src/pages/OfflineBrain.tsx");
const brainCatalog = await read("src/lib/offline-brain.ts");
const brainBundles = await read("src/lib/brain-bundles.ts");

check(
  "the request goes to the hub's builder, as a change to this app",
  page.includes('useChat("builder", { focus: "self" })'),
);

check(
  "…and the turn carries that job to the prompt",
  turn.includes('focus: v.optional(v.literal("self"))') &&
    turn.includes('self: focus === "self"') &&
    chat.includes("respond({ room, context, focus })") &&
    // Both attempts: a retry that dropped the job would answer as a different
    // request than the one the person is making.
    chat.split("respond({ room, context, focus })").length === 3,
);

check(
  "the builder is told which app is meant, in its own words",
  prompts.includes("const SELF_APP_RULE") &&
    prompts.includes('${input.self ? `${SELF_APP_RULE}\\n\\n` : ""}') &&
    /request is about this app itself/.test(prompts),
);

check(
  "…including the honest half: nothing here reaches the running app",
  /never say the app is updated/.test(prompts) &&
    page.includes("never on the hub you are using"),
);

check(
  "…and where a new app belongs instead",
  prompts.includes("ask the crew on the AI Builder page instead") &&
    /which is where a new app is made/.test(prompts),
);

/* ---------------------- the job lives on the AI Builder page, not beside it */

check(
  "the mirror is a copy in the sandbox, and the copy is what proves a change",
  page.includes("useQuery(api.sandbox.state)") &&
    page.includes("useAction(api.sandbox.buildNow)") &&
    page.includes("buildCopy({ quick })") &&
    // Both presses: the typecheck-only one for while somebody is still
    // iterating, and the full build for the change about to be carried in.
    page.includes("run(true)") &&
    page.includes("run(false)"),
);

check(
  "…and the sandbox box holds both of the page's jobs, with a switch between",
  sandbox.includes('id="builder-preview"') &&
    sandbox.includes("<BuilderMirror />") &&
    sandbox.includes('target === "self"') &&
    sandbox.includes("Apps it made") &&
    sandbox.includes("This app — its mirror"),
);

check(
  "this app is a box of the AI Builder page, and no longer a page of its own",
  routes.includes(
    'const BoxPage = lazyRoute(() => import("./pages/BoxPage.tsx"))',
  ) &&
    !routes.includes("pages/ThisApp.tsx") &&
    !existsSync(join(ROOT, routesFile)),
);

check(
  "the tab is gone, and the old addresses still arrive at the page that holds it",
  (() => {
    // How the router spells a line is the formatter's business; that both old
    // addresses land on `/builder` is the promise, so the lines are read with
    // their whitespace flattened first.
    const flat = routes.replace(/\s+/g, " ");
    return (
      !shell.includes('to: "/this-app"') &&
      !shell.includes('label: "This App"') &&
      shell.includes('to: "/builder"') &&
      flat.includes(
        'path="this-app" element={<Navigate to="/builder" replace />}',
      ) &&
      flat.includes(
        'path="change-this-app" element={<Navigate to="/builder" replace />}',
      ) &&
      flat.includes('path="app" element={<Navigate to="/builder" replace />}')
    );
  })(),
);

check(
  "the changed list is the same merge a backup takes",
  backup.includes("export const changed = query({") &&
    /export const changed[\s\S]*?mergedSource\(ctx, userId\)/.test(backup) &&
    backup.includes("paths: [...patched].sort(),"),
);

check(
  "…and that merge carries only work newer than the app's own copy",
  backup.includes("export function carryBenchFiles(") &&
    backup.includes("row.updatedAt > shippedAt") &&
    backup.includes("carryBenchFiles(SELF_SOURCE, rows, SHIPPED_AT)") &&
    backup.includes("superseded: superseded.sort(),"),
);

check(
  "…and the panel says which copy the downloads hold, and what rides on it",
  backupPanel.includes("This is the app as it stands") &&
    backupPanel.includes("cannot replace newer code") &&
    backupPanel.includes("manifest.superseded"),
);

check(
  "…and the Control Room says the same where the downloads live",
  controlRoom.includes("can never take newer code&apos;s place") &&
    controlRoom.includes("older working copy can never replace newer code") &&
    controlRoom.includes("Every file below is the app as it now stands"),
);

check(
  "the page reads that list, and the bench behind it",
  page.includes("useQuery(api.backup.changed, {})") &&
    page.includes("useAction(api.workspace.exportNow)") &&
    page.includes("useQuery(api.workspace.readOwn,"),
);

check(
  "…and every way out of it is real, not described",
  page.includes("downloadZip(changesZipName(") &&
    page.includes("changePatch(") &&
    page.includes("pushRepo({") &&
    page.includes("changedBundle(bench.files, paths)"),
);

check(
  "…and the token the push uses is the one the Control Room sealed",
  page.includes("getSecret(GITHUB_SECRET)") &&
    page.includes("saveGithubToken(") &&
    page.includes("isRepoName(") &&
    page.includes("isBranchName("),
);

check(
  "…and it says what the push does, rather than promising a deploy",
  /nothing else in the repository\n?\s*moves|nothing else in the repository/.test(
    page,
  ) && !/it is live|already live|republished/i.test(page),
);

check(
  "…and the Control Room's own guide names the switch, and no dead tab",
  !controlRoom.includes('id: "this-app"') &&
    !controlRoom.includes('to: "/this-app"') &&
    /This app — its mirror/.test(controlRoom) &&
    /Build the copy/.test(controlRoom),
);

check(
  "the AI Builder's own prompt box points at that switch rather than claiming the job",
  !panel.includes('to="/this-app"') &&
    // Wrapped across lines in the JSX, so the promise is read as one line.
    /the hub itself is changed/.test(panel.replace(/\s+/g, " ")) &&
    panel.includes("This app — its mirror"),
);

check(
  "the assistant can take somebody there, and the models are told so",
  !actions.includes('"this-app"') &&
    actions.includes('"builder"') &&
    prompts.includes("assistant|builder|family") &&
    /this app's own mirror/.test(prompts),
);

check(
  "the Offline Brain page measures what the hub is serving when it opens",
  brainPage.includes("measurePackage()") &&
    brainPage.includes("void measurePackage()") &&
    brainPage.includes("measuredAt") &&
    brainPage.includes("Measure again") &&
    brainPage.includes("Nothing here is a number remembered from the"),
);

check(
  "…and every size it prints is that measurement, with the catalog only as the fallback",
  brainPage.includes(
    "const served = item.file ? measure?.sizes[item.file] : undefined;",
  ) &&
    brainPage.includes("const size = displaySize(item, measure);") &&
    brainPage.includes("measuredBytes(measure, groupPackagedPaths(group))") &&
    brainPage.includes("const installerSize = installerBytes(measure);") &&
    brainPage.includes("measure?.sizes ?? {},"),
);

check(
  "…and the catalog no longer carries a figure for the package or the installer",
  !brainCatalog.includes('label: "The installer file"') &&
    !brainCatalog.includes("The package, as served") &&
    brainPage.includes('label: "The package, as served"') &&
    brainPage.includes('label: "The installer file"'),
);

check(
  "…and the README inside a category archive says its sizes were measured too",
  brainBundles.includes("measured from what the hub was serving") &&
    brainBundles.includes("sizes: Record<string, number> = {},") &&
    brainBundles.includes("readableSize(served)"),
);

/* ------------------------ the app, in every way out of the hub ---------- */

// One archive, four builders: the Control Room's backups, the per-platform
// downloads, the per-category archives and the three editions on the Offline
// Brain page are each written separately, and each of them has to pick the
// archives up out of the same two lists. Drop one of those four and a download
// silently becomes the tools without the app — which is exactly what this
// project did for as long as the package existed.
const backupLib = await read("src/lib/backup.ts");
const platformLib = await read("src/lib/platform-downloads.ts");
const catalog = await read("src/lib/offline-brain.ts");
const packApp = await read("scripts/pack-this-app.mjs");
const packReadme = await read("public/offline-brain/README.md");
const sourceReadme = await read("public/offline-brain/source/README.md");
const captureScript = await read("public/offline-brain/scripts/capture-this-app.sh");

check(
  "every download the hub builds carries both archives, the app among them",
  [backupLib, platformLib, brainBundles, brainPage].every((file) =>
    file.includes("PACKAGE_BINARY_FILES"),
  ) &&
    backupLib.includes("for (const path of PACKAGE_BINARY_FILES)") &&
    platformLib.includes("for (const path of PACKAGE_BINARY_FILES)") &&
    brainPage.includes("for (const path of PACKAGE_BINARY_FILES)"),
);

check(
  "the pack script takes its file list from the snapshot's own walk",
  packApp.includes('from "./snapshot-self.mjs"') &&
    packApp.includes("collectFiles()") &&
    // Both halves of the snapshot are written in, from the same map the
    // Control Room's backup renders them from — one renderer, not two.
    packApp.includes('from "../src/lib/backup.ts"') &&
    packApp.includes("renderSelfSource(") &&
    packApp.includes("renderShippedSource(") &&
    packApp.includes('ROOT_DIR = "app"'),
);

check(
  "…and the README beside that script says which command runs it",
  packApp.includes("bun scripts/pack-this-app.mjs") &&
    /public\/offline-brain\/source\/this-app-source\.zip/.test(packApp) &&
    /snapshot:app/.test(
      await read("package.json"),
    ),
);

check(
  "the app is in the catalog, so the page and its downloads can offer it",
  catalog.includes('title: "Source — this app, and Freebuff"') &&
    catalog.includes('file: "source/this-app-source.zip"') &&
    catalog.includes("scripts/capture-this-app.sh"),
);

check(
  "the package's own documents name it, rather than only the reference source",
  packReadme.includes("source/this-app-source.zip") &&
    packReadme.includes("source/app/") &&
    sourceReadme.includes("this-app-source.zip") &&
    captureScript.includes("unpack_archive") &&
    captureScript.includes("source/this-app-source.zip"),
);

check(
  "…and the Control Room's downloads say so where the buttons are",
  controlRoom.includes("source/this-app-source.zip") &&
    /the brain's package now holds this application/.test(controlRoom),
);

/* ------------------------------------------------------------------ report */

if (failures) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log("\nAll This App checks passed.\n");

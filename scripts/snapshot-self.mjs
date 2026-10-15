/**
 * Pack the entire project — the web app, the offline coding brain it ships, and
 * every first-party piece beside it — into `src/convex/self_source.ts`.
 * (No hyphen in the name: Convex only allows letters, digits, underscores and
 * periods in a module path.)
 *
 * WHY THIS EXISTS
 * The AI Builder is asked to diagnose and repair itself. It runs inside Convex,
 * which has no filesystem and no way to see the project on your machine, so the
 * only way it can read its own code is if the code is shipped to the backend
 * with the functions. That is what this script does.
 *
 * THE WHOLE APP, NOT JUST THE FRONT END
 * The snapshot is also what a backup hands back to the person (see
 * `src/convex/backup.ts`), so "the entire app" has to mean the entire app: the
 * web front end under `src/`, the scripts, everything served from `public/`,
 * the self-host kit, the desktop SUGAR browser, the native host and NOVA OS.
 * Binary assets, oversized files and vendored third-party trees are still
 * skipped by the rules below — the snapshot is source, not an archive of
 * `node_modules` or the Freebuff reference tree.
 *
 * Run it after changing the files it covers:
 *
 *   bun run snapshot:self
 *
 * A snapshot is a copy, so it goes stale. The builder is told the date it was
 * taken and to say so rather than pretend it is current.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Root files worth handing over: how the app is wired and how it is built.
 *
 * `tsconfig.node.json` is here because the type-checker reads it — without it a
 * copy of this project cannot be rebuilt from the snapshot alone.
 */
const ROOT_FILES = [
  "package.json",
  "convex.json",
  "index.html",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  // Declares the Freebuff plugin (an optional dependency) so a copy without it
  // still type-checks and builds — and `tsconfig.node.json` above names it, so
  // a copy missing this file loses that protection silently.
  "vite-optional.d.ts",
  "components.json",
  "eslint.config.js",
  "postcss.config.cjs",
  "integrations.md",
  "README.md",
  "DEPLOY.md",
  "vercel.json",
];

/**
 * Directories never worth shipping — vendored, or built output.
 *
 * `_generated` (the Convex client types) and `public` (the manifest, service
 * worker and logo) are deliberately included: they are small, and a backup
 * without them is a project that cannot be typed or built. Binary files inside
 * them, like the icon PNGs, are still skipped by the rules below.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  // Built output. `dist` is the Vite output and Vercel's `outputDirectory`.
  // `build` is deliberately NOT here: the only folder by that name in this
  // project is `os/build/`, which is real source (the image and installer
  // scripts), not something a compiler produced.
  "dist",
  // `dist-independent` is the folder `self-hosting/bundle.sh` writes: an
  // installed `node_modules`, a copy of the Bun runtime and a 200 MB backend
  // program. It is built output of the most literal kind — reproducible from
  // this tree in seconds — and packing it into a snapshot would multiply the
  // snapshot by hundreds of megabytes to ship a copy of what is already here.
  "dist-independent",
  ".vite",
  // The local brain is Python, so running it (or its test suite) leaves
  // bytecode behind. It is machine-written, binary, and not source.
  "__pycache__",
]);

/**
 * First-party folders that sit beside the web app and are part of the project
 * the person owns. They ride in the snapshot so a backup is the whole thing —
 * not one folder of it — and the builder can read and rebuild any of them.
 */
const FIRST_PARTY_DIRS = ["self-hosting", "sugar-browser", "native", "os"];

/** Files that are never text, or are only ever machine-written. */
const SKIP_FILES = new Set([
  // The generated snapshot is left out of itself: a file cannot contain its
  // own final contents, and it is rebuilt for a backup anyway. The same is
  // true of the twin written into `public/` below.
  "self_source.ts",
  "self-source.json",
  "bun.lock",
  "package-lock.json",
  "bun.lockb",
  "yarn.lock",
  "sst-env.d.ts",
]);

const BINARY =
  /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|eot|mp[34]|wav|ogg|pdf|zip|gz|wasm|node|pyc|pyo)$/i;

/** Nothing bigger than this is worth carrying into every deploy. */
const MAX_FILE_BYTES = 160_000;

/**
 * The ceiling on the text the snapshot holds, in characters.
 *
 * This is a cap, not a target. `self_source.ts` is one module, and a module
 * this size is parsed in one gulp by every bundler that meets it — it is what
 * took the dev server's esbuild over the edge on a machine with 3.8 GB and no
 * swap. A ceiling means it cannot quietly grow past what a small machine can
 * carry: the day it tries, the tiers below give up their place first and
 * `SELF_OMITTED` names exactly which files went, so nothing is dropped in
 * silence.
 *
 * The count is of the file *contents*, which is what the builder and the
 * browser actually carry; the generated module runs a few percent larger than
 * that once paths, quotes and indentation are added.
 *
 * The web app itself is never in those tiers. `src/`, `scripts/`, `public/`
 * and the root files are what the app *is*; if the ceiling were ever low
 * enough to reach them, the script stops and says so instead of writing a
 * backup that is missing its own front end.
 *
 * The number itself has moved twice, both times because a snapshot missing part
 * of the app is not a snapshot of the app:
 *
 *   - 4,240,000, up from the original 4,000,000, when calls that follow you
 *     across the hub, a portal for a shared screen, the voice roster and the
 *     browser's toolbox arrived with every tier below already spent — which
 *     left raising it as the only honest alternative to a backup missing its
 *     own front end.
 *   - 5,200,000, now, when the same thing happened again with the tiers spent:
 *     58 files of `os/`, `native/`, `sugar-browser/` and `self-hosting/` were
 *     being pushed out of every backup and out of the builder's copy, and the
 *     offline brain now packs this same file set into the archive it ships
 *     (`scripts/pack-this-app.mjs`), so an omission here is an app missing its
 *     operating system, its native host, its desktop browser and its self-host
 *     kit — in every download at once. The whole tree weighs about 4.9 MB, so
 *     this leaves room for the next few features.
 *
 * The guard is still a guard: a little over five megabytes is not a licence for
 * the module to grow without bound, and the day it is reached again the same
 * choice comes back — shave the optional tiers, or raise it deliberately and
 * say why.
 */
export const MAX_SNAPSHOT_BYTES = 5_200_000;

/**
 * What gives up its place first when the cap forces a choice, most expendable
 * first. Each entry is a top-level directory, and a directory is only opened
 * once every one before it has been spent — inside it the largest files go
 * first, and only as many as the cap actually needs. So the least essential
 * code is shaved before anything else, and the web app is never in the list.
 */
const DROP_ORDER = ["os", "native", "sugar-browser", "self-hosting"];

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await walk(full)));
      continue;
    }

    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    if (BINARY.test(entry.name)) continue;

    const info = await stat(full);
    if (info.size > MAX_FILE_BYTES) {
      console.warn(`  skipped (too big): ${relative(ROOT, full)}`);
      continue;
    }

    out.push(full);
  }

  return out;
}

/**
 * Every file that belongs in the snapshot, in the order they are packed.
 * Exported so `verify-self.mjs` can check the snapshot against the real tree
 * without re-stating these rules and drifting from them.
 */
export async function collectFiles() {
  const files = [];

  // Everything the app itself is made of.
  for (const full of await walk(join(ROOT, "src"))) {
    files.push(full);
  }

  // Plus the scripts, so the builder can see how its own snapshot is taken.
  for (const full of await walk(join(ROOT, "scripts"))) {
    files.push(full);
  }

  // Plus everything the project serves from `public/`: the offline coding
  // brain the app ships (served from `/offline-brain/`) — models, runtimes,
  // reasoning, agents, tools, memory, search, and the docs that map every
  // capability to the component that provides it — together with the manifest,
  // service worker and logo that make the hub installable. Binary assets (the
  // icons, the source zip) are skipped by the rules above, so this adds text,
  // not weight.
  for (const full of await walk(join(ROOT, "public"))) {
    files.push(full);
  }

  // Plus the rest of the project the person actually owns, so "the entire app"
  // in a backup really is the entire app rather than only the web front end:
  // the self-host kit, the desktop SUGAR browser, the native host and NOVA OS.
  for (const name of FIRST_PARTY_DIRS) {
    for (const full of await walk(join(ROOT, name))) {
      files.push(full);
    }
  }

  // Plus the handful of root files that explain how it is put together.
  for (const name of ROOT_FILES) {
    const full = join(ROOT, name);
    try {
      const info = await stat(full);
      if (info.isFile() && info.size <= MAX_FILE_BYTES) files.push(full);
    } catch {
      // Not every project has every root file.
    }
  }

  return files;
}

/** The top-level area a path belongs to: `"src"`, `"os"`, or `""` for root. */
function tierOf(path) {
  const slash = path.indexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Take the cap off a packed snapshot.
 *
 * Whole tiers go, largest file first inside a tier, until the total fits — so
 * the fewest possible files are given up, and what is kept is kept whole.
 * Returns the packed map plus the paths that lost their place, sorted.
 */
function applyCap(source) {
  let entries = Object.entries(source);
  let bytes = entries.reduce((sum, [, text]) => sum + text.length, 0);
  if (bytes <= MAX_SNAPSHOT_BYTES) return { kept: source, omitted: [], bytes };

  const omitted = new Set();

  for (const tier of DROP_ORDER) {
    if (bytes <= MAX_SNAPSHOT_BYTES) break;

    const inTier = entries
      .filter(([path]) => tierOf(path) === tier)
      .sort((a, b) => b[1].length - a[1].length);

    for (const [path, text] of inTier) {
      if (bytes <= MAX_SNAPSHOT_BYTES) break;
      omitted.add(path);
      bytes -= text.length;
    }
  }

  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(
      `The snapshot is ${bytes} characters and every tier in DROP_ORDER has ` +
        `been spent, but the cap is ${MAX_SNAPSHOT_BYTES}. Either raise ` +
        `MAX_SNAPSHOT_BYTES or add a tier — the web app itself is not allowed ` +
        `to be dropped to fit.`,
    );
  }

  entries = entries.filter(([path]) => !omitted.has(path));
  return {
    kept: Object.fromEntries(entries),
    omitted: [...omitted].sort(),
    bytes,
  };
}

/** The snapshot as it should be written: paths relative to the root, sorted. */
export async function buildSnapshot() {
  const source = {};

  for (const full of await collectFiles()) {
    const path = relative(ROOT, full).split(sep).join("/");
    const text = await readFile(full, "utf8");
    source[path] = text;
  }

  const { kept, omitted, bytes } = applyCap(source);

  const ordered = Object.fromEntries(
    Object.keys(kept)
      .sort()
      .map((path) => [path, kept[path]]),
  );

  return { ordered, bytes, omitted };
}

// Only pack and write when run as a script. Importing this module just reads
// the tree — which is what `verify-self.mjs` does to check the snapshot against
// the real files, and what `scripts/pack-this-app.mjs` does to build the app's
// own archive — so an import must not do the packing twice, and must not write.
if (import.meta.main) {
  const { ordered, bytes, omitted } = await buildSnapshot();
  const taken = new Date().toISOString();

  /** How the cap is reported, so an omission is never silent. */
  const capNote = omitted.length
    ? `\n * ${omitted.length} file${omitted.length === 1 ? "" : "s"} left out to hold the snapshot\n * under the ${MAX_SNAPSHOT_BYTES.toLocaleString("en-US")}-character cap. They are\n * named in SELF_OMITTED below; shrink them and re-run to bring them back.`
    : "";

  const body = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * A snapshot of this app's own source, taken by \`bun run snapshot:self\`, so the
 * AI Builder can read its own code from inside Convex. Re-run that command
 * after changing any file below, or the builder will be reading an old copy.
 *
 * Taken: ${taken}
 * Files: ${Object.keys(ordered).length}
 * Omitted: ${omitted.length}${capNote}
 */

export const SELF_SNAPSHOT_AT = ${JSON.stringify(taken)};

/** Paths the cap kept out of this snapshot, if any. */
export const SELF_OMITTED: string[] = ${JSON.stringify(omitted, null, 2)};

export const SELF_SOURCE: Record<string, string> = ${JSON.stringify(ordered, null, 2)};
`;

  /**
   * The same snapshot as plain JSON, served from `public/`.
   *
   * This twin exists for the browser, not for Convex. `self_source.ts` is a
   * TypeScript module, so anything that imports it is parsed by the bundler —
   * and a single five-megabyte module is what OOM-killed esbuild in the first
   * place. A file in `public/` is copied through untouched and fetched at run
   * time, so the app keeps its offline copy of itself without ever putting this
   * megabyte anywhere near esbuild or Babel.
   */
  const browserBody = JSON.stringify({
    at: taken,
    omitted,
    files: ordered,
  });

  const target = join(ROOT, "src", "convex", "self_source.ts");
  await writeFile(target, body, "utf8");

  const browserTarget = join(ROOT, "public", "self-source.json");
  await writeFile(browserTarget, browserBody, "utf8");

  const note = omitted.length
    ? `, ${omitted.length} omitted to hold the cap`
    : "";
  console.log(
    `Wrote ${relative(ROOT, target)} — ${Object.keys(ordered).length} files, ` +
      `${(bytes / 1024).toFixed(0)} KB${note}.`,
  );
  console.log(`Wrote ${relative(ROOT, browserTarget)} — the browser's twin.`);
}

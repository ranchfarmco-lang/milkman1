/**
 * Pack this app's own source — and the offline coding brain it ships — into
 * `src/convex/self_source.ts`.
 * (No hyphen in the name: Convex only allows letters, digits, underscores and
 * periods in a module path.)
 *
 * WHY THIS EXISTS
 * The AI Builder is asked to diagnose and repair itself. It runs inside Convex,
 * which has no filesystem and no way to see the project on your machine, so the
 * only way it can read its own code is if the code is shipped to the backend
 * with the functions. That is what this script does.
 *
 * The offline brain the app ships — the whole `public/offline-brain/` package —
 * is packed in with the source, so the builder can read all of it (architecture,
 * capability map, model and tool catalogs, every installer) from inside Convex
 * and answer from it instead of from memory.
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
  "dist",
  "build",
  ".vite",
  // The local brain is Python, so running it (or its test suite) leaves
  // bytecode behind. It is machine-written, binary, and not source.
  "__pycache__",
]);

/** Files that are never text, or are only ever machine-written. */
const SKIP_FILES = new Set([
  // The generated snapshot is left out of itself: a file cannot contain its
  // own final contents, and it is rebuilt for a backup anyway.
  "self_source.ts",
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

  // Plus the offline coding brain the app ships (served from `/offline-brain/`),
  // so the builder can read the whole local stack it is meant to reproduce —
  // models, runtimes, reasoning, agents, tools, memory, search, and the docs
  // that map every capability to the component that provides it.
  for (const full of await walk(join(ROOT, "public", "offline-brain"))) {
    files.push(full);
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

/** The snapshot as it should be written: paths relative to the root, sorted. */
export async function buildSnapshot() {
  const source = {};
  let bytes = 0;

  for (const full of await collectFiles()) {
    const path = relative(ROOT, full).split(sep).join("/");
    const text = await readFile(full, "utf8");
    source[path] = text;
    bytes += text.length;
  }

  const ordered = Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((path) => [path, source[path]]),
  );

  return { ordered, bytes };
}

const { ordered, bytes } = await buildSnapshot();

const body = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * A snapshot of this app's own source, taken by \`bun run snapshot:self\`, so the
 * AI Builder can read its own code from inside Convex. Re-run that command
 * after changing any file below, or the builder will be reading an old copy.
 *
 * Taken: ${new Date().toISOString()}
 * Files: ${Object.keys(ordered).length}
 */

export const SELF_SNAPSHOT_AT = ${JSON.stringify(new Date().toISOString())};

export const SELF_SOURCE: Record<string, string> = ${JSON.stringify(ordered, null, 2)};
`;

// Only write when run as a script; importing this module just reads the tree.
if (import.meta.main) {
  const target = join(ROOT, "src", "convex", "self_source.ts");
  await writeFile(target, body, "utf8");

  console.log(
    `Wrote ${relative(ROOT, target)} — ${Object.keys(ordered).length} files, ${(
      bytes / 1024
    ).toFixed(0)} KB.`,
  );
}

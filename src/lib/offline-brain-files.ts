/**
 * Every file in the packaged `offline-ai-coding-brain/`, exactly as served from
 * `/offline-brain/`. The bundle and the one-file installer carry all of these,
 * so nothing an installer script needs is left behind (notably `scripts/lib.sh`,
 * which every installer sources, and `scripts/download-models.sh`).
 *
 * Keep this in step with `public/offline-brain/` if the package changes.
 *
 * Everything here is text, which is why the one-file installer can write it out
 * as here-documents. The files that are not text — the reference source archive
 * and the archive of this app itself — are in `PACKAGE_BINARY_FILES` below, and
 * carry their own handling.
 */
import { BRAIN_BASE } from "./offline-brain";

export const PACKAGE_FILES: string[] = [
  "GET-EVERYTHING.sh",
  "README.md",
  "agents/README.md",
  "browser-tools/README.md",
  "coding-tools/README.md",
  "configuration/README.md",
  "configuration/catalog.json",
  "configuration/env.sh",
  "configuration/litellm.example.yaml",
  "context/README.md",
  "databases/README.md",
  "documentation/ARCHITECTURE.md",
  "documentation/CAPABILITY-MAP.md",
  "documentation/LICENSES.md",
  "documentation/OFFLINE-GUIDE.md",
  "documentation/README.md",
  "embeddings/README.md",
  "file-tools/README.md",
  "libraries/README.md",
  "memory/README.md",
  "model-runtimes/README.md",
  "models/README.md",
  "models/manifest.json",
  "orchestration/README.md",
  "reasoning/README.md",
  "research-tools/README.md",
  "runtimes/README.md",
  "scripts/README.md",
  "scripts/capture-freebuff-source.sh",
  "scripts/capture-this-app.sh",
  "scripts/download-models.sh",
  "scripts/install-agents.sh",
  "scripts/install-browser-tools.sh",
  "scripts/install-coding-tools.sh",
  "scripts/install-context-memory.sh",
  "scripts/install-file-tools.sh",
  "scripts/install-libraries.sh",
  "scripts/install-orchestration.sh",
  "scripts/install-reasoning.sh",
  "scripts/install-research-tools.sh",
  "scripts/install-runtimes.sh",
  "scripts/install-supporting.sh",
  "scripts/install-terminal-tools.sh",
  "scripts/lib.sh",
  "scripts/serve-local-model.sh",
  "scripts/setup-all.sh",
  "scripts/verify.sh",
  "search/README.md",
  "source/README.md",
  "terminal-tools/README.md",
  "tests/README.md",
  "tests/smoke.sh",
  // The local brain, the runnable half of the system. It is in the bundle
  // because the package is incomplete without it: install everything above and
  // you still have nothing to *run* until brain.py is on the drive too.
  "brain/README.md",
  "brain/brain.py",
  "brain/src/__init__.py",
  "brain/src/agent.py",
  "brain/src/capabilities.py",
  "brain/src/config.py",
  "brain/src/connectors.py",
  "brain/src/diagnostics.py",
  "brain/src/info.py",
  "brain/src/providers.py",
  "brain/src/scheduler.py",
  "brain/src/server.py",
  "brain/src/store.py",
  "brain/src/tools.py",
  "brain/src/updater.py",
  "brain/tests/test_brain.py",
];

/**
 * The packaged files that are not text, so they travel as bytes. Two archives,
 * and between them the package holds both halves of the system it describes:
 *
 *   - `source/freebuff-source.zip` — the untouched upstream archive of the
 *     Freebuff (Codebuff) reference source (Apache-2.0), the implementation the
 *     local brain's installers point at. `scripts/pack-freebuff-source.mjs`
 *     builds it.
 *   - `source/this-app-source.zip` — **this app**, the whole hub: every page and
 *     Convex function, the scripts, the desktop browser, the native host, NOVA
 *     OS and the docs, plus the two generated halves of its own snapshot so the
 *     unpacked copy builds as it stands. `scripts/pack-this-app.mjs` builds it
 *     from the same walk that packs the builder's copy of the app
 *     (`collectFiles()` in `scripts/snapshot-self.mjs`), and
 *     `scripts/capture-this-app.sh` unpacks it to `source/app`.
 *
 * Both ship *inside* the package — the READMEs, the platform bundles, every
 * category archive, the one-file installer and the Control Room's Everything
 * backup all describe them — so a download is complete when it lands and no
 * installer has to reach the network for either.
 *
 * A fetch of `/offline-brain/source/<name>.zip` returns the bytes exactly.
 */
export const PACKAGE_BINARY_FILES: string[] = [
  "source/freebuff-source.zip",
  "source/this-app-source.zip",
];

/**
 * The whole package: text and archive together. This is what a complete
 * download holds, and what the counts on the Offline Brain page mean.
 */
export const PACKAGE_ALL_FILES: string[] = [
  ...PACKAGE_FILES,
  ...PACKAGE_BINARY_FILES,
];

/* ------------------------------------------------- measuring what is served */

/**
 * Asking the hub what it is serving right now.
 *
 * The size beside a button used to be a number written into the catalog on the
 * day it was typed (`FILE_SIZES` in `offline-brain.ts`), which cannot move when
 * the file does — so a page full of labels could keep showing last month's
 * figures and look perfectly healthy. This is the honest version: every
 * packaged path is asked for, and its size is read off the response itself (the
 * `Content-Length` where the server states one, the body where it does not),
 * so a figure shown as measured really was measured, and it changes the moment
 * the file changes.
 *
 * The reference archive is eighteen megabytes; its response is never read past
 * the headers, which is why this is cheap enough to run when the page opens.
 */
export type PackageMeasure = {
  /** How many of the packaged files answered. */
  files: number;
  /** Their combined size, in bytes. */
  bytes: number;
  /** Each file's measured size, by its packaged path. */
  sizes: Record<string, number>;
  /** Paths that did not answer, named rather than silently left out. */
  missing: string[];
  /** When this measurement was taken, in milliseconds. */
  at: number;
};

/** How many files are asked about at once. Quick, but not a flood of sockets. */
const MEASURE_AT_ONCE = 8;

/** One packaged path's size, or null when it cannot be read. */
async function servedBytes(path: string): Promise<number | null> {
  try {
    const response = await fetch(`${BRAIN_BASE}/${path}`, { cache: "no-store" });
    if (!response.ok) return null;

    // The server usually states the size; when it does, the body is never
    // touched — eighteen megabytes of reference archive is not downloaded just
    // to be measured.
    const stated = Number(response.headers.get("content-length"));
    if (Number.isFinite(stated) && stated > 0) {
      await response.body?.cancel();
      return stated;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > 0 ? bytes.length : null;
  } catch {
    return null;
  }
}

/** Measure what this hub is serving for the whole package, right now. */
export async function measurePackage(): Promise<PackageMeasure> {
  const paths = [...PACKAGE_ALL_FILES];
  const sizes: Record<string, number> = {};
  let next = 0;

  const workers = Array.from(
    { length: Math.min(MEASURE_AT_ONCE, paths.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= paths.length) return;
        const size = await servedBytes(paths[index]);
        if (size !== null) sizes[paths[index]] = size;
      }
    },
  );
  await Promise.all(workers);

  const measured = Object.keys(sizes);
  let bytes = 0;
  for (const path of measured) bytes += sizes[path];

  return {
    files: measured.length,
    bytes,
    sizes,
    missing: paths.filter((path) => !(path in sizes)),
    at: Date.now(),
  };
}

/**
 * What a set of packaged paths weighs, measured — or null when any of them did
 * not answer, so a category is never shown a total that leaves a file out.
 */
export function measuredBytes(
  measure: PackageMeasure | null,
  paths: string[],
): number | null {
  if (!measure || paths.length === 0) return null;
  let total = 0;
  for (const path of paths) {
    const size = measure.sizes[path];
    if (size === undefined) return null;
    total += size;
  }
  return total;
}

/** Base64 is four characters for every three bytes, wrapped at 76 columns. */
function base64WrappedBytes(bytes: number) {
  const encoded = 4 * Math.ceil(bytes / 3);
  return encoded + Math.ceil(encoded / 76);
}

/**
 * The size of the one-file installer, `install-offline-brain.sh`, worked out
 * from the measurement rather than remembered.
 *
 * The script `buildSelfInstaller` writes is this package again as a single
 * file: every file that is text lands in a here-document exactly as it is, and
 * every file that is not goes in as base64 — so it can be worked out from the
 * measured sizes alone, with nothing fetched. What is not counted here is the
 * script's own wiring (three lines around each file, plus its header and
 * footer): about ten kilobytes against thirty-five megabytes, which is why the
 * page prints this in tenths of a megabyte, and why
 * `scripts/this-app-check.ts` holds this figure to the size of the script that
 * is really built — if the two ever stopped agreeing at the printed precision,
 * that check fails.
 */
export function installerBytes(measure: PackageMeasure | null): number | null {
  if (!measure) return null;
  const text = measuredBytes(measure, PACKAGE_FILES);
  const binary = measuredBytes(measure, PACKAGE_BINARY_FILES);
  if (text === null || binary === null) return null;
  // One file, and the archive inside it as base64 — plus the single newline
  // each file gains when it does not already end with one.
  return text + PACKAGE_FILES.length + base64WrappedBytes(binary);
}

/**
 * "Everything in this category" — one archive per category on the Offline Brain
 * page.
 *
 * Each category card used to hand you a single file: its own installer when it
 * had one (the button said `Installer`) and, when it did not, a script stitched
 * together from its parts (the button said `All`). So the same button meant two
 * different things, and neither of them carried the category: the archive the
 * category lists was left behind, and every component's own installer with it.
 *
 * This module builds the honest version. One zip per category, holding:
 *
 *   1. `START-HERE.md` — every component in the category, what it installs and
 *      how big it is, and what else is in the folder;
 *   2. `install-<category>.sh` — the single script that installs everything
 *      installable in the category, in order;
 *   3. `installers/` — a ready script per component, so one can be run alone;
 *   4. every packaged file the category names, at its own path — the packaged
 *      installers and docs, and for the source category the Freebuff (Codebuff)
 *      reference archive itself, carried as its own bytes.
 *
 * Nothing is uploaded to make the archive: it is assembled in the browser from
 * what the hub already serves, exactly like every other download here. The
 * model weights stay out of it because they are tens of gigabytes and belong on
 * the machine — the scripts in the zip fetch them there, which is what they do
 * inside the full package too.
 */
import { stampOf } from "./backup";
import { PACKAGE_BINARY_FILES } from "./offline-brain-files";
import {
  groupScript,
  sizeOf,
  type BrainGroup,
  type BrainItem,
} from "./offline-brain";
import { zipBlob, type ZipEntry } from "./zip";

/** A safe file name for a generated script. */
function slug(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "component"
  );
}

/**
 * Every packaged file the category names, in catalog order and without repeats
 * (a few categories share an installer, and `context` and `memory` share one).
 */
export function groupPackagedPaths(group: BrainGroup): string[] {
  const paths: string[] = [];
  if (group.file) paths.push(group.file);
  for (const item of group.items) if (item.file) paths.push(item.file);
  return [...new Set(paths)];
}

/** The components in the category that install themselves with a script. */
function scriptItems(group: BrainGroup): BrainItem[] {
  return group.items.filter((item) => Boolean(item.script));
}

/**
 * How many files the category's archive holds: the README, the category
 * installer when the category has anything to install, one script per
 * installable component, and every packaged file. This is what the button's
 * count means, and what the built archive is checked against.
 */
export function groupBundleFileCount(group: BrainGroup): number {
  const scripts = scriptItems(group).length;
  return 1 + (scripts ? 1 : 0) + scripts + groupPackagedPaths(group).length;
}

/** The file name a category archive arrives under. */
export function groupBundleName(group: BrainGroup, at: string): string {
  return `offline-brain-${group.id}-${stampOf(at)}.zip`;
}

/** The README that sits at the top of a category archive. */
export function groupReadme(
  group: BrainGroup,
  at: string,
  source: string,
  missing: string[],
): string {
  const paths = groupPackagedPaths(group);
  const scripts = scriptItems(group);
  const lines: string[] = [
    `# ${group.title} — everything in this category`,
    "",
    group.summary,
    "",
    `- Category: ${group.title} (${group.id})`,
    `- Packed from: ${source}`,
    `- Packed on: ${at}`,
    `- Files in this archive: ${groupBundleFileCount(group)}${
      missing.length ? ` (${missing.length} unavailable)` : ""
    }`,
    "",
    "## What is in this folder",
    "",
    "- `START-HERE.md` — this file.",
  ];

  if (scripts.length) {
    lines.push(
      `- \`install-${group.id}.sh\` — installs everything installable in this`,
      "  category, in order, on the machine you run it on.",
      "- `installers/` — one ready script per component below, for when you want",
      "  just one of them.",
    );
  }
  for (const path of paths) {
    lines.push(`- \`${path}\` — a packaged file this category ships.`);
  }
  lines.push("");

  lines.push("## Every component in this category", "");
  for (const item of group.items) {
    const size = sizeOf(item);
    const arrives = item.file
      ? `packaged file: \`${item.file}\``
      : item.script
        ? "installed by a script in this archive"
        : "part of the package";
    lines.push(
      `- **${item.name}**${item.meta ? ` (${item.meta})` : ""} — ${item.blurb}`,
      `  - ${arrives}${size ? ` · ${size}` : ""}`,
    );
  }
  lines.push("");

  if (scripts.length) {
    lines.push(
      "## Running it",
      "",
      "```",
      `bash install-${group.id}.sh      # everything in this category`,
      "```",
      "",
      "Each script in `installers/` also runs on its own. Where a component",
      "needs software or model weights, its script fetches them from that",
      "project's own source while it runs — the same scripts the full package",
      "ships. Nothing in this archive reaches for a file that is already here.",
      "",
    );
  } else {
    lines.push(
      "## Using it",
      "",
      "This category ships files rather than installers, so they are all here at",
      "their own paths, ready to unzip onto the drive beside the rest of the",
      "package.",
      "",
    );
  }

  if (missing.length) {
    lines.push(
      "## Not in this copy",
      "",
      "These files could not be read when the archive was made — fetch them from",
      "the hub's Offline Brain page:",
      "",
    );
    for (const path of missing) lines.push(`- ${path}`);
    lines.push("");
  } else {
    lines.push(
      "Complete: every file this category names is in this archive" +
        (PACKAGE_BINARY_FILES.some((path) => paths.includes(path))
          ? ", the Freebuff (Codebuff) reference source archive included."
          : "."),
      "",
    );
  }

  return lines.join("\n");
}

/**
 * Build one category's complete download. `fetchText` reads a packaged text
 * file and `fetchBytes` reads the ones that are not text (the source archive),
 * so the archive travels as its own bytes. Anything that cannot be read is
 * reported rather than quietly left out.
 */
export async function groupBundleZip(
  group: BrainGroup,
  fetchText: (path: string) => Promise<string | null>,
  at: string,
  source: string,
  fetchBytes: (path: string) => Promise<Uint8Array | null> = async () => null,
): Promise<{
  blob: Blob;
  files: number;
  carried: number;
  missing: string[];
  archives: string[];
  installer: string | null;
}> {
  const root = `offline-brain-${group.id}-${stampOf(at)}`;
  const missing: string[] = [];
  const archives: string[] = [];
  const carriedFiles: ZipEntry[] = [];
  let carried = 0;

  for (const path of groupPackagedPaths(group)) {
    const isArchive = PACKAGE_BINARY_FILES.includes(path);
    const data = isArchive ? await fetchBytes(path) : await fetchText(path);
    if (data === null) {
      missing.push(path);
      continue;
    }
    carriedFiles.push({ path: `${root}/${path}`, data });
    if (isArchive) archives.push(path);
    carried += 1;
  }

  const scripts = scriptItems(group);
  const head: ZipEntry[] = [
    {
      path: `${root}/START-HERE.md`,
      data: groupReadme(group, at, source, missing),
    },
  ];
  const installer = scripts.length ? `install-${group.id}.sh` : null;
  if (installer) {
    head.push({ path: `${root}/${installer}`, data: groupScript(group) });
  }
  const perItem: ZipEntry[] = scripts.map((item) => ({
    path: `${root}/installers/${slug(item.name)}.sh`,
    data: item.script as string,
  }));

  // The two things you need on top, then one script per component, then the
  // packaged files themselves.
  const entries = [...head, ...perItem, ...carriedFiles];
  return {
    blob: zipBlob(entries, new Date(at)),
    files: entries.length,
    carried,
    missing,
    archives,
    installer,
  };
}

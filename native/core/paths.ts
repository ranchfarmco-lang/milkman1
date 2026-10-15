/**
 * Where a native application is allowed to keep its things.
 *
 * Each operating system has its own convention, and following it means the
 * host's files land where that system expects: `%APPDATA%` on Windows,
 * `~/Library/Application Support` on macOS, the XDG directories on Linux. A
 * `SUGAR_HOME` override exists so tests never touch a real installation.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export type Paths = {
  /** Everything SUGAR owns. */
  home: string;
  /** JSON configuration, one file per section (§46). */
  config: string;
  /** Logs, as text files, alongside the in-memory bus. */
  logs: string;
  /** Downloaded files, installer artifacts and the build cache. */
  downloads: string;
  /** The embedded browser's own profile: cookies, storage, cache. */
  browser: string;
  /** Credentials that the OS keychain cannot hold. */
  credentials: string;
};

function detectHome(): string {
  const override = (process.env.SUGAR_HOME ?? "").trim();
  if (override) return override;

  switch (platform()) {
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "SUGAR");
    case "darwin":
      return join(homedir(), "Library", "Application Support", "SUGAR");
    default: {
      const base = (process.env.XDG_CONFIG_HOME ?? "").trim() || join(homedir(), ".config");
      return join(base, "sugar");
    }
  }
}

let cached: Paths | null = null;

export function paths(): Paths {
  if (cached) return cached;
  const home = detectHome();
  cached = {
    home,
    config: home,
    logs: join(home, "logs"),
    downloads: join(home, "downloads"),
    browser: join(home, "browser-profile"),
    credentials: join(home, "credentials"),
  };
  return cached;
}

/** Create the tree once, so every later write is a plain file write. */
export function ensurePaths(): Paths {
  const tree = paths();
  for (const dir of [tree.home, tree.logs, tree.downloads, tree.browser, tree.credentials]) {
    mkdirSync(dir, { recursive: true });
  }
  return tree;
}

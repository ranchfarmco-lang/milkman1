// SUGAR Browser — portable path resolution.
//
// The one rule this file exists to enforce: SUGAR Browser never assumes where it
// lives. It works out its own directory at run time — from the executable that
// is running, not from a path somebody typed — and keeps everything relative to
// that. Move the folder to a USB stick, plug it into another machine, and it is
// the same browser with the same data, whatever letter the drive lands on.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** A file next to the executable that asks for portable mode, by its presence. */
const MARKER = "SUGARBrowser.portable";

/** Whether portable mode was asked for by a flag or an environment variable. */
function portableRequested({ portableFlag = false, env = {} } = {}) {
  if (portableFlag) return true;
  const value = String(env.SUGAR_PORTABLE ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** Whether the marker file sits beside the executable. */
function markerPresent(exeDir, marker = MARKER) {
  try {
    return Boolean(exeDir) && fs.existsSync(path.join(exeDir, marker));
  } catch {
    return false;
  }
}

/** The folder tree SUGAR Browser keeps under its root (§9). */
function treeFor(root) {
  return {
    root,
    browserEngine: path.join(root, "BrowserEngine"),
    resources: path.join(root, "Resources"),
    ai: path.join(root, "AI"),
    characters: path.join(root, "Characters"),
    extensions: path.join(root, "Extensions"),
    profiles: path.join(root, "Profiles"),
    data: path.join(root, "Data"),
    downloads: path.join(root, "Downloads"),
    cache: path.join(root, "Cache"),
    logs: path.join(root, "Logs"),
    settings: path.join(root, "Settings"),
    updates: path.join(root, "Updates"),
    // The parts of the profile a browser engine writes itself.
    profile: path.join(root, "Profiles", "default"),
    session: path.join(root, "Profiles", "default", "Session"),
    history: path.join(root, "Data", "history.json"),
    bookmarks: path.join(root, "Data", "bookmarks.json"),
    downloadsIndex: path.join(root, "Data", "downloads.json"),
    settingsFile: path.join(root, "Settings", "settings.json"),
    commands: path.join(root, "Data", "commands.json"),
  };
}

/**
 * Where SUGAR Browser keeps its things.
 *
 * Portable when asked (a flag, `SUGAR_PORTABLE`, or the marker beside the
 * executable); otherwise in the machine's per-user application data, which is
 * the normal installed behaviour. Either way the caller is handed the root and
 * the whole tree, so nothing else in the program ever builds a path by hand.
 */
function resolveRoots({
  exeDir,
  appDataDir,
  env = {},
  portableFlag = false,
  marker = MARKER,
}) {
  if (!exeDir) throw new Error("resolveRoots needs the directory of the executable.");
  if (!appDataDir) throw new Error("resolveRoots needs the system application-data directory.");

  const portable = portableRequested({ portableFlag, env }) || markerPresent(exeDir, marker);
  const root = portable ? exeDir : path.join(appDataDir, "SUGAR Browser");

  return { root, portable, marker, dirs: treeFor(root) };
}

/** Create the tree. Safe to call on every launch; it only ever adds. */
function ensureTree(dirs) {
  for (const value of Object.values(dirs)) {
    // The entries that are files, not folders, are skipped here: their parent
    // directory is created instead.
    if (typeof value !== "string") continue;
    if (/\.(json|txt|log)$/i.test(value)) {
      fs.mkdirSync(path.dirname(value), { recursive: true });
    } else {
      fs.mkdirSync(value, { recursive: true });
    }
  }
  return dirs;
}

/**
 * The same decision, made from the running process. The main process uses this
 * on startup; a test can call `resolveRoots` directly with made-up paths.
 */
function rootsFromProcess({ appDataDir, portableFlag = false, env = process.env } = {}) {
  const exeDir = path.dirname(process.execPath || process.argv[0] || process.cwd());
  return resolveRoots({ exeDir, appDataDir: appDataDir || exeDir, env, portableFlag });
}

module.exports = {
  MARKER,
  portableRequested,
  markerPresent,
  treeFor,
  resolveRoots,
  ensureTree,
  rootsFromProcess,
};

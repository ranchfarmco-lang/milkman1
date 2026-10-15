// SUGAR Browser — updates, offline first (§8, §14).
//
// A portable browser cannot depend on an update server, so it does not. The
// primary path is entirely local: a new build is dropped into the `Updates/`
// folder beside the executable, and the browser notices it and explains what to
// do. A feed is optional and, even when configured, is only ever *read* to tell
// the person a newer version exists — it is never downloaded and never applied
// on its own.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Break "1.2.3-beta.4" into comparable numbers. */
function versionParts(version) {
  return String(version || "0")
    .replace(/^v/i, "")
    .split(/[.\-+]/)
    .map((part) => {
      const number = Number.parseInt(part, 10);
      return Number.isFinite(number) ? number : 0;
    });
}

/** -1, 0 or 1 — the usual ordering. */
function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const one = left[i] ?? 0;
    const two = right[i] ?? 0;
    if (one > two) return 1;
    if (one < two) return -1;
  }
  return 0;
}

/**
 * What has been dropped into the `Updates/` folder. A folder or an archive both
 * count: how it is applied is the person's choice, and this only reports it.
 */
function localPackages(updatesDir) {
  const found = [];
  try {
    if (!fs.existsSync(updatesDir)) return found;
    for (const entry of fs.readdirSync(updatesDir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(updatesDir, entry.name);
      let size = 0;
      let at = null;
      try {
        const stat = fs.statSync(full);
        size = stat.size;
        at = stat.mtimeMs;
      } catch {
        /* a file that vanished between listing and reading */
      }
      const version = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(entry.name)?.[1] ?? null;
      found.push({
        name: entry.name,
        path: full,
        isDirectory: entry.isDirectory(),
        size,
        at,
        version,
      });
    }
  } catch {
    /* an unreadable folder simply has nothing in it, as far as this is concerned */
  }
  return found.sort((a, b) => compareVersions(b.version ?? "0", a.version ?? "0"));
}

/**
 * The optional feed. It is asked one question and given one answer, and nothing
 * is ever fetched or installed from it. Any failure is reported as a failure,
 * never as "up to date" — a check that could not run must not read as success.
 */
async function checkFeed({ url, currentVersion, fetchImpl = fetch, timeoutMs = 8000 }) {
  if (!url) return { ok: false, configured: false, latest: null, newer: false, note: "No update feed is configured, and none is needed." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const latest = String(body?.version ?? body?.latest ?? "").trim() || null;
    if (!latest) throw new Error("the feed did not name a version");
    const newer = compareVersions(latest, currentVersion) > 0;
    return {
      ok: true,
      configured: true,
      latest,
      newer,
      note: newer
        ? `Version ${latest} is available. SUGAR Browser will not install it by itself — download it, or drop it into the Updates folder.`
        : `Version ${latest} is the newest the feed names.`,
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      latest: null,
      newer: false,
      note: `The update feed could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { versionParts, compareVersions, localPackages, checkFeed };

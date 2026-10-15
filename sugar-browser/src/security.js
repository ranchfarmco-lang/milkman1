// SUGAR Browser — the security model, in code (§13).
//
// Three rules, and they are the whole of it:
//
//   · the browser asks for the narrowest set of permissions it can work with,
//     and refuses everything else rather than granting it and hoping;
//   · no path the browser touches may leave the browser's own directory unless
//     the person chose it through a dialog — checked here, not assumed;
//   · nothing is hidden. There is no persistence mechanism, no silent install,
//     no copying itself anywhere.
"use strict";

const path = require("node:path");

/**
 * The permissions a browser genuinely needs, and nothing more. Camera and
 * microphone carry the calls; screen capture carries screen sharing; the rest
 * are what a modern page expects. USB, serial, HID and the like are absent on
 * purpose — a browser has no business enumerating a machine's hardware bus.
 */
const ALLOWED_PERMISSIONS = new Set([
  "media",
  "mediaKeySystem",
  "display-capture",
  "clipboard-read",
  "clipboard-sanitized-write",
  "notifications",
  "fullscreen",
  "pointerLock",
  "geolocation",
  "midi",
  "background-sync",
]);

function isAllowedPermission(permission) {
  return ALLOWED_PERMISSIONS.has(permission);
}

/** Whether `candidate` is the root itself or lives underneath it. */
function isInside(root, candidate) {
  if (!root || !candidate) return false;
  const from = path.resolve(root);
  const to = path.resolve(candidate);
  const relative = path.relative(from, to);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * A path the browser is about to use, refused if it would leave its own
 * directory. This is what stops a download name, a saved page or a SUGAR
 * request from reaching anywhere on the machine the person did not choose.
 */
function assertInside(root, candidate) {
  if (!isInside(root, candidate)) {
    throw new Error(`That path is outside the browser's own folder and was refused: ${candidate}`);
  }
  return path.resolve(candidate);
}

/**
 * A file name that is safe to write inside a directory: no separators, no
 * traversal, no reserved device names, and a sane length.
 */
function safeFileName(name, fallback = "download") {
  const cleaned = String(name || "")
    .replace(/[\\/]+/g, "_")
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  if (!cleaned || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) return fallback;
  return cleaned;
}

module.exports = {
  ALLOWED_PERMISSIONS,
  isAllowedPermission,
  isInside,
  assertInside,
  safeFileName,
};

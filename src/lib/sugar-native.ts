/**
 * The native host, as a real download from the web portal (§31–§35, §66).
 *
 * The portal must not show a download button that does nothing, and it must not
 * show a file it cannot actually produce. So this builds the archive from the
 * host's own source files, read at build time by Vite from `native/`, and hands
 * back the same bytes it computed the checksum over. Nothing is fetched from
 * anywhere to make it and nothing is uploaded.
 *
 * The files are read lazily: the import map is a set of functions, so the source
 * text is only pulled in when somebody presses the button, not when the page
 * loads.
 */

import { zipBlob, type ZipEntry } from "./zip";

/** Every native host source file, read as text and loaded on demand. */
const SOURCE = import.meta.glob("/native/**/*.{ts,json,md}", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

/** The paths inside the archive, in a stable order, named relative to `native/`. */
export function nativeSourcePaths(): string[] {
  return Object.keys(SOURCE)
    .map((path) => path.replace(/^\/native\//, ""))
    .sort((a, b) => a.localeCompare(b));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A real SHA-256, through the browser's own Web Crypto. It is unavailable on an
 * insecure origin, and the caller is told rather than being handed a made-up
 * value (§35, §51).
 */
export async function sha256Hex(data: Uint8Array | string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return toHex(new Uint8Array(digest));
}

/**
 * A `Uint8Array` view over a `Blob` part, so a digest can be taken without
 * copying the whole file into a string.
 */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** The README that sits at the top of the portal's copy of the host (§49). */
function startHere(version: string, fileCount: number): string {
  return `# SUGAR — the native host, from the web portal

Version ${version}. ${fileCount} source files.

This archive is the host itself: the embedded HTTP server, the outbound Internet
client, the embedded browser engine's window hosts, the network and VPN
detection, the secure tunnel client, the authentication and device pairing, the
diagnostics and the download centre.

## Start here

    bun run host.ts

Bun runs TypeScript directly, so there is no build step. The host prints the
address its dashboard is on. If you would rather use Node, every file is plain
TypeScript as well.

## What is inside

    core/        configuration, logging, versioning, the start-up sequence
    network/     interfaces, DNS, HTTPS, VPN, Starlink/CGNAT, the change monitor
    client/      the outbound Internet client and the Internet agent
    server/      the embedded HTTP server and the local API
    browser/     the browser engine and the per-OS window hosts
    tunnel/      the replaceable TunnelProvider and a real relay
    auth/        sessions, lockout, CSRF
    devices/     expiring, revocable device pairing
    downloads/   the download centre and its ZIP writer
    diagnostics/ the TEST EVERYTHING and SELF TEST suites
    security/    headers, redaction, validation
    storage/     one configuration file per section, and the OS credential store
    ui/          the dashboard, and a real QR encoder
    platform/    Windows, Linux and macOS specifics: the firewall, the engine
    web-portal/  the pages a remote browser gets

## Check it before you trust it

    bun run selfcheck.ts

That starts a real relay, a real server and a real tunnel, and then makes a
request through the relay to prove the tunnel carries it. It exits non-zero if
anything fails.

## What this archive does not contain

Signed .msi, .dmg and .deb packages. Those have to be built and signed on each
platform by that platform's tooling, which cannot be done from a browser or from
a running program. The host's download centre generates a real installer script
per platform instead, and says so (§26, §51).
`;
}

/**
 * Assemble the archive. Returns the blob, the file list and the archive's own
 * checksum, so the card can show a value that matches the bytes it hands over.
 */
export async function buildNativeBundle(version: string): Promise<{
  blob: Blob;
  files: { path: string; bytes: number; sha256: string | null }[];
  archiveSha256: string | null;
  missing: string[];
}> {
  const entries: ZipEntry[] = [];
  const files: { path: string; bytes: number; sha256: string | null }[] = [];
  const missing: string[] = [];
  const encoder = new TextEncoder();

  const paths = nativeSourcePaths();
  for (const relative of paths) {
    const loader = SOURCE[`/native/${relative}`];
    if (!loader) {
      missing.push(relative);
      continue;
    }
    let text: string;
    try {
      text = await loader();
    } catch {
      missing.push(relative);
      continue;
    }
    const bytes = encoder.encode(text);
    entries.push({ path: `SUGAR/Source/${relative}`, data: bytes });
    files.push({ path: `Source/${relative}`, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) });
  }

  const readme = encoder.encode(startHere(version, files.length));
  entries.unshift({ path: "SUGAR/START-HERE.md", data: readme });
  files.unshift({ path: "START-HERE.md", bytes: readme.byteLength, sha256: await sha256Hex(readme) });

  // A real checksums file over the archive's own contents (§35).
  const sums = files
    .map((file) => `${file.sha256 ?? "unavailable"}  ${file.path}`)
    .join("\n");
  const checksumText = encoder.encode(
    `# Every file in SUGAR-source.zip\n# Recompute from the top of the unpacked archive.\n\n${sums}\n`,
  );
  entries.push({ path: "SUGAR/Checksums/SHA256SUMS.txt", data: checksumText });
  files.push({
    path: "Checksums/SHA256SUMS.txt",
    bytes: checksumText.byteLength,
    sha256: await sha256Hex(checksumText),
  });

  const blob = zipBlob(entries);
  const archiveSha256 = await sha256Hex(await blobBytes(blob));

  return { blob, files, archiveSha256, missing };
}

/** What the card says the download is, without having built it yet. */
export function nativeBundleSummary(): { files: number; version: string } {
  return { files: nativeSourcePaths().length, version: "1.0.0" };
}

export const NATIVE_BUNDLE_NAME = "SUGAR-native-host-source.zip";

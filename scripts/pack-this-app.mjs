#!/usr/bin/env node
/**
 * Pack *this app* — the whole hub, every file the snapshot covers — into the
 * archive the offline brain ships, so a download of the brain carries the app
 * itself and not only the tools that reproduce it.
 *
 *   bun scripts/pack-this-app.mjs
 *
 * Writes: public/offline-brain/source/this-app-source.zip
 *
 * Which `/offline-brain/source/` then serves, and which every download on the
 * Offline Brain page — the one-file installer, each platform bundle, each
 * category archive, the local edition and the Control Room's Everything backup —
 * carries inside it, because all of them are built from `PACKAGE_FILES` and
 * `PACKAGE_BINARY_FILES` (see `src/lib/offline-brain-files.ts`).
 *
 * THE FILE LIST IS THE APP'S OWN DEFINITION OF ITSELF
 * The list comes from `collectFiles()` in `scripts/snapshot-self.mjs` — the same
 * walk that packs `src/convex/self_source.ts`, checks itself in
 * `scripts/verify-self.mjs` and hands the Control Room its backups. One
 * definition, so the archive, a backup and the builder's copy can never drift
 * apart about what "the whole app" means.
 *
 * Two files are *written* rather than copied, exactly as a backup does it:
 * `src/convex/self_source.ts` and `public/self-source.json` are generated, and
 * the snapshot leaves both out of itself. Put back — through the same
 * `renderSelfSource` / `renderShippedSource` the Control Room uses — the
 * unpacked copy is a project that types, builds and serves as it stands, instead
 * of one whose functions import a module nobody shipped.
 *
 * A zip, not a tar.gz, for the reason `scripts/pack-freebuff-source.mjs` gives:
 * a static server answers a request for `*.gz` with `Content-Encoding: gzip`
 * over bytes that are already gzip, so a browser hands back a *tar*. A `.zip` is
 * served as ordinary bytes, and every `unzip`, `python3 -m zipfile` and file
 * manager on earth reads it. The tree is rooted at `app/`, so extracting it into
 * the package's `source/` directory lands the project at `source/app` — beside
 * `source/freebuff`, the reference implementation it was built from.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";

import { renderSelfSource, renderShippedSource } from "../src/lib/backup.ts";
import { collectFiles } from "./snapshot-self.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "public", "offline-brain", "source", "this-app-source.zip");
const ROOT_DIR = "app";

/** Node has no crc32 in crypto, so the table is built once on first use. */
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** DOS date/time pair, which is what the zip format stores for a timestamp. */
function dosTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, day };
}

/** Every file on disk the app is made of, by its path inside the project. */
const onDisk = (await collectFiles()).map((full) =>
  relative(ROOT, full).split(sep).join("/"),
);
if (onDisk.length === 0) {
  console.error("no files found — is this being run from the project root?");
  process.exit(1);
}

const at = new Date().toISOString();
const contents = {};
for (const path of onDisk) {
  contents[path] = await readFile(join(ROOT, path), "utf8");
}

// The two generated halves, written from the same map, so the unpacked copy is
// whole: see the note at the top.
contents["src/convex/self_source.ts"] = renderSelfSource(contents, at);
contents["public/self-source.json"] = renderShippedSource(contents, at);

const paths = Object.keys(contents).sort();
const stamp = dosTime(new Date(at));
const locals = [];
const centrals = [];
let offset = 0;

for (const path of paths) {
  const data = Buffer.from(contents[path], "utf8");
  const deflated = deflateRawSync(data, { level: 9 });
  // Store uncompressed if squeezing made it bigger (tiny files often do).
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;
  const name = Buffer.from(`${ROOT_DIR}/${path}`, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(stamp.time, 10);
  local.writeUInt16LE(stamp.day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(stamp.time, 12);
  central.writeUInt16LE(stamp.day, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  // External attributes carry a regular-file mode, so every entry unpacks as a
  // file and no archive reader has to guess.
  central.writeUInt32LE((((0o644 | 0o100000) << 16) >>> 0), 38);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);

  offset += local.length + name.length + body.length;
}

const centralBuffer = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(paths.length, 8);
end.writeUInt16LE(paths.length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);

await writeFile(OUT, Buffer.concat([...locals, centralBuffer, end]));

const { size } = await stat(OUT);
console.log(
  `${relative(ROOT, OUT)}: ${paths.length} files, ` +
    `${(size / 1048576).toFixed(1)} MB, rooted at ${ROOT_DIR}/ — taken ${at}.`,
);

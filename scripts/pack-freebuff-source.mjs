#!/usr/bin/env node
/**
 * Pack the Freebuff (Codebuff) reference source into the archive the offline
 * brain ships, so a downloaded copy never has to fetch it at install time.
 *
 *   node scripts/pack-freebuff-source.mjs [source-tree]
 *
 * The source tree is the upstream monorepo (Apache-2.0), kept next to the
 * project rather than in it — `offline-ai-coding-brain/` is gitignored, because
 * 63 MB of someone else's tree does not belong in this repository. What *is*
 * shipped is this archive, and it is written into the package itself:
 *
 *   public/offline-brain/source/freebuff-source.zip
 *
 * which `/offline-brain/source/` then serves, and which every download on the
 * Offline Brain page carries inside it.
 *
 * Why a zip and not the upstream `.tar.gz`: this project's dev server (and any
 * static server that maps extensions) answers a request for `*.gz` with
 * `Content-Encoding: gzip` over bytes that are already gzip, so a browser
 * transparently un-gzips it and hands back a *tar*. A `.zip` is served as
 * ordinary bytes, which is what an archive has to be. `unzip` is everywhere,
 * and `python3 -m zipfile -e` is the fallback the installer scripts use.
 *
 * The archive is rooted at `freebuff/`, so extracting it into the package's
 * `source/` directory lands the tree exactly where the documentation points.
 */
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { join, relative, sep } from "node:path";

const SRC = process.argv[2] ?? "offline-ai-coding-brain/source/freebuff";
const OUT = "public/offline-brain/source/freebuff-source.zip";
const ROOT = "freebuff";

/** Never part of the tree worth reading, and never ours to redistribute. */
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".vite"]);

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

async function walk(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), found);
      continue;
    }
    if (entry.isFile()) found.push(join(dir, entry.name));
  }
  return found;
}

const files = (await walk(SRC)).sort();
if (files.length === 0) {
  console.error(`no files under ${SRC} — nothing to pack.`);
  process.exit(1);
}

const stamp = dosTime(new Date());
const locals = [];
const centrals = [];
let offset = 0;

for (const path of files) {
  const data = await readFile(path);
  const mode = (await stat(path)).mode;
  const deflated = deflateRawSync(data, { level: 9 });
  // Store uncompressed if squeezing made it bigger (tiny files often do).
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;
  const name = Buffer.from(
    `${ROOT}/${relative(SRC, path).split(sep).join("/")}`,
    "utf8",
  );
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
  // External attributes carry the unix mode, so the tree keeps its +x bits.
  central.writeUInt32LE((((mode & 0o7777) | 0o100000) << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);

  offset += local.length + name.length + body.length;
}

const centralBuffer = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);

await writeFile(OUT, Buffer.concat([...locals, centralBuffer, end]));

const { size } = await stat(OUT);
console.log(
  `${OUT}: ${files.length} files, ${(size / 1048576).toFixed(1)} MB, rooted at ${ROOT}/`,
);

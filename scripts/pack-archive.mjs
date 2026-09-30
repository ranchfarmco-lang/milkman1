#!/usr/bin/env node
/**
 * Bundle this app's source into a single .tar.gz, for the times a GitHub
 * token is not available and the files have to reach GitHub another way —
 * drag the archive onto the repo's "upload files" page.
 *
 *   node scripts/pack-archive.mjs [output.tar.gz|output.zip]
 *
 * The file list comes from the same `.gitignore` rules and the same walk as
 * scripts/push-to-github.mjs, so the archive holds exactly the files a push
 * would upload: no node_modules, no local Convex state, no .env files, no keys.
 *
 * A .zip output is built here in pure Node (this image has no `zip` binary) and
 * unpacks with one double-click on Windows or macOS, which is why it is the
 * easier download for someone moving the project onto a computer.
 */
import { spawn } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";

const OUT = process.argv[2] ?? "family-chat-hub-source.tar.gz";

/** Turn one `.gitignore` line into a matcher. Supports the subset used here. */
function rule(line) {
  const negated = line.startsWith("!");
  const body = (negated ? line.slice(1) : line).replace(/\/+$/, "");
  if (!body) return null;
  const anchored = body.includes("/");
  const source = body
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return {
    negated,
    re: new RegExp(anchored ? `^${source}(/|$)` : `(^|/)${source}(/|$)`),
  };
}

async function loadRules() {
  let text = "";
  try {
    text = await readFile(".gitignore", "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(rule)
    .filter(Boolean);
}

function ignored(path, rules) {
  let verdict = false;
  for (const r of rules) if (r.re.test(path)) verdict = !r.negated;
  return verdict;
}

async function walk(dir, rules, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = relative(".", join(dir, entry.name)).split(sep).join("/");
    if (entry.name === ".git" || entry.name === ".vly-run") continue;
    // The archive must never contain itself.
    if (rel === OUT) continue;
    if (ignored(rel, rules)) continue;
    if (entry.isDirectory()) await walk(join(dir, entry.name), rules, found);
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

const rules = await loadRules();
const files = (await walk(".", rules)).sort();

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
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** Write a zip holding `files`, rooted at a single top-level folder. */
async function writeZip(out, list) {
  const root = "family-chat-hub";
  const stamp = dosTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const path of list) {
    const data = await readFile(path);
    const deflated = deflateRawSync(data, { level: 9 });
    // Store uncompressed if squeezing made it bigger (tiny files often do).
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const name = Buffer.from(`${root}/${path}`, "utf8");
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
    central.writeUInt32LE(0o644 << 16, 38); // external attrs: regular file
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  await writeFile(out, Buffer.concat([...locals, centralBuffer, end]));
}

if (OUT.endsWith(".zip")) {
  await writeZip(OUT, files);
} else {
  // Feeding the list on stdin keeps the shell out of it, so no filename can be
  // reinterpreted as a flag or a glob by a shell. Every entry is a regular file
  // already (the walk descends directories itself), so no recursion is wanted.
  const tar = spawn("tar", ["--no-recursion", "-czf", OUT, "-T", "-"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  tar.stdin.end(files.join("\n") + "\n");
  const code = await new Promise((resolve) => tar.on("close", resolve));
  if (code !== 0) {
    console.error(`tar exited with code ${code}`);
    process.exit(code ?? 1);
  }
}

const { size } = await stat(OUT);
console.log(
  `${OUT}: ${files.length} files, ${(size / 1048576).toFixed(2)} MB ` +
    `(the same ${files.length} files a push would upload)`,
);

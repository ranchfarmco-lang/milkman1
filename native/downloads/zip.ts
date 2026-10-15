/**
 * A ZIP writer the native host carries with it.
 *
 * The host has to be able to hand a user a real archive — the source bundle,
 * the installer scripts, the checksums file — on a machine that has nothing
 * installed. Depending on a library would mean the host could not run before it
 * had already run. So the archive is written here, in about a hundred lines,
 * with no dependency and no compression (method 0, "stored"): the contents are
 * text and small binaries, and every operating system, `unzip` and Python's
 * `zipfile` reads a stored archive without complaint.
 */

import { createHash } from "node:crypto";

export type ZipEntry = { path: string; data: string | Uint8Array };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function cleanPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

function dosDateTime(when: Date): { time: number; day: number } {
  return {
    time:
      ((when.getHours() & 0x1f) << 11) |
      ((when.getMinutes() & 0x3f) << 5) |
      (Math.floor(when.getSeconds() / 2) & 0x1f),
    day:
      (((Math.max(1980, when.getFullYear()) - 1980) & 0x7f) << 9) |
      (((when.getMonth() + 1) & 0x0f) << 5) |
      (when.getDate() & 0x1f),
  };
}

class Writer {
  private parts: Uint8Array[] = [];
  length = 0;
  push(part: Uint8Array) {
    this.parts.push(part);
    this.length += part.length;
  }
  u16(value: number) {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value & 0xffff, true);
    this.push(bytes);
  }
  u32(value: number) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    this.push(bytes);
  }
  done(): Buffer {
    return Buffer.concat(this.parts, this.length);
  }
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8 = 0x0800;

/** Pack entries into a real `.zip` buffer. */
export function zipBytes(entries: ZipEntry[], when = new Date()): Buffer {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(when);
  const body = new Writer();
  const central = new Writer();
  let count = 0;

  for (const entry of entries) {
    const name = encoder.encode(cleanPath(entry.path));
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(data);
    const offset = body.length;

    body.u32(LOCAL);
    body.u16(20);
    body.u16(UTF8);
    body.u16(0);
    body.u16(time);
    body.u16(day);
    body.u32(crc);
    body.u32(data.length);
    body.u32(data.length);
    body.u16(name.length);
    body.u16(0);
    body.push(name);
    body.push(data);

    central.u32(CENTRAL);
    central.u16(20);
    central.u16(20);
    central.u16(UTF8);
    central.u16(0);
    central.u16(time);
    central.u16(day);
    central.u32(crc);
    central.u32(data.length);
    central.u32(data.length);
    central.u16(name.length);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(0);
    central.u32(offset);
    central.push(name);
    count += 1;
  }

  if (count > 0xffff) throw new Error(`That is ${count} files, more than one ZIP can index.`);

  const centralBytes = central.done();
  const centralOffset = body.length;
  body.push(centralBytes);
  body.u32(END);
  body.u16(0);
  body.u16(0);
  body.u16(count);
  body.u16(count);
  body.u32(centralBytes.length);
  body.u32(centralOffset);
  body.u16(0);
  return body.done();
}

/**
 * The checksum every download card shows (§35). It is computed over the exact
 * bytes the browser will receive, so the value on the card is the value of the
 * file — not of some intermediate.
 */
export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** "18.9 MB", for a card that has to say how big something is. */
export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

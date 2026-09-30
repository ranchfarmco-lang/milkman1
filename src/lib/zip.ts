/**
 * A ZIP writer with no dependency behind it.
 *
 * The hub hands you a backup as a single `.zip` you can open on any computer.
 * Rather than pull in a compression library, this stores each file as-is
 * (method 0) — the contents are text, so the archive is nearly the size of the
 * files themselves, and every operating system, `unzip`, and Python's
 * `zipfile` reads it without complaint.
 *
 * Everything is built here in the browser from bytes already in hand. Nothing
 * is uploaded to produce it.
 */

/** Paths inside an archive are always forward-slashed, whatever the platform. */
function archivePath(path: string) {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

/** DOS packs a timestamp into two 16-bit words, and starts counting at 1980. */
function dosDateTime(when: Date) {
  const time =
    ((when.getHours() & 0x1f) << 11) |
    ((when.getMinutes() & 0x3f) << 5) |
    (Math.floor(when.getSeconds() / 2) & 0x1f);
  const day =
    (((Math.max(1980, when.getFullYear()) - 1980) & 0x7f) << 9) |
    (((when.getMonth() + 1) & 0x0f) << 5) |
    (when.getDate() & 0x1f);
  return { time, day };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** The checksum every ZIP entry carries, so a reader knows nothing was lost. */
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One thing in the archive: a path, and its text or raw bytes. */
export type ZipEntry = { path: string; data: string | Uint8Array };

/** Collects bytes, then hands them back as one array. Little-endian, as ZIP is. */
class ByteWriter {
  private chunks: Uint8Array[] = [];
  length = 0;

  bytes(part: Uint8Array) {
    this.chunks.push(part);
    this.length += part.length;
  }

  u16(value: number) {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value & 0xffff, true);
    this.bytes(bytes);
  }

  u32(value: number) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    this.bytes(bytes);
  }

  done() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
/** Bit 11 tells a reader the names are UTF-8, so accents survive. */
const UTF8_FLAG = 0x0800;

/**
 * Pack entries into a ZIP. Entries are written in the order given, so a backup
 * can put its README first and the rest in a predictable order.
 */
export function zipBytes(entries: ZipEntry[], when = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(when);
  const body = new ByteWriter();
  const central = new ByteWriter();
  let count = 0;
  let truncated = 0;

  for (const entry of entries) {
    const name = encoder.encode(archivePath(entry.path));
    const data =
      typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(data);
    const offset = body.length;

    // Local header, then the name, then the bytes themselves.
    body.u32(LOCAL_HEADER);
    body.u16(20);
    body.u16(UTF8_FLAG);
    body.u16(0); // stored, not compressed
    body.u16(time);
    body.u16(day);
    body.u32(crc);
    body.u32(data.length);
    body.u32(data.length);
    body.u16(name.length);
    body.u16(0); // no extra field
    body.bytes(name);
    body.bytes(data);

    // The central directory repeats the same facts and records where to find them.
    central.u32(CENTRAL_HEADER);
    central.u16(20);
    central.u16(20);
    central.u16(UTF8_FLAG);
    central.u16(0);
    central.u16(time);
    central.u16(day);
    central.u32(crc);
    central.u32(data.length);
    central.u32(data.length);
    central.u16(name.length);
    central.u16(0);
    central.u16(0); // no comment
    central.u16(0);
    central.u16(0);
    central.u32(0); // no external attributes
    central.u32(offset);
    central.bytes(name);

    count += 1;
  }

  // A reader is told how many entries to expect; a zip cannot hold more than
  // 65,535 without ZIP64, which a source backup will never approach.
  if (count > 0xffff) truncated = count - 0xffff;
  const listed = Math.min(count, 0xffff);

  const centralBytes = central.done();
  const centralOffset = body.length;
  body.bytes(centralBytes);

  body.u32(END_OF_CENTRAL);
  body.u16(0);
  body.u16(0);
  body.u16(listed);
  body.u16(listed);
  body.u32(centralBytes.length);
  body.u32(centralOffset);
  body.u16(0); // no archive comment

  if (truncated) {
    // Never silently drop files: say so rather than hand back a zip that only
    // pretends to be complete.
    throw new Error(
      `That is ${count} files, more than one zip can index (${truncated} over the limit).`,
    );
  }

  return body.done();
}

/** The same archive as a file the browser can save in one click. */
export function zipBlob(entries: ZipEntry[], when = new Date()): Blob {
  const bytes = zipBytes(entries, when);
  // A Blob wants an ArrayBuffer rather than a view onto one, and copying here
  // also means the archive is not affected by anything that later reuses the
  // bytes.
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([buffer], { type: "application/zip" });
}

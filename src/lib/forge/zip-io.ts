/**
 * Taking a project out and bringing one back in, as a single `.zip`.
 *
 * Export reuses the hub's dependency-free ZIP writer (`@/lib/zip`), so what
 * lands on disk is the same format the hub's own backups use. Import is the
 * mirror: a small reader over the central directory that handles stored (0)
 * and deflate (8) entries — the two methods any tool writes by default —
 * using the browser's own `DecompressionStream` for the compressed half.
 */
import { downloadBlob, safeFileName } from "@/lib/download";
import { zipBlob, type ZipEntry } from "@/lib/zip";

type RawZip = { path: string; content: string };

/** Build the archive for a set of files (project or sandbox). */
export function buildZip(files: { path: string; content: string }[]): Blob {
  const entries: ZipEntry[] = files.map((file) => ({ path: file.path, data: file.content }));
  return zipBlob(entries);
}

/** Export and download in one press: `<name>.zip`. */
export function downloadZip(name: string, files: { path: string; content: string }[]): number {
  const blob = buildZip(files);
  downloadBlob(`${safeFileName(name)}.zip`, blob);
  return files.length;
}

/* ------------------------------------------------------------------ reading */

const decoder = new TextDecoder();

function u16(view: DataView, at: number) {
  return view.getUint16(at, true);
}
function u32(view: DataView, at: number) {
  return view.getUint32(at, true);
}

/**
 * Read a ZIP's text files. Throws a plain sentence when the file is not a
 * zip or holds nothing readable — the import button shows that sentence.
 */
export async function readZip(blob: Blob): Promise<RawZip[]> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // End Of Central Directory: search the last 64 KB for its signature.
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 66_000);
  for (let index = bytes.length - 22; index >= floor; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("That file is not a ZIP archive.");

  const count = u16(view, eocd + 10);
  let offset = u32(view, eocd + 16);
  const files: RawZip[] = [];

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) break;

    const method = u16(view, offset + 10);
    const compressedSize = u32(view, offset + 20);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/") || !name || name.startsWith("__MACOSX/")) continue;
    if (view.getUint32(localOffset, true) !== 0x04034b50) continue;

    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const slice = bytes.subarray(dataStart, dataStart + compressedSize);

    let content: Uint8Array;
    if (method === 0) {
      content = slice;
    } else if (method === 8) {
      content = await inflateRaw(slice);
    } else {
      throw new Error(`The ZIP uses compression method ${method}, which this reader does not handle.`);
    }

    files.push({ path: name, content: decoder.decode(content) });
  }

  if (!files.length) throw new Error("The ZIP held no readable files.");
  return files;
}

/** Raw deflate via the browser's own decompressor. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress ZIP entries (no DecompressionStream).");
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

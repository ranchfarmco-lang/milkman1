/**
 * §48 — a real QR code, generated here.
 *
 * The specification is clear that the QR must point at the actual active remote
 * portal, and equally clear that it must not carry administrator credentials.
 * Both are satisfied by construction: the encoder is given the portal URL and
 * nothing else, and the URL is the one the relay assigned — if the tunnel is not
 * connected there is no URL and therefore no QR.
 *
 * The implementation is deliberately bounded rather than general: byte mode,
 * error-correction level L, versions 1 to 5 (21×21 up to 37×37 modules), which
 * holds up to 106 bytes — more than any portal address needs. Within that range
 * every version is a single Reed–Solomon block and none needs a version-info
 * block, which is what keeps this short enough to be verifiable by reading it.
 * A long address is refused with a message instead of a broken code.
 *
 * Returning SVG rather than a raster image means the code is crisp on any
 * screen, scales, and prints without a resolution to choose.
 */

/* ------------------------------------------------------- GF(256) arithmetic -- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR field's primitive polynomial
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** The Reed–Solomon generator polynomial for `degree` error-correction words. */
function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function errorCorrection(data: number[], degree: number): number[] {
  const generator = generatorPoly(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) remainder[i] ^= gfMul(generator[i + 1], factor);
  }
  return remainder;
}

/* --------------------------------------------------------------- versions --- */

/**
 * The five versions this encoder covers. `dataWords` and `ecWords` are the
 * standard tables for level L; every one of them is a single block.
 */
const VERSIONS = [
  { version: 1, totalWords: 26, dataWords: 19, ecWords: 7, alignment: [] as number[] },
  { version: 2, totalWords: 44, dataWords: 34, ecWords: 10, alignment: [18] },
  { version: 3, totalWords: 70, dataWords: 55, ecWords: 15, alignment: [22] },
  { version: 4, totalWords: 100, dataWords: 80, ecWords: 20, alignment: [26] },
  { version: 5, totalWords: 134, dataWords: 108, ecWords: 26, alignment: [30] },
];

const MAX_BYTES = VERSIONS[VERSIONS.length - 1].dataWords - 2; // 4-bit mode + 8-bit count

export type QrMatrix = { size: number; modules: boolean[][]; version: number; bytes: number };

class BitWriter {
  private bits: number[] = [];

  push(value: number, count: number) {
    for (let i = count - 1; i >= 0; i -= 1) this.bits.push((value >> i) & 1);
  }

  get length() {
    return this.bits.length;
  }

  toCodewords(totalWords: number): number[] {
    const words: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      words.push(byte);
    }
    // § terminator: four zero bits, then pad to a byte boundary.
    if (words.length < totalWords) {
      const remainder = this.bits.length % 8;
      if (remainder) words[words.length - 1] <<= 8 - remainder;
      while (words.length < totalWords) {
        // The two alternating pad bytes the standard names.
        words.push(words.length % 2 === 0 ? 0xec : 0x11);
      }
    }
    return words.slice(0, totalWords);
  }
}

/* ------------------------------------------------------------ the encoder --- */

/** Encode `text` as a QR matrix. Throws when the text does not fit. */
export function encode(text: string): QrMatrix {
  const data = new TextEncoder().encode(text);
  if (data.length > MAX_BYTES) {
    throw new Error(
      `That address is ${data.length} bytes; this encoder covers up to ${MAX_BYTES}. Use the copy button instead of the code.`,
    );
  }

  const spec = VERSIONS.find((candidate) => candidate.dataWords - 2 >= data.length);
  if (!spec) throw new Error("That address does not fit any version this encoder covers.");

  // Mode indicator (0100 = byte), then the character count, then the bytes.
  const bits = new BitWriter();
  bits.push(0b0100, 4);
  bits.push(data.length, 8);
  for (const byte of data) bits.push(byte, 8);

  const words = bits.toCodewords(spec.dataWords);
  const matrix = buildMatrix(spec.version, spec.alignment, [...words, ...errorCorrection(words, spec.ecWords)]);

  return { size: matrix.length, modules: matrix, version: spec.version, bytes: data.length };
}

function bitLength(value: number): number {
  let length = 0;
  while (value !== 0) {
    length += 1;
    value >>>= 1;
  }
  return length;
}

/**
 * Format information: the five data bits (level L, mask 0), a BCH(15,5) code
 * over them, then the fixed XOR the standard requires. This exact routine is
 * what every QR reader expects to find around the finder patterns.
 */
function formatInformation(data: number): number {
  let remainder = data << 10;
  while (bitLength(remainder) - bitLength(0x537) >= 0) {
    remainder ^= 0x537 << (bitLength(remainder) - bitLength(0x537));
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function buildMatrix(version: number, alignment: number[], codewords: number[]): boolean[][] {
  const size = 17 + version * 4;
  const modules: (boolean | null)[][] = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const set = (row: number, col: number, dark: boolean) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    modules[row][col] = dark;
    reserved[row][col] = true;
  };

  // Finder patterns, with their separators.
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let row = -1; row <= 7; row += 1) {
      for (let col = -1; col <= 7; col += 1) {
        const inRing = row >= 0 && row <= 6 && col >= 0 && col <= 6;
        const dark =
          inRing &&
          (row === 0 || row === 6 || col === 0 || col === 6 || (row >= 2 && row <= 4 && col >= 2 && col <= 4));
        set(top + row, left + col, dark);
      }
    }
  }

  // Timing patterns, between the separators.
  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Alignment patterns (one per version in this range).
  for (const centre of alignment) {
    for (let row = -2; row <= 2; row += 1) {
      for (let col = -2; col <= 2; col += 1) {
        set(centre + row, centre + col, Math.max(Math.abs(row), Math.abs(col)) !== 1);
      }
    }
  }

  // Reserve the format-information cells and the dark module BEFORE the data
  // goes in, or the placement walk would write over them.
  const formatCells: [number, number][] = [];
  for (let i = 0; i < 15; i += 1) {
    if (i < 6) formatCells.push([i, 8]);
    else if (i < 8) formatCells.push([i + 1, 8]);
    else formatCells.push([size - 15 + i, 8]);

    if (i < 8) formatCells.push([8, size - i - 1]);
    else if (i < 9) formatCells.push([8, 15 - i - 1 + 1]);
    else formatCells.push([8, 15 - i - 1]);
  }
  for (const [row, col] of formatCells) set(row, col, false);
  set(size - 8, 8, true);

  // Data, in the standard two-column zigzag from the bottom right. The pair
  // index — not the column number — decides which way each pair runs, because
  // column 6 is skipped.
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  const bitAt = (index: number): boolean => {
    const word = codewords[index >> 3] ?? 0;
    return ((word >> (7 - (index & 7))) & 1) === 1;
  };

  let pair = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = pair % 2 === 0;
    for (let offset = 0; offset < size; offset += 1) {
      const row = upward ? size - 1 - offset : offset;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        const dark = bitIndex < totalBits ? bitAt(bitIndex) : false;
        // Mask 0: the data bit is XORed with (row + column) being even.
        modules[row][col] = dark !== ((row + col) % 2 === 0);
        bitIndex += 1;
      }
    }
    pair += 1;
  }

  // Format information: level L (01) with mask 0.
  const format = formatInformation((0b01 << 3) | 0b000);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((format >> i) & 1) === 1;
    if (i < 6) modules[i][8] = dark;
    else if (i < 8) modules[i + 1][8] = dark;
    else modules[size - 15 + i][8] = dark;

    if (i < 8) modules[8][size - i - 1] = dark;
    else if (i < 9) modules[8][15 - i - 1 + 1] = dark;
    else modules[8][15 - i - 1] = dark;
  }
  modules[size - 8][8] = true;

  return modules.map((row) => row.map((value) => value === true));
}

/* --------------------------------------------------------------- rendering --- */

/** §48 — the code as an SVG, with a quiet zone and no dependency. */
export function toSvg(text: string, options: { scale?: number; quiet?: number } = {}): string {
  const { scale = 6, quiet = 4 } = options;
  const matrix = encode(text);
  const total = (matrix.size + quiet * 2) * scale;
  const rects: string[] = [];

  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (!matrix.modules[row][col]) continue;
      rects.push(
        `<rect x="${(col + quiet) * scale}" y="${(row + quiet) * scale}" width="${scale}" height="${scale}"/>`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" role="img" aria-label="QR code for the remote portal address"><rect width="${total}" height="${total}" fill="#ffffff"/><g fill="#000000">${rects.join("")}</g></svg>`;
}

/** What the caller needs to decide whether a QR is possible at all. */
export function qrCapability(): { maxBytes: number; versions: number } {
  return { maxBytes: MAX_BYTES, versions: VERSIONS.length };
}

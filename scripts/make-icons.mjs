/**
 * Renders the PNG app icons a phone and a computer actually ask for.
 *
 * A manifest that only offers an SVG is refused for installation by Android and
 * ignored by iOS, so the same artwork as public/logo.svg is rasterised here at
 * the sizes those platforms require. No image library is involved: the shapes
 * are a rounded square and four bars, so they are sampled directly and written
 * as a PNG at the end.
 *
 * Run it with `bun run icons` after changing the logo geometry below.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "icons");

/* Geometry lifted straight out of public/logo.svg (viewBox 96.81). */
const VIEW = 96.81;
const CORNER_RADIUS = 18;
const BARS = [
  { x: 24.67, y: 24.67, w: 47.47, h: 11.87 },
  { x: 24.67, y: 36.54, w: 11.87, h: 35.61 },
  { x: 40.06, y: 39.98, w: 23.74, h: 11.87 },
  { x: 40.06, y: 51.85, w: 11.87, h: 20.3 },
];

/* --------------------------------------------------------------- rasterise */

function insideRoundedRect(px, py, box, radius) {
  if (radius <= 0) {
    return px >= box.x && px < box.x + box.w && py >= box.y && py < box.y + box.h;
  }
  const rx = Math.min(radius, box.w / 2);
  const ry = Math.min(radius, box.h / 2);
  // Clamp into the inner rectangle, then measure the distance to the corner.
  const cx = Math.min(Math.max(px, box.x + rx), box.x + box.w - rx);
  const cy = Math.min(Math.max(py, box.y + ry), box.y + box.h - ry);
  if (px >= box.x && px < box.x + box.w && py >= box.y && py < box.y + box.h) {
    if (px >= box.x + rx && px < box.x + box.w - rx) return true;
    if (py >= box.y + ry && py < box.y + box.h - ry) return true;
  }
  const dx = px - cx;
  const dy = py - cy;
  return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
}

/**
 * Black plate with the white bars on top. Corners are anti-aliased by sampling
 * each pixel several times and averaging, so the icon does not look jagged.
 */
function renderIcon({ size, out, shape, art }) {
  const pixel = Buffer.alloc(size * size * 4);
  const artSide = size * art;
  const artOffset = (size - artSide) / 2;
  const scale = artSide / VIEW;

  const plate = { x: 0, y: 0, w: size, h: size };
  const radius = shape === "rounded" ? (CORNER_RADIUS / VIEW) * size : 0;

  const samples = 3;
  const step = 1 / samples;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let opaque = 0;
      let white = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;

          if (!insideRoundedRect(px, py, plate, radius)) continue;
          opaque++;

          // Back into logo coordinates to test the bars.
          const lx = (px - artOffset) / scale;
          const ly = (py - artOffset) / scale;
          const onBar = BARS.some(
            (bar) =>
              lx >= bar.x &&
              lx < bar.x + bar.w &&
              ly >= bar.y &&
              ly < bar.y + bar.h,
          );
          if (onBar) white++;
        }
      }

      const total = samples * samples;
      const index = (y * size + x) * 4;
      if (opaque === 0) continue;

      // White and black are both fully opaque, so the colour averages over the
      // samples that landed on the icon while alpha averages over every sample.
      const value = Math.round((white / opaque) * 255);
      pixel[index] = value;
      pixel[index + 1] = value;
      pixel[index + 2] = value;
      pixel[index + 3] = Math.round((opaque / total) * 255);
    }
  }

  return encodePng(size, size, pixel);
}

/* -------------------------------------------------------------- png writer */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Every scanline is prefixed with its filter byte (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- output */

const ICONS = [
  // The app icon itself: the logo, rounded corners and all.
  { file: "icon-192.png", size: 192, shape: "rounded", art: 1 },
  { file: "icon-512.png", size: 512, shape: "rounded", art: 1 },
  // Maskable icons are cropped by the launcher, so the artwork stays well
  // inside the safe zone and the plate bleeds to every edge.
  { file: "icon-maskable-512.png", size: 512, shape: "bleed", art: 0.6 },
  // iOS ignores the manifest icons and wants an opaque 180px square instead.
  { file: "apple-touch-icon.png", size: 180, shape: "bleed", art: 0.72 },
];

mkdirSync(OUT, { recursive: true });

for (const icon of ICONS) {
  const png = renderIcon(icon);
  writeFileSync(join(OUT, icon.file), png);
  console.log(`public/icons/${icon.file}  ${icon.size}×${icon.size}  ${png.length} bytes`);
}

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.resolve(__dirname, '..', 'icons');

/**
 * Compute CRC32 checksum for PNG chunk encoding.
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Create a PNG chunk buffer.
 * @param {string} type
 * @param {Buffer} data
 * @returns {Buffer}
 */
function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([len, combined, crcBuf]);
}

/**
 * Encode RGBA pixel buffer into a valid PNG buffer.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type 0 (None)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Signed distance to a rounded rectangle centered at (cx, cy).
 */
function sdRoundedBox(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - halfW + r;
  const qy = Math.abs(py - cy) - halfH + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

/**
 * Alpha-blend src RGBA over dst RGBA in place.
 */
function blendPixel(rgba, idx, r, g, b, a) {
  const srcA = a / 255;
  const dstA = rgba[idx + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  rgba[idx] = Math.round((r * srcA + rgba[idx] * dstA * (1 - srcA)) / outA);
  rgba[idx + 1] = Math.round((g * srcA + rgba[idx + 1] * dstA * (1 - srcA)) / outA);
  rgba[idx + 2] = Math.round((b * srcA + rgba[idx + 2] * dstA * (1 - srcA)) / outA);
  rgba[idx + 3] = Math.round(outA * 255);
}

/**
 * Render PageStitch icon at the given square size.
 * @param {number} size
 * @returns {Uint8Array}
 */
function renderIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const margin = size * 0.06;
  const half = size / 2 - margin;
  const radius = size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const idx = (y * size + x) * 4;

      // Background rounded badge with blue-indigo gradient
      const bgDist = sdRoundedBox(px, py, cx, cy, half, half, radius);
      if (bgDist < 0.75) {
        const alpha = Math.max(0, Math.min(1, 0.75 - bgDist));
        const t = (px + py) / (2 * size);
        const r = Math.round(37 + t * 28);
        const g = Math.round(99 - t * 24);
        const b = Math.round(235 - t * 10);
        blendPixel(rgba, idx, r, g, b, Math.round(alpha * 255));
      }

      // Draw stacked "stitch pages" camera frame glyph in white
      const outerHalfW = size * 0.27;
      const outerHalfH = size * 0.27;
      const stroke = Math.max(1.2, size * 0.075);

      // Upper page card
      const card1Dist = sdRoundedBox(px, py, cx, cy - size * 0.08, outerHalfW, outerHalfH * 0.52, size * 0.05);
      // Lower page card
      const card2Dist = sdRoundedBox(px, py, cx, cy + size * 0.11, outerHalfW, outerHalfH * 0.52, size * 0.05);

      const isRing1 = Math.abs(card1Dist) <= stroke * 0.55;
      const isRing2 = Math.abs(card2Dist) <= stroke * 0.55;

      if (isRing1 || isRing2) {
        const d = Math.min(Math.abs(card1Dist), Math.abs(card2Dist));
        const aa = Math.max(0, Math.min(1, (stroke * 0.65 - d) / 0.8 + 0.5));
        blendPixel(rgba, idx, 255, 255, 255, Math.round(aa * 245));
      }

      // Center stitch accent bar (cyan-white)
      const stitchDist = sdRoundedBox(px, py, cx, cy + size * 0.015, size * 0.15, Math.max(0.8, size * 0.03), size * 0.015);
      if (stitchDist < 0.6) {
        const aa = Math.max(0, Math.min(1, 0.6 - stitchDist));
        blendPixel(rgba, idx, 165, 243, 252, Math.round(aa * 255));
      }
    }
  }

  return rgba;
}

fs.mkdirSync(ICONS_DIR, { recursive: true });

for (const size of [16, 48, 128]) {
  const pixels = renderIcon(size);
  const png = encodePng(size, size, pixels);
  const outPath = path.join(ICONS_DIR, `icon-${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Generated ${outPath} (${size}x${size}, ${png.length} bytes)`);
}

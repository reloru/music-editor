/**
 * Draws the app icons and writes them as PNGs.
 *
 * Node has zlib built in, and a PNG is just a handful of length-prefixed,
 * CRC-checked chunks around a zlib stream, so this needs no dependencies — and
 * the icons stay reproducible from source instead of arriving as binary blobs
 * nobody can edit. Run with `npm run icons`.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BACKGROUND_TOP = [22, 32, 58];
const BACKGROUND_BOTTOM = [13, 17, 23];
const BAR_COLOR = [61, 125, 255];
const BAR_HIGHLIGHT = [159, 196, 255];

/** Relative bar heights, 0…1. A waveform silhouette rather than a literal one. */
const BARS = [0.22, 0.45, 0.72, 0.95, 0.6, 0.85, 0.35, 0.68, 0.5, 0.28];

function drawIcon(size, { safeZone = 1 } = {}) {
  const pixels = new Uint8Array(size * size * 4);

  // Vertical gradient background.
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const r = Math.round(BACKGROUND_TOP[0] + (BACKGROUND_BOTTOM[0] - BACKGROUND_TOP[0]) * t);
    const g = Math.round(BACKGROUND_TOP[1] + (BACKGROUND_BOTTOM[1] - BACKGROUND_TOP[1]) * t);
    const b = Math.round(BACKGROUND_TOP[2] + (BACKGROUND_BOTTOM[2] - BACKGROUND_TOP[2]) * t);
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4;
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = b;
      pixels[at + 3] = 255;
    }
  }

  // Waveform bars, centred, kept inside the maskable safe zone.
  const usable = size * 0.62 * safeZone;
  const left = (size - usable) / 2;
  const slot = usable / BARS.length;
  const barWidth = Math.max(2, Math.round(slot * 0.52));
  const radius = barWidth / 2;
  const center = size / 2;

  BARS.forEach((height, index) => {
    const x0 = Math.round(left + index * slot + (slot - barWidth) / 2);
    const half = (height * size * 0.34 * safeZone) / 2;
    const color = index % 3 === 0 ? BAR_HIGHLIGHT : BAR_COLOR;

    for (let y = Math.floor(center - half); y <= Math.ceil(center + half); y++) {
      if (y < 0 || y >= size) continue;
      for (let x = x0; x < x0 + barWidth; x++) {
        if (x < 0 || x >= size) continue;
        // Round the caps by skipping corner pixels outside the end radius.
        const overshoot = Math.abs(y - center) - (half - radius);
        if (overshoot > 0) {
          const dx = x - (x0 + barWidth / 2 - 0.5);
          if (dx * dx + overshoot * overshoot > radius * radius) continue;
        }
        const at = (y * size + x) * 4;
        pixels[at] = color[0];
        pixels[at + 1] = color[1];
        pixels[at + 2] = color[2];
        pixels[at + 3] = 255;
      }
    }
  });

  return pixels;
}

function encodePng(pixels, size) {
  // Each row is prefixed with a filter byte; filter 0 means "no filtering".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typeAndBody = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndBody), 0);
  return Buffer.concat([length, typeAndBody, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { name: 'apple-touch-icon.png', size: 180, safeZone: 1 },
  { name: 'icon-192.png', size: 192, safeZone: 1 },
  { name: 'icon-512.png', size: 512, safeZone: 1 },
  // Maskable icons get cropped to a circle by some launchers, so pull the
  // artwork into the inner 80%.
  { name: 'icon-maskable-512.png', size: 512, safeZone: 0.8 },
];

for (const target of targets) {
  const png = encodePng(drawIcon(target.size, { safeZone: target.safeZone }), target.size);
  writeFileSync(join(OUT_DIR, target.name), png);
  console.log(`wrote icons/${target.name} (${target.size}×${target.size}, ${png.length} bytes)`);
}

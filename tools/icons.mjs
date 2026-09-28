#!/usr/bin/env node
/**
 * Generates the PWA icons and the favicon the manifest and `index.html` point at.
 *
 * A script rather than committed-and-forgotten binaries, for the reason the
 * placeholder version gave and which has now come true: the mark arrived with
 * §9, and when it did the amber changed in one place.
 *
 * No image library. Writing a PNG by hand is a few lines of zlib and three
 * chunks, and it keeps the dependency out of a tree that §6.5 wants portable.
 *
 *   node tools/icons.mjs
 */

import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * §9's palette. The ground is `--screen` and not `#0b0b0b`: that was a neutral
 * near-black picked before the palette existed, and it made the install splash
 * a colder black than the machine it opens. Warm black, never `#000`.
 */
const BACKGROUND = [0x14, 0x0f, 0x0a];
const AMBER = [0xff, 0xb0, 0x00];

/**
 * The mark: the uncertainty ring, the player's dot inside it, and a beam
 * leaving through the lower right.
 *
 * It is the app's own two pictures rather than a logo invented for a launcher —
 * R-12's circle with the dot it is drawn around, and the sweep the player's own
 * position emits. What makes it legible at 48 px is the beam: it breaks the
 * ring, so the silhouette is asymmetric, and a round mark that is symmetric is
 * indistinguishable from forty other round marks in a grid.
 *
 * Radii are fractions of the half-width, so the whole thing scales by one
 * number — see `PURPOSES`.
 */
const RING_INNER = 0.62;
const RING_OUTER = 0.72;
const DOT = 0.16;
/** Radians, clockwise from east, because y is down. A narrow beam, not a pie. */
const BEAM_FROM = 0.45;
const BEAM_TO = 0.95;
const BEAM_REACH = 0.92;

/** The outermost lit point, which is what every scale below is computed from. */
const EXTENT = BEAM_REACH;

function lit(dx, dy, scale) {
  const x = dx / scale;
  const y = dy / scale;
  const r = Math.hypot(x, y);
  if (r <= DOT) return true;
  if (r >= RING_INNER && r <= RING_OUTER) return true;
  if (r > BEAM_REACH) return false;
  let a = Math.atan2(y, x);
  if (a < BEAM_FROM) a += Math.PI * 2;
  return a >= BEAM_FROM && a <= BEAM_TO;
}

/**
 * Two files, because `purpose: "any maskable"` on one is a compromise that
 * costs both of them.
 *
 * A maskable icon must keep every lit pixel inside a circle of 0,8 of the
 * half-width, because Android crops to a shape it does not tell you in advance.
 * That is 20% of the canvas spent on padding — correct on a launcher, and wrong
 * everywhere the icon is shown whole (a browser tab, a task switcher, an
 * install prompt), where it just reads as a small mark in a large box.
 *
 * Same drawing, two scales.
 */
const PURPOSES = [
  { suffix: '', purpose: 'any', scale: 0.96 / EXTENT },
  // 0,78 and not 0,80. Scaled to the safe circle exactly, the beam's
  // *antialiased fringe* lands at 0,8010 — one pixel outside, measured rather
  // than reasoned about, and enough for Android to shave the tip. The margin is
  // for the edge the supersampling adds, which the geometry does not know about.
  { suffix: '-maskable', purpose: 'maskable', scale: 0.78 / EXTENT },
];

/**
 * 4x4 supersampling, which the placeholder did not have.
 *
 * A hard `lit` boolean puts a stairstep on every curve, and the ring is nothing
 * but curve. It is invisible at 48 px because the launcher downscales, and
 * plainly visible at 192 on anything that draws it 1:1.
 */
const SS = 4;

function pixels(size, scale) {
  const half = size / 2;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    // Each scanline is prefixed with its filter type; 0 means none.
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const dx = (x + (sx + 0.5) / SS - half) / half;
          const dy = (y + (sy + 0.5) / SS - half) / half;
          if (lit(dx, dy, scale)) hits += 1;
        }
      }
      const a = hits / (SS * SS);
      for (let c = 0; c < 3; c += 1) {
        row[1 + x * 3 + c] = Math.round(BACKGROUND[c] + (AMBER[c] - BACKGROUND[c]) * a);
      }
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function png(size, scale) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2: truecolour RGB
  // bytes 10-12 stay zero: deflate, adaptive filtering, no interlace.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels(size, scale), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The same geometry as vectors, for the browser tab.
 *
 * A 192 px PNG in a 16 px tab is mush — the ring is a tenth of a pixel wide at
 * that size and the downscaler eats it. Browsers prefer `image/svg+xml` when it
 * is offered, and an SVG is text: no dependency, no asset pipeline, and the one
 * copy of the drawing stays in this file.
 */
function svg(scale) {
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  // A 100-unit box with the origin in the middle, so the fractions above are
  // the numbers that appear in the path.
  const R = 50;
  const at = (radius, angle) =>
    `${(radius * scale * R * Math.cos(angle)).toFixed(2)},${(radius * scale * R * Math.sin(angle)).toFixed(2)}`;
  const stroke = (RING_OUTER - RING_INNER) * scale * R;
  const mid = ((RING_OUTER + RING_INNER) / 2) * scale * R;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100">
  <rect x="-50" y="-50" width="100" height="100" fill="${hex(BACKGROUND)}"/>
  <circle cx="0" cy="0" r="${mid.toFixed(2)}" fill="none" stroke="${hex(AMBER)}" stroke-width="${stroke.toFixed(2)}"/>
  <circle cx="0" cy="0" r="${(DOT * scale * R).toFixed(2)}" fill="${hex(AMBER)}"/>
  <path d="M0,0 L${at(BEAM_REACH, BEAM_FROM)} A${(BEAM_REACH * scale * R).toFixed(2)},${(BEAM_REACH * scale * R).toFixed(2)} 0 0 1 ${at(BEAM_REACH, BEAM_TO)} Z" fill="${hex(AMBER)}"/>
</svg>
`;
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public');
mkdirSync(out, { recursive: true });

// 192 and 512 are what Chrome looks for to consider an app installable; 512 is
// also what it uses for the splash screen.
for (const { suffix, scale } of PURPOSES) {
  for (const size of [192, 512]) {
    const file = join(out, `icon-${size}${suffix}.png`);
    writeFileSync(file, png(size, scale));
    console.log(`${file}  ${size}x${size}`);
  }
}

const favicon = join(out, 'favicon.svg');
writeFileSync(favicon, svg(PURPOSES[0].scale));
console.log(`${favicon}  vector`);

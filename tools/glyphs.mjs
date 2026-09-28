#!/usr/bin/env node
/**
 * Turns a font into the SDF glyph ranges MapLibre asks for (R-69, §14.3).
 *
 * MapLibre draws text from **signed distance fields**, not from a font: it
 * fetches `{fontstack}/{range}.pbf`, and each glyph in there is a small alpha
 * bitmap whose values encode the distance to the glyph's edge. That is what lets
 * one texture scale, rotate and take a halo without re-rasterising, and it is
 * why a `.woff` in the bundle is no use to it — the browser can draw that, the
 * map cannot.
 *
 * Nothing on npm generates them any more without a native build: `fontnik`
 * wants node-gyp and FreeType, and the prebuilt ranges Protomaps publishes are
 * Noto Sans, which is neither of §9's two faces. So this does it, in about a
 * hundred lines, because the geometry is simple: rasterise nothing, and measure
 * the distance from each pixel centre to the outline itself.
 *
 *   node tools/glyphs.mjs            # writes apps/web/public/fonts/VT323/
 *   node tools/glyphs.mjs --check    # verify what is committed, write nothing
 *
 * ## The four numbers, and where they come from
 *
 * They are not conventions to be chosen, they are what the shader in the
 * MapLibre version we ship reads — `src/shaders/glsl/symbol_sdf.fragment.glsl`:
 *
 * - **em 24 px.** `fontScale = size / 24.0`, so a glyph rendered at any other
 *   size is the wrong weight at every zoom.
 * - **radius 8 px.** `#define SDF_PX 8.0`, and the halo width is divided by it.
 * - **edge at 0,75.** `inner_edge = (256.0 - 64.0) / 256.0`, so a pixel exactly
 *   on the outline has to encode 191, not 128.
 * - **border 3 px.** `const border = 3` in `src/style/parse_glyph_pbf.ts`, which
 *   is also what the bitmap's size is computed from on the way in: a glyph of
 *   `width × height` arrives as `(width + 6) × (height + 6)` bytes.
 *
 * Distance is positive **outside** the glyph, and the encoding is
 * `255 - 255 · (d / 8 + 0,25)` clamped: zero distance lands on 191,25 and six
 * pixels out lands on 0.
 */

import opentype from 'opentype.js';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const EM = 24;
const RADIUS = 8;
const CUTOFF = 0.25;
const BORDER = 3;
/** Curves are flattened to this many segments. VT323 is mostly rectangles. */
const CURVE_STEPS = 12;

const root = resolve(import.meta.dirname, '..');

/**
 * The faces, in the order a codepoint is looked for.
 *
 * Two files rather than one because Fontsource ships a subset per script:
 * `latin` covers U+0000–00FF, which is every character a Spanish street name
 * has, and `latin-ext` carries U+0100 upwards. A range nobody asks for costs
 * nothing — MapLibre requests only the ranges the labels on screen need.
 */
const FACES = [
  'apps/web/node_modules/@fontsource/vt323/files/vt323-latin-400-normal.woff',
  'apps/web/node_modules/@fontsource/vt323/files/vt323-latin-ext-400-normal.woff',
];
const FONTSTACK = 'VT323';
const RANGES = [
  [0, 255],
  [256, 511],
];

/* ------------------------------------------------------------------ */
/* Outlines                                                            */
/* ------------------------------------------------------------------ */

/** The path as flat contours, in the y-down space opentype hands back. */
function contoursOf(path) {
  const contours = [];
  let current = [];
  let start = null;
  let at = null;
  const push = (point) => {
    if (current.length === 0 || current.at(-1)[0] !== point[0] || current.at(-1)[1] !== point[1]) {
      current.push(point);
    }
  };
  const quad = (p0, c, p1) => {
    for (let i = 1; i <= CURVE_STEPS; i += 1) {
      const t = i / CURVE_STEPS;
      const u = 1 - t;
      push([
        u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
        u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
      ]);
    }
  };
  const cubic = (p0, c1, c2, p1) => {
    for (let i = 1; i <= CURVE_STEPS; i += 1) {
      const t = i / CURVE_STEPS;
      const u = 1 - t;
      push([
        u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
        u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
      ]);
    }
  };
  const close = () => {
    if (current.length > 2) contours.push(current);
    current = [];
  };

  for (const command of path.commands) {
    switch (command.type) {
      case 'M':
        close();
        start = [command.x, command.y];
        at = start;
        push(start);
        break;
      case 'L':
        at = [command.x, command.y];
        push(at);
        break;
      case 'Q':
        quad(at, [command.x1, command.y1], [command.x, command.y]);
        at = [command.x, command.y];
        break;
      case 'C':
        cubic(at, [command.x1, command.y1], [command.x2, command.y2], [command.x, command.y]);
        at = [command.x, command.y];
        break;
      case 'Z':
        if (start) push(start);
        close();
        at = start;
        break;
      default:
        throw new Error(`unexpected path command ${command.type}`);
    }
  }
  close();
  return contours;
}

/** Distance from a point to a segment, squared. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/**
 * Non-zero winding, which is the rule TrueType outlines are filled by: an
 * even-odd test would hollow out a counter that was drawn in the same direction
 * as its letter.
 */
function isInside(px, py, contours) {
  let winding = 0;
  for (const contour of contours) {
    for (let i = 0; i < contour.length - 1; i += 1) {
      const [ax, ay] = contour[i];
      const [bx, by] = contour[i + 1];
      if (ay <= py) {
        if (by > py && (bx - ax) * (py - ay) - (px - ax) * (by - ay) > 0) winding += 1;
      } else if (by <= py && (bx - ax) * (py - ay) - (px - ax) * (by - ay) < 0) {
        winding -= 1;
      }
    }
  }
  return winding !== 0;
}

/* ------------------------------------------------------------------ */
/* One glyph                                                           */
/* ------------------------------------------------------------------ */

function sdfGlyph(font, codepoint) {
  const glyph = font.charToGlyph(String.fromCodePoint(codepoint));
  // Index 0 is `.notdef`. Emitting it would draw a box for every character the
  // face does not have, which is worse than the character being absent: MapLibre
  // simply leaves a gap and logs it.
  if (!glyph || glyph.index === 0) return null;

  const scale = EM / font.unitsPerEm;
  const advance = Math.round((glyph.advanceWidth ?? 0) * scale);
  const path = glyph.getPath(0, 0, EM);
  const contours = contoursOf(path);
  // A space has an advance and no ink. It has to be in the range anyway, or the
  // line breaks where the gap should be.
  if (contours.length === 0) {
    return { id: codepoint, bitmap: new Uint8Array(0), width: 0, height: 0, left: 0, top: 0, advance };
  }

  const box = path.getBoundingBox();
  const left = Math.floor(box.x1);
  const right = Math.ceil(box.x2);
  // opentype's y grows downward from the baseline; the metrics MapLibre wants
  // are measured upward from it (`y1 = -top - border` in its quad builder).
  const top = Math.ceil(-box.y1);
  const bottom = Math.floor(-box.y2);
  const width = Math.max(0, right - left);
  const height = Math.max(0, top - bottom);

  const stride = width + 2 * BORDER;
  const rows = height + 2 * BORDER;
  const bitmap = new Uint8Array(stride * rows);
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < stride; i += 1) {
      const x = left - BORDER + i + 0.5;
      const yUp = top + BORDER - j - 0.5;
      const y = -yUp;
      let best = Infinity;
      for (const contour of contours) {
        for (let k = 0; k < contour.length - 1; k += 1) {
          const d = distanceToSegment(x, y, contour[k][0], contour[k][1], contour[k + 1][0], contour[k + 1][1]);
          if (d < best) best = d;
        }
      }
      const distance = Math.sqrt(best) * (isInside(x, y, contours) ? -1 : 1);
      const value = 255 - 255 * (distance / RADIUS + CUTOFF);
      bitmap[j * stride + i] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  return { id: codepoint, bitmap, width, height, left, top, advance };
}

/* ------------------------------------------------------------------ */
/* The protobuf, hand-written because it is six fields                 */
/* ------------------------------------------------------------------ */

const varint = (value) => {
  const bytes = [];
  let n = value;
  while (n > 127) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return bytes;
};
const zigzag = (value) => (value << 1) ^ (value >> 31);
const tag = (field, wire) => varint((field << 3) | wire);
const delimited = (field, payload) => [...tag(field, 2), ...varint(payload.length), ...payload];

function encodeGlyph(glyph) {
  return [
    ...tag(1, 0),
    ...varint(glyph.id),
    /**
     * **Omitted rather than empty when there is no ink**, which is the one place
     * this format will take a plausible answer and throw.
     *
     * A space is `0 × 0` with a border, so MapLibre builds a 6 × 6 image for it
     * — and `createImage` allocates that itself when the field is *absent*, but
     * compares lengths when it is present. A zero-length `bytes` is present, so
     * it raises `mismatched image size` and the whole range fails to parse: no
     * text anywhere on the map, from the character that separates two words.
     */
    ...(glyph.bitmap.length > 0 ? delimited(2, [...glyph.bitmap]) : []),
    ...tag(3, 0),
    ...varint(glyph.width),
    ...tag(4, 0),
    ...varint(glyph.height),
    ...tag(5, 0),
    ...varint(zigzag(glyph.left)),
    ...tag(6, 0),
    ...varint(zigzag(glyph.top)),
    ...tag(7, 0),
    ...varint(glyph.advance),
  ];
}

function encodeRange(name, range, glyphs) {
  const stack = [
    ...delimited(1, [...Buffer.from(name, 'utf8')]),
    ...delimited(2, [...Buffer.from(range, 'utf8')]),
    ...glyphs.flatMap((glyph) => delimited(3, encodeGlyph(glyph))),
  ];
  return Buffer.from(delimited(1, stack));
}

/* ------------------------------------------------------------------ */

function main() {
  const check = process.argv.includes('--check');
  const fonts = FACES.map((file) => {
    const path = resolve(root, file);
    if (!existsSync(path)) throw new Error(`${file} is not here — run pnpm install`);
    const buffer = readFileSync(path);
    return opentype.parse(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );
  });

  let failed = false;
  for (const [start, end] of RANGES) {
    const glyphs = [];
    for (let codepoint = start; codepoint <= end; codepoint += 1) {
      for (const font of fonts) {
        const glyph = sdfGlyph(font, codepoint);
        if (glyph) {
          glyphs.push(glyph);
          break;
        }
      }
    }
    const range = `${start}-${end}`;
    const out = resolve(root, `apps/web/public/fonts/${FONTSTACK}/${range}.pbf`);
    const encoded = encodeRange(FONTSTACK, range, glyphs);
    console.log(
      `${FONTSTACK}/${range}: ${glyphs.length} glyphs, ${(encoded.length / 1024).toFixed(1)} KiB`,
    );
    if (check) {
      if (!existsSync(out) || !readFileSync(out).equals(encoded)) {
        console.error(`  ${out} is not what this tool produces — re-run without --check`);
        failed = true;
      }
      continue;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, encoded);
    console.log(`  wrote apps/web/public/fonts/${FONTSTACK}/${range}.pbf`);
  }
  if (failed) process.exitCode = 1;
}

main();

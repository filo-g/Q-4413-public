import { describe, expect, it } from 'vitest';

import { contentRange, parseRange, sliceFor } from '../apps/web/src/sw-range.ts';

/**
 * R-52's cached archive is only useful if the service worker can answer the
 * range requests `pmtiles` reads it with — the header first, then the
 * directory, then a tile. Every case below is one `pmtiles` actually issues,
 * plus the two that decide whether a wrong answer fails loudly or quietly.
 */
const SIZE = 1_000;

describe('parseRange', () => {
  it('reads a closed range inclusively', () => {
    expect(parseRange('bytes=0-15', SIZE)).toEqual({ start: 0, end: 15 });
  });

  it('reads an open end as "to the end of the file"', () => {
    expect(parseRange('bytes=900-', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('reads a suffix range as the last N bytes, not the first', () => {
    expect(parseRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('clamps an end past the file rather than refusing it', () => {
    expect(parseRange('bytes=990-5000', SIZE)).toEqual({ start: 990, end: 999 });
  });

  it('answers null for no header, which is a whole-file 200', () => {
    expect(parseRange(null, SIZE)).toBeNull();
    expect(parseRange('', SIZE)).toBeNull();
  });

  it('answers null for a header it does not understand, rather than guessing', () => {
    expect(parseRange('bytes=0-10, 20-30', SIZE)).toBeNull();
    expect(parseRange('items=0-10', SIZE)).toBeNull();
  });

  /**
   * The case that decides whether a bug is loud. A 200 with the whole archive
   * where 16 bytes of header were expected does not fail — `pmtiles` parses the
   * wrong bytes and reports something else entirely.
   */
  it('is unsatisfiable past the end of the file', () => {
    expect(parseRange('bytes=1000-1100', SIZE)).toBe('unsatisfiable');
    expect(parseRange('bytes=500-400', SIZE)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', SIZE)).toBe('unsatisfiable');
  });

  it('handles a suffix longer than the file by giving the whole file', () => {
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });
});

describe('contentRange', () => {
  it('reports the served range and the total', () => {
    expect(contentRange({ start: 0, end: 15 }, SIZE)).toBe('bytes 0-15/1000');
  });

  it('reports only the total for a 416', () => {
    expect(contentRange(null, SIZE)).toBe('bytes */1000');
  });
});

describe('sliceFor', () => {
  /** The off-by-one: the header is inclusive, ArrayBuffer.slice is not. */
  it('turns an inclusive end into an exclusive one', () => {
    expect(sliceFor({ start: 0, end: 15 })).toEqual({ start: 0, endExclusive: 16 });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const { start, endExclusive } = sliceFor({ start: 1, end: 3 });
    expect(new Uint8Array(bytes.slice(start, endExclusive))).toEqual(new Uint8Array([2, 3, 4]));
  });
});

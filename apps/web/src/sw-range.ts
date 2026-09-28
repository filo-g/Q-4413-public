/**
 * HTTP range arithmetic, for the one thing R-52 cannot do without it.
 *
 * `pmtiles` reads its archive with **range requests** — that is the whole trick
 * of serving a map from a single file on object storage with no tile server.
 * The Cache API stores whole responses, so a cached archive can only answer
 * those requests if the service worker slices it itself.
 *
 * In its own module because it is arithmetic with off-by-one traps in every
 * direction, and because a service worker is the least testable place in a
 * browser: `sw.ts` cannot be imported by the root suite, and this can.
 *
 * RFC 9110 §14.1.2. Only a single byte range is handled — multipart ranges are
 * legal and `pmtiles` does not ask for them.
 */

/** Inclusive on both ends, as the header is. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * `null` means no range header at all — answer with the whole body and a 200.
 * `'unsatisfiable'` means the header was well formed and asks for bytes that do
 * not exist, which is a 416 and not a 200: answering a 200 there would hand
 * `pmtiles` the whole archive where it expected 16 bytes of header, and it
 * would parse the wrong thing rather than fail.
 */
export function parseRange(header: string | null, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  // Suffix form: `bytes=-500` is the *last* 500 bytes, not "up to 500".
  if (rawStart === '') {
    const length = Number(rawEnd);
    if (length <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';
  // An open end means "to the end of the file", and an end past it is clamped
  // rather than refused — a client asking for more than exists gets what exists.
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

/** The `Content-Range` value for a 206, or for the 416 that has no range to report. */
export function contentRange(range: ByteRange | null, size: number): string {
  if (!range) return `bytes */${size}`;
  return `bytes ${range.start}-${range.end}/${size}`;
}

/** `end` is inclusive here and exclusive in `ArrayBuffer.slice`, which is the trap. */
export function sliceFor(range: ByteRange): { start: number; endExclusive: number } {
  return { start: range.start, endExclusive: range.end + 1 };
}

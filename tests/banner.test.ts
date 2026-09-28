import { describe, expect, it } from 'vitest';

import {
  LOGOTYPE,
  MARK,
  MARK_ASPECT,
  MARK_FONT,
  NOTICE_COLS,
  noticeBox,
  printDuration,
  PRINT_MS_PER_CHAR,
} from '../apps/web/src/chrome/banner.ts';
import es from '../apps/web/locales/es.json';

/**
 * The boot logotype (§9.6). Two invariants, both of which fail silently on a
 * screen rather than loudly in a build.
 */
describe('LOGOTYPE', () => {
  /**
   * The app ships VT323 and VT323 does not have block elements or box drawing.
   * §9.7's four state marks were lost to exactly this — `● ◎ ◌ ✕` are absent
   * from its latin subset and are drawn in CSS now — and a logotype that falls
   * back to whatever the system supplies is a different logotype per machine,
   * with tofu boxes on a handset that supplies nothing.
   */
  it('is printable ASCII and nothing else', () => {
    for (const row of LOGOTYPE) {
      expect(row, `non-ASCII in ${JSON.stringify(row)}`).toMatch(/^[ -~]*$/);
    }
  });

  /**
   * A figlet is a grid, and the column that makes a row the right width is
   * usually a space at the end of it — which survives neither trim-on-save nor
   * a hand edit to the art. It was written as a rectangle and came back
   * 34/34/34/35 the next time the file was opened, so the width is decided by
   * `padEnd` rather than by the literal.
   *
   * The assertion stays because it is the invariant, not the mechanism: what
   * has to be true is that five rows render as a block, however that is
   * arranged.
   */
  it('is a rectangle', () => {
    const widths = new Set(LOGOTYPE.map((row) => row.length));
    expect(widths.size).toBe(1);
    expect(LOGOTYPE.length).toBeGreaterThan(1);
  });

  /**
   * The padding may only ever add to the right. A row that came back *longer*
   * than the rest is a glyph in the wrong place, and no amount of padding the
   * others fixes that — it just makes the block wider with a step in it.
   */
  it('never pads by more than a column or two', () => {
    const width = LOGOTYPE[0]?.length ?? 0;
    for (const row of LOGOTYPE) {
      expect(row.trimEnd().length, `${JSON.stringify(row)} is mostly padding`).toBeGreaterThan(
        width - 4,
      );
    }
  });
});

/**
 * The device mark. It breaks the rule the logotype above it exists to keep, on
 * purpose and in one bounded place, and these are the three things that make
 * that safe rather than merely deliberate.
 */
describe('MARK', () => {
  /**
   * The inverse of the logotype's assertion, and the reason this drawing cannot
   * live in the screen font. The shipped VT323 subset has 224 glyphs and
   * `U+2588` is not one of them.
   *
   * **Space or full block, nothing else.** A third character is the real
   * hazard: it would come from whatever the platform supplies for *that* one,
   * at an advance the surrounding face does not share, so the rows containing
   * it would come out a different width and the grid would shear. One glyph is
   * one question — either the platform's monospace has blocks or the whole mark
   * fails visibly, which is a bug somebody reports rather than a drawing that
   * quietly leans.
   */
  it('is spaces and one ink glyph and nothing else', () => {
    for (const row of MARK) {
      expect(row, `unexpected glyph in ${JSON.stringify(row)}`).toMatch(/^[ #]*$/u);
    }
  });

  it('is a rectangle', () => {
    const widths = new Set(MARK.map((row) => row.length));
    expect(widths.size).toBe(1);
    expect(MARK.length).toBeGreaterThan(1);
  });

  /**
   * The one that catches a redraw.
   *
   * A character cell is neither square nor 2:1 — in a system monospace a column
   * is about 0,60 em against a row of 1,15, so it is **1,92** times taller than
   * wide. A circle is only round when `columns = 1,92 x rows`, and the art
   * arrived at 34 columns for 15 rows, which is an egg. Nothing on a screen
   * complains about that and nothing in a build does either, so it is asserted
   * here.
   */
  it('is drawn for the cell it is set in, or the circle is an egg', () => {
    const aspect = (MARK[0]?.length ?? 0) / MARK.length;
    expect(Math.abs(aspect - MARK_ASPECT)).toBeLessThan(0.1);
  });

  /**
   * The box is the drawing, with nothing around it.
   *
   * The art arrived with five columns of margin down its left side, and a
   * resample carried four of them through — four empty columns on the left and
   * none on the right. Nothing complains about that: the block is a rectangle,
   * it is the right ratio, every glyph is legal. It only shows up when
   * something centres the block, because centring a box that is not the mark
   * puts the mark off-centre by half the margin.
   */
  it('is cropped to the ink, so centring the box centres the drawing', () => {
    const width = MARK[0]?.length ?? 0;
    const column = (c: number) => MARK.some((row) => row[c] !== ' ');
    expect(column(0), 'empty column down the left edge').toBe(true);
    expect(column(width - 1), 'empty column down the right edge').toBe(true);
    expect(MARK[0]?.trim(), 'empty row across the top').not.toBe('');
    expect(MARK[MARK.length - 1]?.trim(), 'empty row across the bottom').not.toBe('');
  });

  /** A proportional fallback destroys the drawing as thoroughly as a missing
      block would, so the stack has to end somewhere that cannot be one. */
  it('is set in a monospace stack, ending in the generic', () => {
    expect(MARK_FONT.trim().endsWith('monospace')).toBe(true);
    expect(MARK_FONT).not.toContain('VT323');
  });
});

describe('printDuration', () => {
  it('scales with the line, so a long line holds the next one back', () => {
    expect(printDuration('x'.repeat(40))).toBe(40 * PRINT_MS_PER_CHAR);
    expect(printDuration('x'.repeat(80))).toBe(80 * PRINT_MS_PER_CHAR);
  });

  /**
   * A blank line separates the credit from the program from the self-test, and
   * a zero-length one would be scheduled with no delay at all — the whole block
   * after it would then print in one frame.
   */
  it('gives a blank line a floor', () => {
    expect(printDuration('')).toBeGreaterThan(0);
  });
});

/**
 * The login notice (§9.6's boot, extended to the banner every machine of the
 * period printed before its prompt).
 *
 * The box is a grid of characters printed one row at a time, so every way it
 * goes wrong is a row that is not the width of the others — and none of them
 * raises anything. A stepped frame reads as a rendering fault rather than as
 * copy somebody has to rewrap, which is exactly the wrong signal to send about
 * a paragraph of legal text.
 */
describe('noticeBox', () => {
  const box = noticeBox({
    title: es.boot.warningTitle,
    lines: es.boot.warning,
    centred: [es.boot.warningConsent, es.boot.warningPresence],
    accept: es.boot.warningAccept,
  });

  it('comes out a rectangle, every row', () => {
    for (const row of box) {
      expect(row.length, `${row.length} columns: ${JSON.stringify(row)}`).toBe(NOTICE_COLS);
    }
  });

  /**
   * Prose, not a drawing — so unlike the logotype it may carry accents, and it
   * has to: this is Spanish legal text and `POSICION` without its accent is a
   * typo on the one screen a master reads word by word.
   *
   * What it may **not** carry is a character the screen font lacks, which is
   * the failure that cost §9.7 its four state marks and the device mark its
   * whole font. The shipped VT323 subset was read at the source — its `cmap`
   * parsed out of `vt323-latin-400-normal.woff` — and it has 224 glyphs
   * covering printable ASCII and Latin-1's accented letters: `Á É Í Ó Ú Ü Ñ`
   * and their lower case are all present, and `#` is `U+0023`. The box drawing
   * this frame would rather be made of is not, which is why it is made of `#`.
   *
   * So the range is ASCII plus that block, and anything outside it is a glyph
   * nobody has checked.
   */
  it('stays inside the glyphs the screen font actually ships', () => {
    for (const row of box) {
      expect(row, `unverified glyph in ${JSON.stringify(row)}`).toMatch(/^[ -~\u00C0-\u00FF]*$/u);
    }
  });

  /**
   * The one that caught a real line. `LA CONTINUIDAD DEL SERVICIO...` came out
   * at 77 against an inner width of 76, and the cut took the `l` off
   * `Internal` — a row that is the right width, in a box that is the right
   * shape, quietly missing a character. Nothing else in the app would have
   * said so.
   */
  it('loses nothing to the cut, so a line that needs rewrapping says so here', () => {
    const inner = NOTICE_COLS - 4;
    const copy = [
      ...es.boot.warning,
      es.boot.warningConsent,
      es.boot.warningPresence,
      es.boot.warningAccept,
    ];
    for (const line of copy) {
      expect(line.length, `${line.length} > ${inner}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(
        inner,
      );
    }
  });

  it('cuts rather than stepping the frame, when a line is too long anyway', () => {
    const wide = noticeBox({
      title: 'X',
      lines: ['Y'.repeat(NOTICE_COLS * 2)],
      centred: [],
      accept: 'Z',
    });
    for (const row of wide) expect(row.length).toBe(NOTICE_COLS);
  });
});

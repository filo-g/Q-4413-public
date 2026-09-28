/**
 * The logotype, drawn in characters.
 *
 * **This is the one thing in the app that is not in `locales/es.json`, and it is
 * not an oversight.** §0 puts every user-facing string in the locale file, and
 * the boot lines beside this one obey it. A logotype does not: it is a drawing
 * whose medium happens to be text, and translating it produces a broken glyph
 * grid rather than a translated logo. The model plate says `Mod. Q-4413` in
 * every language for the same reason.
 *
 * ## Why it is ASCII and nothing else
 *
 * Block elements (`█ ▀ ▄`) and box drawing (`─ │ ┌`) make a far better figlet
 * and **VT323 does not have them**. The app ships that font, §9.7's four state
 * marks were already lost to exactly this — `● ◎ ◌ ✕` are absent from its latin
 * subset, so they are drawn in CSS now — and a logotype that falls back to
 * whatever the operating system supplies is a different logotype on every
 * machine, with tofu boxes on a handset that supplies nothing. Printable ASCII
 * is the one repertoire a font cannot be missing.
 *
 * §9.2 rules out drawing *frames* with these characters, and that is a
 * different question: a frame has to survive a cell reflowing around content,
 * and this is a fixed block that is either shown whole or not at all.
 */

/**
 * `Q-4413` at five rows.
 *
 * **Padded on the way out, because trailing whitespace is not a storable
 * medium.** The rows are a glyph grid and a grid has one width, but the column
 * that makes a row that width is often a space at the end of it — and a space
 * at the end of a line survives neither an editor with trim-on-save nor a hand
 * edit to the art. It was a rectangle when written and a 34/34/34/35 the next
 * time the file was opened.
 *
 * So the width is decided here rather than in the source literal, and the
 * literal is free to be edited by whoever wants a narrower banner without
 * counting columns.
 */
const ROWS: readonly string[] = [
  '  ___        _  _   _  _   _ _____',
  ' / _ \\      | || | | || | / |___ /',
  '| | | |_____| || |_| || |_| | |_ \\',
  '| |_| |_____|__   _|__   _| |___) |',
  ' \\__\\_\\        |_|    |_| |_|____/',
];

const WIDTH = Math.max(...ROWS.map((row) => row.length));

export const LOGOTYPE: readonly string[] = ROWS.map((row) => row.padEnd(WIDTH));

/**
 * The device mark, above the wordmark — the same drawing as the app's icon.
 *
 * **Drawn in `#`, and still set in the platform's own monospace — which is now
 * one decision rather than one reason.**
 *
 * It was `█`, and that forced the font. The shipped VT323 subset has 224 glyphs
 * and `U+2588 FULL BLOCK` is not one of them — nor `▀`, `░`, `─` or `●`, which
 * is the same gap that cost §9.7 its four state marks — and a character a font
 * does not have falls back **per character**, at an advance of about 0,60 em
 * against VT323's 0,40. The width of a row then depends on how many blocks are
 * in it and the grid shears: not "slightly wrong", the drawing comes apart.
 *
 * `#` is printable ASCII and VT323 has it, so that argument is gone. What keeps
 * the mark out of the screen face is now the **cell**, below: this art is drawn
 * for an aspect of 1,92 and VT323's is 2,875, so the same rows in that face are
 * a circle squashed into an egg. Moving it back is a redraw — about 43 columns
 * for these 15 rows — and it is worth doing, because it would take the whole
 * exception with it. Until then the trade is the same one it always was, and
 * bounded the same way: one element on one screen, a picture rather than copy,
 * and §9's contrast between the screen face and the case face untouched
 * everywhere else.
 *
 * The notice above the banner is in `#` too, and that one is in VT323 already —
 * it has no circle to keep round, so the cell's aspect costs it nothing.
 *
 * ## Why the grid is 29 wide and not 34
 *
 * A character cell is not square and is not 2:1 either. In VT323 a column is
 * 0,40 em and a row is `--cell-y` (1,15), so the cell is **2,875** times taller
 * than wide; in a system monospace a column is about 0,60 em, so it is **1,92**.
 * A round circle therefore needs `columns = aspect x rows`, and the same art is
 * a different shape in the two faces.
 *
 * **The drawing already was 29 x 15, and these are its own characters.** The 34
 * it appeared to be was its ink plus five columns of left margin, and measuring
 * the margin as part of the art is what produced a resampled copy of a picture
 * that never needed resampling. The margin then survived into the result — four
 * empty columns on the left and none on the right — which is invisible until
 * something tries to centre the block and centres the box instead of the mark.
 *
 * So the rows below are cropped to the ink and nothing else, and the test holds
 * that: no empty column at either edge, no empty row at top or bottom. A box
 * that is the drawing is a box that can be centred by anything.
 *
 * ## The one glyph
 *
 * Every cell is a space or a `#`, and the test enforces it. One ink glyph is
 * what keeps a fallback to a single question rather than to a shear — and with
 * `#` there is no question left to ask, since a monospace font without it is
 * not a monospace font.
 */
const MARK_ROWS: readonly string[] = [
  '       #############',
  '     ####         ####',
  '   ###               ###',
  '  ##                   ##',
  ' ##                     ##',
  '###         ###         ###',
  '##        #######        ##',
  '##        ######         ##',
  '###         ########    ###',
  ' ##             ####### ##',
  '  ##              ##########',
  '   ###             ##########',
  '     ####          ########',
  '       #############  ####',
  '                       #',
];

const MARK_WIDTH = Math.max(...MARK_ROWS.map((row) => row.length));

export const MARK: readonly string[] = MARK_ROWS.map((row) => row.padEnd(MARK_WIDTH));

/** The cell the mark is drawn for: a system monospace column against a row. */
export const MARK_ASPECT = 1.92;

/**
 * The face the mark is set in, exported so the test can assert the stack is a
 * monospace one rather than the screen font. A proportional fallback would
 * destroy the drawing as thoroughly as a missing glyph would — and it is the
 * cell's aspect that keeps this here now, not a missing glyph. See `MARK_ROWS`.
 */
export const MARK_FONT =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/**
 * How long one character takes to appear, in milliseconds.
 *
 * Shared by the boot lines and by the logotype so the whole sequence is one
 * machine printing at one speed. §9.6 budgets about 1,5 s for a boot and calls
 * it skippable; at this rate the login's twelve lines take about 1,9 s and the
 * logotype after a successful password about 1,2 s. Measured rather than
 * guessed — the first pass was 9 ms and ran to six seconds of theatre before a
 * master could type a password, which is the kind of thing nobody times until
 * they are standing at a venue.
 */
export const PRINT_MS_PER_CHAR = 4;

/** The pause between one line finishing and the next starting. */
export const PRINT_LINE_GAP_MS = 30;

/**
 * How long one row of the logotype holds before the next.
 *
 * The rows do **not** type. A line of prose is written a character at a time
 * and a logotype is not written at all — it is put on the screen, which is what
 * a banner does on any machine that has one. Typing it at the prose rate also
 * cost a second on its own: 43 columns is five times the length of anything
 * else on the screen.
 *
 * **It came down from 55 ms when the mark arrived.** The banner is twenty rows
 * now rather than five, and one rate covers both because they are one banner
 * printed by one machine — two cadences in a block that reads as a block is a
 * wobble. At 30 ms the banner costs 600 ms against the 275 ms it did, which
 * puts the login at about 2,2 s. §9.6 budgets 1,5 s and calls it skippable; the
 * skip is what the extra is spent against, and it is only ever spent in front
 * of a master typing a password. A player's load runs `Boot` and never sees
 * this block at all.
 */
export const LOGO_ROW_MS = 30;

/**
 * How long one boot check holds before the next.
 *
 * Fast on purpose, and the reason there are twenty-one of them: a server
 * printing `[ OK ]` lines is recognisable by its **cadence** rather than by any
 * one line, and four lines at a readable pace is a self-test, not a boot. They
 * go past faster than they can be read, which is exactly right — nobody reads
 * a boot, they watch it happen.
 */
export const CHECK_MS = 45;

/**
 * The same boot, on a load that nobody asked for.
 *
 * §9.6 says "on load", not "on login": a player redeems an invite link and a
 * master who reloads has a cookie, and neither passes a password prompt. Both
 * still get the checks, because a machine that boots only when challenged is
 * not a machine.
 *
 * Roughly half the cadence, and the reason is what the person is waiting for.
 * After a password, the boot **is** the event. On a plain load it is in front
 * of a map somebody opened to look at, so it has to be over before it is in the
 * way — about half a second for the whole list.
 */
export const FAST_CHECK_MS = 22;

/**
 * How long a line takes to print, end to end.
 *
 * Exported because the component needs it twice — once to schedule the next
 * line, once as the CSS animation's duration — and two copies of a timing
 * constant drift into a reveal that starts before the previous line finished.
 */
export function printDuration(text: string): number {
  return Math.max(60, text.length * PRINT_MS_PER_CHAR);
}

/**
 * The operator's notice, boxed in `#`.
 *
 * §9.6 asks for a boot and says nothing about a login banner. This is the one
 * every corporate machine of the period printed before its prompt — private
 * property, no expectation of privacy, use constitutes consent — and here it is
 * satire that happens to be **true**: every clause in `locales/es.json` is a
 * requirement this system actually implements. The track outlives the game
 * (R-26), nobody is told about an elimination (R-30.2), only the master can
 * reverse one (R-32), the cut switch halts the feed without warning (R-60), a
 * point can be taken off every map (R-61). The joke is that none of it is
 * exaggerated.
 *
 * ## Why the box is drawn here and the sentences are not
 *
 * §0 puts every user-facing string in the locale, and the sentences obey it.
 * The frame does not: it is a drawing whose medium happens to be text, and a
 * translator writes prose rather than counting columns — the same split the
 * logotype above already makes. So the copy arrives as arguments and the box is
 * computed from it.
 *
 * ## Why it is characters and not layout
 *
 * The first attempt built the frame out of flex rows so it could be any width.
 * It cannot: these rows print one at a time as part of the boot, like every
 * other line on that screen, and a printed row is a string. A `#` run long
 * enough for any screen also has an intrinsic width long enough for any screen,
 * which is what a `max-content` grid track measures — the console's column went
 * to 400ch and the login scrolled sideways into the distance.
 *
 * 80 columns, because that is what the machine being imitated had.
 *
 * A line longer than the box is **cut**. Left alone it would push the
 * right-hand column out and step the frame on that row only, which reads as a
 * rendering fault rather than as copy that needs rewrapping — and the test
 * holds the invariant that every row comes out the same width.
 */
export const NOTICE_COLS = 80;

export interface Notice {
  /** Centred in the top rule, spaced out: `#### A V I S O ####`. */
  title: string;
  /** The body, already wrapped by whoever wrote it. A blank row is a blank row. */
  lines: readonly string[];
  /** The clauses that are the point, given the middle of the box. */
  centred: readonly string[];
  /** The line under the closing rule, centred: what continuing means. */
  accept: string;
}

export function noticeBox(notice: Notice, cols: number = NOTICE_COLS): string[] {
  const inner = cols - 4;
  const rule = (title?: string): string => {
    if (title === undefined) return '#'.repeat(cols);
    const label = ` ${title} `;
    const left = Math.max(0, Math.floor((cols - label.length) / 2));
    return '#'.repeat(left) + label + '#'.repeat(Math.max(0, cols - left - label.length));
  };
  const row = (text: string): string => `# ${text.slice(0, inner).padEnd(inner)} #`;
  const middle = (text: string): string => {
    const cut = text.slice(0, inner);
    return row(' '.repeat(Math.floor((inner - cut.length) / 2)) + cut);
  };

  return [
    rule(notice.title),
    ...notice.lines.map(row),
    row(''),
    ...notice.centred.map(middle),
    rule(),
    middle(notice.accept),
    rule(),
  ];
}

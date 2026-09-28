import { describe, expect, it } from 'vitest';

import { eventDetail, formatClock, placeName } from '../apps/web/src/format.ts';

/**
 * R-66's reading. The debrief's one absolute timestamp, and the only time on any
 * screen that is not an age.
 *
 * Every instant below is built with `new Date(y, m, d, ...)`, which is **local**,
 * and read back through a formatter that is also local. That is what makes these
 * assertions independent of the machine running them: an epoch literal would
 * pass in Madrid and fail in CI, and pinning `TZ` for one suite would hide the
 * one thing worth checking — that the same wall clock goes in and comes out.
 */
describe('formatClock', () => {
  it('prints a big-endian date and a time with seconds', () => {
    const at = new Date(2026, 8, 23, 11, 7, 58).getTime();
    expect(formatClock(at)).toBe('2026/09/23 11:07:58');
  });

  it('pads every field to two digits', () => {
    const at = new Date(2026, 0, 3, 4, 5, 6).getTime();
    expect(formatClock(at)).toBe('2026/01/03 04:05:06');
  });

  it('is 24-hour, so an afternoon is not an identical morning', () => {
    const morning = new Date(2026, 8, 23, 9, 30, 0).getTime();
    const evening = new Date(2026, 8, 23, 21, 30, 0).getTime();
    expect(formatClock(morning)).toBe('2026/09/23 09:30:00');
    expect(formatClock(evening)).toBe('2026/09/23 21:30:00');
    expect(formatClock(morning)).not.toBe(formatClock(evening));
  });

  it('does not round the second it is given', () => {
    // The cursor advances in 100 ms ticks (`TICK_MS`), so most of the values
    // this is handed are not whole seconds. Truncating is what makes the reading
    // agree with `formatAge()` beside it; rounding would put the two a second
    // apart for half of every second.
    const at = new Date(2026, 8, 23, 11, 7, 58).getTime();
    expect(formatClock(at + 900)).toBe('2026/09/23 11:07:58');
  });

  it('is fixed width, so a ticking clock does not move what is beside it', () => {
    const widths = new Set(
      [
        new Date(2026, 0, 1, 0, 0, 0),
        new Date(2026, 11, 31, 23, 59, 59),
        new Date(2026, 8, 3, 9, 8, 7),
      ].map((at) => formatClock(at.getTime()).length),
    );
    expect(widths.size).toBe(1);
  });
});

/**
 * The log's right-hand column, which is one space wide and was wrong.
 *
 * The master's log is a monospace table read by scanning down a column, and the
 * separator between an event's target and its data used to be written as part of
 * the data. Correct for every event that has both, wrong for every event that
 * has only data — `GAME_STATE` and `CUT_SWITCH` name no target, so all of their
 * lines started one character right of everything above them.
 */
describe('eventDetail', () => {
  it('separates a target from its data with exactly one space', () => {
    expect(eventDetail({ target: 'fake-6', data: { reason: 'CUT_SWITCH' } })).toBe(
      'fake-6 {"reason":"CUT_SWITCH"}',
    );
  });

  /** The bug, as the two events that showed it. */
  it('does not open with a space when there is no target', () => {
    expect(eventDetail({ data: { state: 'FINISHED' } })).toBe('{"state":"FINISHED"}');
    expect(eventDetail({ data: { on: true, byFinish: true } })).toBe('{"on":true,"byFinish":true}');
  });

  it('prints a lone target, and nothing at all for an empty event', () => {
    expect(eventDetail({ target: 'player-romeo' })).toBe('player-romeo');
    expect(eventDetail({})).toBe('');
  });

  /**
   * `AUTHORITATIVE_REVERTED` carries a session in `actor` and nothing here, which
   * is what made two of them indistinguishable and is why the log may not be
   * keyed. An empty string contributes no separator of its own either.
   */
  it('stays empty rather than becoming a space', () => {
    expect(eventDetail({ target: '' })).toBe('');
    expect(eventDetail({ target: '', data: { on: false } })).toBe('{"on":false}');
  });
});

/**
 * R-70's two words on one line. A zone name was the whole answer while there
 * was one venue and stopped being one the day the game covered more ground than
 * one walk: "estoy en Comercio" locates nobody who has not been there, and
 * across a dozen sectors that is most people most of the time.
 */
describe('placeName — R-70', () => {
  const zones = [
    { id: 'z-comercio', name: 'Comercio', sector: 'norte' },
    { id: 'z-ribera', name: 'Ribera', sector: 'ribera' },
    { id: 'z-orphan', name: 'Huérfana', sector: 'gone' },
  ];
  const sectors = [
    { id: 'norte', name: 'Norte' },
    { id: 'ribera', name: 'Ribera' },
  ];

  it('names the sector and the zone', () => {
    expect(placeName(zones, sectors, 'z-comercio')).toBe('Norte · Comercio');
  });

  /**
   * A sector that is not subdivided is a single leaf zone carrying the sector's
   * own name (R-70), so the honest reading is `Ribera`. The duplicate is not a
   * formatting nicety: a card that says everything twice teaches the reader to
   * skip the line.
   */
  it('drops the sector when it would only repeat the zone', () => {
    expect(placeName(zones, sectors, 'z-ribera')).toBe('Ribera');
  });

  /**
   * The fallbacks are `zoneName()`'s, and ordered for the same reason: an id
   * nobody can read is still evidence that somebody is somewhere, and the dash
   * says the opposite. Only an absent zone — out of every one of them (R-40) —
   * gets the dash.
   */
  it('falls back to the id, and only an absent zone gets the dash', () => {
    expect(placeName(zones, sectors, undefined)).toBe('—');
    expect(placeName(zones, sectors, 'z-unknown')).toBe('z-unknown');
  });

  /**
   * A sector the payload does not carry prints the zone alone. That is what a
   * player is handed for a sector R-71 closed: `project()` sends them only the
   * open ones, so the lookup misses and the honest half still prints.
   */
  it('prints the zone alone when its sector is not in the payload', () => {
    expect(placeName(zones, sectors, 'z-orphan')).toBe('Huérfana');
    expect(placeName(zones, undefined, 'z-comercio')).toBe('Comercio');
  });
});

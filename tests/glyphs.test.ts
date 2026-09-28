import { describe, expect, it } from 'vitest';

import { stateMark } from '../apps/web/src/glyphs.ts';
import type { ProjectedPlayer } from '../packages/shared/types.ts';

/**
 * §9.7's two channels, and the §4 gate hiding inside what looks like a
 * cosmetic choice: `✕` announces an elimination, which R-30.2 and R-30.3 make
 * the one fact the system withholds hardest.
 */
const player = (over: Partial<ProjectedPlayer> = {}): ProjectedPlayer => ({
  id: 'p1',
  callsign: 'ALFA',
  ...over,
});

describe('stateMark — §9.7', () => {
  /**
   * `shape` is what the CSS draws and `glyph` is the name §9.7 gives it. Both
   * are asserted: the font this app ships has none of the four characters, so
   * the shape is what actually reaches a screen — and the glyph is the
   * requirement it has to keep answering to.
   */
  it('gives each state its own mark and its own brightness', () => {
    expect(stateMark(player(), 'MOVING')).toEqual({
      glyph: '●',
      shape: 'moving',
      brightness: 'bright',
    });
    expect(stateMark(player(), 'STATIONARY')).toEqual({
      glyph: '◎',
      shape: 'stationary',
      brightness: 'normal',
    });
    expect(stateMark(player(), 'NO_LINK')).toEqual({
      glyph: '◌',
      shape: 'no-link',
      brightness: 'dim',
    });
  });

  /**
   * The bug this rules out is not a wrong shape, it is a **shared name**. §9.7's
   * brightness levels are class names, and `dim` was also the class on R-24's
   * dialog backdrop in `MasterView` — so a NO_LINK player's mark carried a
   * full-panel black overlay. The levels are fixed vocabulary; anything else
   * claiming one of these three words in a shared scope is the collision.
   */
  it('uses exactly the three brightness levels, and no other word', () => {
    const levels = new Set(
      (['MOVING', 'STATIONARY', 'NO_LINK'] as const).map(
        (state) => stateMark(player(), state)?.brightness,
      ),
    );
    expect(levels).toEqual(new Set(['bright', 'normal', 'dim']));
  });

  /**
   * Both channels have to carry the state on their own: a reading that needs
   * hue is one a colour-blind player does not get, and a reading that needs
   * fine shape is one an amber tube under scanlines does not give.
   */
  it('never repeats a glyph or leans on brightness alone', () => {
    const marks = (['MOVING', 'STATIONARY', 'NO_LINK'] as const).map((state) =>
      stateMark(player(), state),
    );
    expect(new Set(marks.map((mark) => mark!.glyph)).size).toBe(3);
    expect(new Set(marks.map((mark) => mark!.brightness)).size).toBe(3);
  });
});

describe('stateMark — the §4 gate', () => {
  /**
   * The elimination glyph is reachable **only** through a field project()
   * decided to send. A master in OPERATIONAL, and every other player, receive a
   * record with no `eliminated` at all — so there is nothing here to get wrong,
   * which is why this takes the record and not a boolean.
   */
  it('draws ✕ only for a record that actually carries an elimination', () => {
    expect(stateMark(player(), 'NO_LINK')?.glyph).toBe('◌');
    expect(
      stateMark(player({ eliminated: { ts: 1, selfDeclared: true } }), 'NO_LINK')?.glyph,
    ).toBe('✕');
  });

  /** R-22 freezes the feed but the phone often keeps reporting; out is out. */
  it('lets elimination outrank a live feed', () => {
    expect(stateMark(player({ eliminated: { ts: 1, selfDeclared: true } }), 'MOVING')).toEqual({
      glyph: '✕',
      shape: 'eliminated',
      brightness: 'dim',
    });
  });

  /**
   * `◌` is a claim — "we have lost them" — and an out-of-zone player may be
   * walking about with a perfectly live feed the viewer is not allowed to see
   * (R-40). Defaulting would turn a permission into a fact.
   */
  it('draws nothing at all for a player whose position was withheld', () => {
    expect(stateMark(player({ outOfZone: true }), 'MOVING')).toBeUndefined();
    expect(stateMark(player({ outOfZone: true }), undefined)).toBeUndefined();
  });

  it('draws nothing for a player who has never had a fix', () => {
    expect(stateMark(player(), undefined)).toBeUndefined();
    expect(stateMark(undefined, 'MOVING')).toBeUndefined();
  });
});

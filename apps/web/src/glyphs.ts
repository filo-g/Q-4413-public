import type { PositionState, ProjectedPlayer } from '@q4413/shared';

/**
 * §9.7: **state by glyph and brightness, not colour alone.**
 *
 * The palette is monochrome by design, so colour was never going to carry state
 * here — but the requirement is stronger than that, and it is an accessibility
 * one: a reading that depends on hue is a reading a colour-blind player, or
 * anyone looking at an amber tube through a scanline overlay at night, does not
 * get. Two channels, both of which survive a bad screen.
 *
 * ## Why this takes a player rather than a boolean
 *
 * `✕` says somebody is out, and R-30.2 and R-30.3 make that the one fact the
 * system withholds hardest: to every player except the eliminated one, an
 * elimination is indistinguishable from a flat battery, and it must stay that
 * way. A signature of `(state, eliminated: boolean)` would let any caller
 * decide to pass `true`, and the glyph would become a second, undefended path to
 * the thing §4 defends.
 *
 * Taking the projected record instead means the gate is `project()` and nothing
 * else: `eliminated` is simply **not on the object** unless the recipient was
 * allowed it — a master in `AUTHORITATIVE`, or the eliminated player's own
 * record (R-30.4). There is no flag here to get wrong, which is the point.
 */

export type Glyph = '●' | '◎' | '◌' | '✕';

/** The second channel. Class names rather than values, so the effect layer owns the levels. */
export type Brightness = 'bright' | 'normal' | 'dim';

/**
 * Which shape to draw. **Not a character.**
 *
 * §9.7's four marks are `● ◎ ◌ ✕`, and **none of them is in VT323's latin
 * subset** — the app ships the font and the font does not have them, so every
 * one was drawn by whatever the operating system happened to supply. A
 * different advance on every machine, and on a handset with no `◌` at all, a
 * tofu box in the one place that means *we have lost them*.
 *
 * So the mark is a name and the CSS draws it, exactly as the map's diamond, the
 * dropdown's caret and the roster's reticle are drawn. A filled circle, a ring
 * with a dot, a dotted ring and a cross are four boxes, and none of them
 * depends on a font nobody chose.
 */
export type MarkShape = 'moving' | 'stationary' | 'no-link' | 'eliminated';

export interface StateMark {
  /**
   * The character this used to be, kept because it is the honest name for the
   * shape and because §9.7 specifies the interface in these terms. Nothing
   * renders it any more.
   */
  glyph: Glyph;
  shape: MarkShape;
  brightness: Brightness;
}

/**
 * §9.7's four, addressable by name. Exported because the map draws the
 * elimination one as a DOM marker — §14.3 leaves the style with no symbol layer
 * to put a glyph in, and a second copy of the character in a component is a
 * second thing to get wrong.
 */
export const GLYPHS = {
  MOVING: '●',
  STATIONARY: '◎',
  NO_LINK: '◌',
  ELIMINATED: '✕',
} as const satisfies Record<string, Glyph>;

const BY_STATE: Record<PositionState, StateMark> = {
  MOVING: { glyph: GLYPHS.MOVING, shape: 'moving', brightness: 'bright' },
  STATIONARY: { glyph: GLYPHS.STATIONARY, shape: 'stationary', brightness: 'normal' },
  NO_LINK: { glyph: GLYPHS.NO_LINK, shape: 'no-link', brightness: 'dim' },
};

/**
 * The mark for one roster row, or `undefined` when there is nothing truthful to
 * draw.
 *
 * **Absent is a real answer and not a gap to fill.** An out-of-zone player
 * (R-40) has had their position withheld, and a player with no fix yet has never
 * had one; both would be `◌` if this defaulted, and `◌` is a claim — "we have
 * lost them" — about somebody who may be walking about perfectly well with a
 * live feed the viewer is not allowed to see. That is the same mistake
 * `linkState()` and `accountability()` already refuse to make.
 *
 * @param state the state **derived now** (R-11, R-15), never the one the
 *              snapshot was built with.
 */
export function stateMark(
  player: Pick<ProjectedPlayer, 'eliminated' | 'outOfZone'> | undefined,
  state: PositionState | undefined,
): StateMark | undefined {
  if (!player) return undefined;
  // Elimination outranks the feed: a player who is out is out whether their
  // phone is still reporting or not (R-22's freeze means it often is).
  if (player.eliminated) {
    return { glyph: GLYPHS.ELIMINATED, shape: 'eliminated', brightness: 'dim' };
  }
  if (player.outOfZone || state === undefined) return undefined;
  return BY_STATE[state];
}

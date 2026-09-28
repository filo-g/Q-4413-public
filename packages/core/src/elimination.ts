import type { Game, GameState, Player } from '@q4413/shared';

/**
 * Self-declared elimination, and the master's reversal (R-30..R-32).
 *
 * There is almost nothing here, and that is the shape of the requirement rather
 * than an omission. R-30's effects are **all** projection: the server stops
 * relaying the position (R-30.1), nobody is notified (R-30.2), everyone else sees
 * `NO_LINK` (R-30.3), and the eliminated player keeps their map furniture
 * (R-30.4). `project()` and `feedStopped()` have done all four since M2. What was
 * missing is a way to set the field, which is these two functions.
 *
 * The one piece of real logic is that neither of them is a toggle. Declaring twice
 * must not move the drop point, and reviving somebody who is not out must not
 * invent a write — so both return the player unchanged when there is nothing to
 * do, and the caller can skip a storage write and a broadcast.
 */

/**
 * When self-declaration is available (M6's decision, not R-30's text).
 *
 * Nobody is out before the game starts, and after it finishes every session is
 * invalidated anyway (R-33, §6.4). R-34 removes the access schedule, so this
 * gates one button rather than the socket: ingest and sessions stay open in every
 * state either way.
 */
export const ELIMINATION_STATES: GameState[] = ['IN_PROGRESS', 'PAUSED'];

export function eliminationOpen(game: Pick<Game, 'state'>): boolean {
  return ELIMINATION_STATES.includes(game.state);
}

/**
 * R-30, R-32. Returns the same object when the player is already out, so a second
 * press cannot move the drop point or the time — and a master looking at the log
 * sees one declaration rather than one per tap.
 *
 * The drop point comes from `position`, which is what the **system** knows.
 * `knownPosition` is what the game knows and is frozen from this moment on
 * (R-22), so reading it here would give the same answer today and the wrong one
 * as soon as anything else freezes it first.
 *
 * A player with no position at all is still eliminated, with no drop point (R-31
 * renders its absence). Refusing would be the wrong direction for this button:
 * somebody pressing it is telling the game they are out of play, and "not until
 * your GPS comes back" is a worse answer than a missing coordinate pair.
 */
export function declareEliminated(player: Player, now: number): Player {
  if (player.eliminated !== undefined) return player;
  const position = player.position;
  return {
    ...player,
    eliminated: {
      ts: now,
      selfDeclared: true,
      ...(position === undefined
        ? {}
        : { dropPoint: { lat: position.lat, lon: position.lon } }),
    },
  };
}

/**
 * R-32's reversal, which only a master may perform. Returns the same object when
 * the player is not out.
 *
 * The frozen `knownPosition` is deliberately left where it is rather than
 * refreshed from `position`: it is still the last thing the game layer knew, and
 * the next ping advances it on its own now that `eliminated` is gone (see
 * `applyPing()`). Writing the live position here would put a fresh timestamp on
 * the game's own record without a fix arriving to justify it, which is the R-12
 * failure M3 spent a milestone learning not to write.
 */
export function reviveEliminated(player: Player): Player {
  if (player.eliminated === undefined) return player;
  const { eliminated: _eliminated, ...rest } = player;
  return rest;
}

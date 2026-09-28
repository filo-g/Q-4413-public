import type { Game, Poi } from '@q4413/shared';

import { distanceMetres } from './position-state.ts';

/**
 * Distance and rough time to a point (R-18, R-44, R-45).
 *
 * Client-side work, in this package because it is game arithmetic rather than
 * rendering (§6.5) and because the player view and the marker readout ask the
 * same question of different points.
 */

/**
 * R-45: `(euclideanDistance × detourFactor) / walkingSpeed`, with the factor at
 * 1.35 and the speed at 1.4 m/s.
 *
 * **Never the instantaneous GPS speed**, which is noise: a player stopped at a
 * fence would read as never arriving, and one caught in a car as arriving in
 * seconds. And buildings and fences mean a point 200 m away can be 600 m of
 * walking, which is what the detour factor is a blunt admission of.
 *
 * Returned in seconds, and the caller is expected to render it coarsely — R-45
 * says "≈4 min", never "4:12". Two things about this number make that a rule
 * rather than a preference: the factor is a guess about a route nobody has
 * traced, and the position it starts from carries its own error.
 */
export function etaSeconds(
  metres: number,
  config: Pick<Game['config'], 'detourFactor' | 'walkingSpeed'>,
): number {
  if (!(metres > 0)) return 0;
  return (metres * config.detourFactor) / config.walkingSpeed;
}

/** A POI as the player's own position sees it. */
export interface PoiDistance {
  poi: Poi;
  metres: number;
  seconds: number;
  /**
   * Inside `poiProximityRadius` (R-44). A display flag and nothing else: R-16 is
   * explicit that POIs are visible from the start and R-18 that proximity
   * "unlocks" nothing, so this may never gate what is shown — only how.
   */
  near: boolean;
}

/**
 * Every POI the recipient already has, ordered by how far away it is.
 *
 * Ordering rather than filtering, and the whole list rather than the near ones:
 * the payload has already been through §4, so everything here is a POI this
 * viewer is allowed to see, and hiding the far ones would lose the non-game
 * meaning R-16 keeps them for — the car park is useful precisely when you are
 * nowhere near it.
 */
export function poiDistances(
  from: { lat: number; lon: number } | undefined,
  pois: readonly Poi[],
  config: Pick<Game['config'], 'detourFactor' | 'walkingSpeed' | 'poiProximityRadius'>,
): PoiDistance[] {
  if (!from) {
    // No position of one's own: the POIs are still on the map, with nothing to
    // measure from. An invented distance would be worse than none.
    return pois.map((poi) => ({ poi, metres: Number.NaN, seconds: Number.NaN, near: false }));
  }
  return pois
    .map((poi) => {
      const metres = distanceMetres(from, poi);
      return {
        poi,
        metres,
        seconds: etaSeconds(metres, config),
        near: metres <= config.poiProximityRadius,
      };
    })
    .sort((a, b) => a.metres - b.metres);
}

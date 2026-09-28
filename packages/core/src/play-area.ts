import polygonClipping from 'polygon-clipping';

import type { Polygon, Zone } from '@q4413/shared';

/**
 * The boundary of what is still in play (R-71), as the union of the open zones.
 *
 * **Derived, never drawn.** `Game.geo.perimeter` is the whole recinto and stays
 * fixed — it is what `basemapBbox()` cuts the archive to, and an archive that
 * shrank with a master's decision would be a download the phones cannot redo at
 * the venue. This is the other boundary: the one a player is warned about
 * (R-43) and the one the map draws, and it follows the switch.
 *
 * Deriving it closes a class of defect rather than adding one. The zones tile
 * the perimeter exactly — `tests/geo.test.ts` samples every committed profile
 * on a 10 m grid and refuses a gap or an overlap — so the union of
 * all of them *is* the perimeter, and the union of the open ones is the only
 * honest answer to where play stops. Ground inside the boundary and inside no
 * zone cannot exist, which under §4 is a player nobody can see who can see
 * nobody.
 *
 * **A list, because a geometry can be cut in two.** A profile whose two halves
 * are joined by a single zone — a road between two towns, say, drawn as a
 * sector of its own precisely so it can be shut — becomes two islands the
 * moment that zone closes, which is a `MultiPolygon` in everything but name. Returning the pieces rather than a `MultiPolygon` keeps
 * every consumer working on one shape: `nearestBoundaryPoint()` takes a
 * `Polygon`, the style draws one feature per piece, and "inside" means inside
 * any of them.
 *
 * Empty when every zone is closed, which is a real state a master can reach and
 * not an error: nothing is in play, so there is no boundary to warn about.
 */
export function playAreaOf(zones: readonly Zone[], disabledZones: readonly string[]): Polygon[] {
  const closed = new Set(disabledZones);
  const open = zones.filter((zone) => !closed.has(zone.id));
  if (open.length === 0) return [];

  /**
   * `union` takes the first polygon and the rest as arguments, and answers with
   * `MultiPolygon` coordinates — an array of polygons, each an array of rings.
   * Unwrapped here rather than at four call sites.
   */
  const [first, ...rest] = open.map((zone) => zone.geometry.coordinates as number[][][]);
  const merged = polygonClipping.union(
    first as Parameters<typeof polygonClipping.union>[0],
    ...(rest as Parameters<typeof polygonClipping.union>[0][]),
  );
  return merged.map((rings) => ({
    type: 'Polygon' as const,
    coordinates: rings as unknown as number[][][],
  }));
}

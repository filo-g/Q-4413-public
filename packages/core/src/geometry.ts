import type { Polygon } from '@q4413/shared';

/**
 * Metre-scale geometry against drawn polygons, with no dependency.
 *
 * `@turf/boolean-point-in-polygon` answers "inside or outside", which is what
 * zone assignment and the ingest geofence need. It cannot answer **how far
 * inside**, and that is the question a border needs answered: §4 makes a zone
 * boundary a visibility boundary, so a fix whose error is larger than its
 * distance to the border carries no reliable answer about which side it is on.
 *
 * Written here rather than pulled in as `@turf/point-to-line-distance` +
 * `@turf/polygon-to-line` for two reasons. The play area is 38 ha, where a local
 * plane is accurate to well under a metre — the numbers below decide a 25 m band,
 * so nothing about this needs a geodesic. And R-43's client-side perimeter
 * warnings are the same question asked of a different polygon, so the answer
 * belongs in `packages/core` where M7 can reuse it offline (§6.5).
 */

/**
 * Metres per degree of latitude, and of longitude at that latitude. WGS84 values
 * at mid-latitude; the play area spans hundredths of a degree, so the variation
 * across it is far below the resolution anything here decides.
 */
function scaleAt(lat: number): { x: number; y: number } {
  return { x: 111_320 * Math.cos((lat * Math.PI) / 180), y: 111_132 };
}

/**
 * The nearest point of a segment to a point, both already in metres on a local
 * plane. The projection of the point onto the segment, clamped to its ends — so
 * a point beyond a corner measures to the corner rather than to the infinite
 * line.
 */
function nearestOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number; metres: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  // A degenerate segment — a repeated vertex, which noded geometry does produce.
  if (lengthSquared === 0) return { x: ax, y: ay, metres: Math.hypot(px - ax, py - ay) };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { x, y, metres: Math.hypot(px - x, py - y) };
}

/** The nearest point of a boundary, and how far away it is. */
export interface BoundaryPoint {
  lon: number;
  lat: number;
  metres: number;
}

/**
 * The point on a polygon's boundary nearest to a given point, holes included.
 *
 * R-43's return arrow needs a direction and not only a magnitude: "you are 40 m
 * outside" is not actionable in the dark, and the fence is rarely behind the way
 * you came. `undefined` for a polygon with no segments, which is the same
 * "nothing to be near" that `distanceToBoundaryMetres` answers with `Infinity`.
 */
export function nearestBoundaryPoint(
  lon: number,
  lat: number,
  polygon: Polygon,
): BoundaryPoint | undefined {
  const scale = scaleAt(lat);
  const toPlane = (coordinates: number[]): [number, number] => [
    ((coordinates[0] ?? lon) - lon) * scale.x,
    ((coordinates[1] ?? lat) - lat) * scale.y,
  ];

  let nearest: { x: number; y: number; metres: number } | undefined;
  for (const ring of polygon.coordinates) {
    for (let index = 1; index < ring.length; index += 1) {
      const [ax, ay] = toPlane(ring[index - 1]!);
      const [bx, by] = toPlane(ring[index]!);
      const candidate = nearestOnSegment(0, 0, ax, ay, bx, by);
      if (!nearest || candidate.metres < nearest.metres) nearest = candidate;
    }
  }
  if (!nearest) return undefined;

  // Back out of the local plane, whose origin is the query point itself. The
  // scale is taken at the query latitude rather than the answer's, which is the
  // same approximation the distance already makes and costs centimetres over a
  // play area this size.
  return {
    lon: lon + (scale.x === 0 ? 0 : nearest.x / scale.x),
    lat: lat + nearest.y / scale.y,
    metres: nearest.metres,
  };
}

/**
 * Compass bearing from one point to another, degrees clockwise from north.
 *
 * On the same local plane as everything else here, so it is a plane bearing
 * rather than a great-circle one — over a play area measured in hundreds of
 * metres the difference is far below what an arrow on a phone can show.
 */
export function bearingDegrees(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const scale = scaleAt(from.lat);
  const east = (to.lon - from.lon) * scale.x;
  const north = (to.lat - from.lat) * scale.y;
  if (east === 0 && north === 0) return 0;
  const degrees = (Math.atan2(east, north) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

/**
 * Metres from a point to the nearest edge of a polygon, holes included.
 *
 * Unsigned: it says how far the point is from the boundary, not which side it is
 * on. Callers already know the side — `booleanPointInPolygon` told them — and
 * combining the two into a signed distance would invite reading a sign off a
 * function whose whole purpose is a magnitude compared against a fix accuracy.
 *
 * `Infinity` for a polygon with no vertices, which keeps every threshold
 * comparison falling the way an absent boundary should: nothing is near it.
 */
export function distanceToBoundaryMetres(lon: number, lat: number, polygon: Polygon): number {
  return nearestBoundaryPoint(lon, lat, polygon)?.metres ?? Infinity;
}

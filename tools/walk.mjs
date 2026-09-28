/**
 * The pure half of `fake-phones.mjs`: a seeded PRNG, ray casting, and one
 * walking step — no I/O, no `node:` imports, no `process`.
 *
 * Split out for one reason and it is a good one: **the browser demo walks its
 * players with exactly this code.** `apps/web/src/demo/` seeds six players and
 * moves them, and a second walk implementation there would be a second answer to
 * "where is everybody" — one of them looking right and the other being the one
 * the tests check. `tests/fake-phones.test.ts` validates `pointInRing` against
 * turf, which is the guard that makes the duplication of turf's job acceptable;
 * having one copy of it is what makes that guard worth anything.
 *
 * **Nothing here may import anything.** `fake-phones.mjs` has to run against a
 * deployed environment with nothing but `node` — that is the whole reason it is
 * plain `.mjs` and dependency-free — and this file is now on its path. It is
 * also on the browser bundle's path, where a `node:` specifier is a build
 * failure rather than a runtime one.
 *
 * It is a test tool. No game rule may ever be defined here.
 */

/** Deterministic PRNG so a seeded run reproduces exactly. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ray casting on a closed ring of [lon, lat] pairs. */
export function pointInRing([lon, lat], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = yi > lat !== yj > lat;
    if (straddles && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bboxOf(ring) {
  const lons = ring.map(([lon]) => lon);
  const lats = ring.map(([, lat]) => lat);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** Metres per degree at a latitude. Good enough over a 2 km box. */
export function metresPerDegree(lat) {
  return { lat: 111132, lon: 111320 * Math.cos((lat * Math.PI) / 180) };
}

export function ringOf(geojson, featureType) {
  const feature = geojson.features.find(
    (f) => f.properties.featureType === featureType && f.geometry.type === 'Polygon',
  );
  if (!feature) throw new Error(`the geometry has no ${featureType} polygon`);
  return feature.geometry.coordinates[0];
}

/**
 * One zone's ring, by id.
 *
 * Separate from `ringOf` because zones are the one feature type there are many
 * of, and the one that has to be asked for by name: §4 cuts visibility on the
 * zone, so "which zone" is the whole question a visibility check is asking.
 *
 * Throws with the list rather than returning undefined. A typo'd zone id would
 * otherwise silently fall back to the perimeter, and the run would look like
 * the rules failing rather than like the tool being told the wrong thing.
 */
export function zoneRing(geojson, id) {
  const zones = geojson.features.filter((f) => f.properties.featureType === 'ZONE');
  const feature = zones.find((f) => f.properties.id === id && f.geometry.type === 'Polygon');
  if (!feature) {
    const ids = zones.map((f) => f.properties.id).join(', ');
    throw new Error(`the geometry has no zone ${id}. It has: ${ids}`);
  }
  return feature.geometry.coordinates[0];
}

export function randomPointInRing(ring, random, attempts = 500) {
  const [minLon, minLat, maxLon, maxLat] = bboxOf(ring);
  for (let i = 0; i < attempts; i += 1) {
    const point = [
      minLon + random() * (maxLon - minLon),
      minLat + random() * (maxLat - minLat),
    ];
    if (pointInRing(point, ring)) return point;
  }
  throw new Error('could not find a point inside the ring');
}

/**
 * One walking step. Turns are smoothed rather than uniform, so a track looks
 * like someone walking rather than Brownian motion. A step that would leave the
 * ring turns around instead of clipping to the edge, which is what a person
 * facing a wall does.
 */
export function walkStep({ lon, lat, heading }, { ring, metres, random }) {
  const turn = (random() - 0.5) * 40;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidateHeading = (heading + turn + (attempt === 0 ? 0 : 150 + random() * 60) + 360) % 360;
    const radians = (candidateHeading * Math.PI) / 180;
    const scale = metresPerDegree(lat);
    const next = [
      lon + (Math.sin(radians) * metres) / scale.lon,
      lat + (Math.cos(radians) * metres) / scale.lat,
    ];
    if (pointInRing(next, ring)) {
      return { lon: next[0], lat: next[1], heading: candidateHeading };
    }
  }
  return { lon, lat, heading: (heading + 180) % 360 };
}

/** A point comfortably outside a ring, for the R-04 rejection case. */
export function pointOutsideRing(ring) {
  const [, , maxLon, maxLat] = bboxOf(ring);
  return [maxLon + 0.25, maxLat + 0.25];
}


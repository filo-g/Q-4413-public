/**
 * Types for [walk.mjs](walk.mjs), which is plain JavaScript on purpose —
 * `fake-phones.mjs` has to run against a deployed environment with nothing but
 * `node`, so nothing on its path may need compiling.
 *
 * Hand-written rather than generated: the browser demo imports these, and
 * `apps/web` is typechecked. A `.d.mts` beside the `.mjs` is what TypeScript
 * looks for, and it keeps the tool free of a build step.
 */

export type Position = [lon: number, lat: number];
export type Ring = Position[];

/** Deterministic PRNG so a seeded run reproduces exactly. */
export function mulberry32(seed: number): () => number;

/** Ray casting on a closed ring of [lon, lat] pairs. */
export function pointInRing(point: Position, ring: Ring): boolean;

export function bboxOf(ring: Ring): [number, number, number, number];

/** Metres per degree at a latitude. Good enough over a 2 km box. */
export function metresPerDegree(lat: number): { lat: number; lon: number };

/** The outer ring of the single feature of that type. Throws when there is none. */
export function ringOf(geojson: unknown, featureType: string): Ring;

/** One zone's outer ring, by id. Throws with the list of ids it does have. */
export function zoneRing(geojson: unknown, id: string): Ring;

export function randomPointInRing(ring: Ring, random: () => number, attempts?: number): Position;

/** One walking step, turning around rather than clipping at the ring. */
export function walkStep(
  state: { lon: number; lat: number; heading: number },
  options: { ring: Ring; metres: number; random: () => number },
): { lon: number; lat: number; heading: number };

/** A point comfortably outside a ring, for the R-04 rejection case. */
export function pointOutsideRing(ring: Ring): Position;

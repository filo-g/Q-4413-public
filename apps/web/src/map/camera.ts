import type { Game, Polygon } from '@q4413/shared';

/**
 * R-47, R-48 and R-49 — where the camera is, what it may do, and what it may
 * never do.
 *
 * Kept out of the component because it is arithmetic with three requirements
 * riding on it, and because the master's constraint (R-49) is a *prohibition*:
 * north up, no rotation, no pitch, in both view modes. A prohibition enforced
 * inside a component is enforced wherever somebody remembers it; enforced here,
 * `cameraFor()` is simply incapable of returning a pitched master camera.
 */

/** R-48's two player modes. The master has neither — see `cameraFor()`. */
export type MapMode = 'NAVIGATION' | 'OVERVIEW';

export type Viewer = 'PLAYER' | 'MASTER';

/** `[[west, south], [east, north]]`, which is the order MapLibre takes. */
export type Bounds = [[number, number], [number, number]];

/**
 * R-47's zoom floor **until a real one can be derived**, which is what
 * `syncMinZoom()` in GameMap does as soon as the geometry and the container's
 * size are both known.
 *
 * A fixed number cannot do this job, and `maxBounds` does not rescue it:
 * MapLibre bounds the *centre*, not the content, so at a floor wide enough to
 * show four times the play area the camera can sit anywhere in the box with the
 * game off-screen. The floor that means something is the zoom at which the
 * perimeter fills the viewport — which depends on the viewport's shape, so it
 * is derived per map rather than written here.
 *
 * The ceiling is the archive's own `maxZoom` (§14.2), past which MapLibre would
 * over-zoom the deepest tile into mush; it is passed in rather than assumed,
 * because the two geo profiles are cut differently.
 */
export const MIN_ZOOM = 12;

/**
 * R-48's navigation zoom. Tight enough to read a street, wide enough to steer.
 *
 * 18 rather than 17. R-48 asks for a "tight zoom" and does not give a number,
 * and the number that was here came from an archive that stopped at z15 — so it
 * was chosen when everything past it was overzoom anyway. `BASEMAP_MAX_ZOOM` is
 * 19 now, and at 17 a player walking a shopping centre saw the whole venue and
 * the car parks around it: a picture of where they were rather than of what is
 * in front of them, which is the overview's job and not this mode's.
 *
 * **18,5 rather than 18 since M12**, and the half is deliberate. The game is no
 * longer one commercial estate but a town, where the thing in front of a player
 * is a street rather than a shopfront, and 18 framed about 190 m across a phone
 * — two blocks, most of them not where they are going. The ceiling is
 * `Game.basemap.maxZoom`, which is 19, so a whole level would start the camera
 * with nowhere left to pinch in.
 *
 * It is a starting point and not a lock — the player's own pinch outranks it,
 * see `held` in `GameMap`.
 */
export const NAVIGATION_ZOOM = 18.5;

/** R-48: "pitch ≈ 50" in navigation, flat everywhere else. */
export const NAVIGATION_PITCH = 50;

/**
 * Where the camera lands when a master asks to be taken to somebody.
 *
 * The same number as `NAVIGATION_ZOOM` and not the same decision: that one is
 * R-48's "tight enough to read a street, wide enough to steer" for a player
 * walking, and this is how close a master wants to be when they have picked one
 * name out of a list. They agree today; a change to either has no business
 * moving the other.
 *
 * A floor, never a ceiling — a master already zoomed in past it asked for that.
 */
export const FOCUS_ZOOM = 17;

/** Padding for `fitBounds`, in pixels, so the perimeter is not flush to the bezel. */
export const FIT_PADDING = 24;

export function boundsOf(polygons: Polygon | readonly Polygon[]): Bounds | undefined {
  // A list since R-71: the play area is the union of the open zones, and closing
  // the road between the two towns leaves two islands the camera has to frame
  // together. One polygon still works, because one is a list of one.
  const pieces = Array.isArray(polygons) ? polygons : [polygons as Polygon];
  const ring = pieces.flatMap((piece) => piece.coordinates[0] ?? []);
  if (ring.length === 0) return undefined;
  const lons = ring.map(([lon]) => lon ?? 0);
  const lats = ring.map(([, lat]) => lat ?? 0);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}

/**
 * What the camera framed, as something two snapshots can be compared by.
 *
 * R-48's fit runs **once and then holds**: repeated on every snapshot it would
 * yank an overview map back to the whole play area every five seconds, and
 * nothing could be looked at closely. A boolean was enough while the geometry
 * could not change under a running app. `POST /api/master/game/geo` moves it to
 * another town, so the question stopped being "has this map ever been framed"
 * and became "is it framed on *this* ground" — which a flag cannot answer, and
 * which is why switching profiles used to need a reload.
 *
 * The bounds and not the ring. The box is what the fit was computed from, so it
 * is exactly what a refit depends on; a key over every vertex would be built
 * from a few hundred numbers on every snapshot to answer a question about four.
 *
 * Not rounded, deliberately. These arrive as JSON from the server and nothing
 * on this path does arithmetic on them, so the same geometry is the same
 * digits — and a tolerance here could only hide a move too small to see.
 *
 * The empty string is "nothing framed yet", which is also what absent bounds
 * give: degenerate geometry is never a thing the camera has arrived at.
 */
export function framingKey(bounds: Bounds | undefined): string {
  if (!bounds) return '';
  return bounds.flat().join(',');
}

/** §14.2's bbox order — `minLon,minLat,maxLon,maxLat` — as MapLibre bounds. */
export function boundsOfBbox(bbox: Game['basemap']['bbox']): Bounds {
  const [west, south, east, north] = bbox;
  return [
    [west, south],
    [east, north],
  ];
}

export interface CameraTarget {
  center?: [number, number];
  zoom?: number;
  pitch: number;
  bearing: number;
}

/**
 * The camera for a viewer, a mode and whatever position is available.
 *
 * **R-49 is absolute**: a master is north up with no pitch in both view modes,
 * whatever mode is asked for. A master's map is a picture of a place, read
 * against a printed plan and pointed at over a walkie — a rotating, tilted one
 * makes "north-east corner" a thing you have to work out.
 *
 * R-48's navigation mode follows the player. With no position — the feed has
 * not started, or GPS is lost indoors — there is nothing to follow, so the
 * centre is left alone rather than jumping to a default: a map that snaps to
 * the middle of the venue every time a fix drops out is worse than one that
 * stays where the player last was.
 *
 * @param bearing the smoothed heading from `Heading`, already frozen by R-50.1
 *                where it needed freezing. Ignored for `OVERVIEW` and for every
 *                master.
 */
export function cameraFor(
  viewer: Viewer,
  mode: MapMode,
  options: { position?: { lat: number; lon: number }; bearing?: number },
): CameraTarget {
  if (viewer === 'MASTER' || mode === 'OVERVIEW') {
    return { pitch: 0, bearing: 0 };
  }
  return {
    ...(options.position === undefined
      ? {}
      : { center: [options.position.lon, options.position.lat] as [number, number] }),
    zoom: NAVIGATION_ZOOM,
    pitch: NAVIGATION_PITCH,
    bearing: options.bearing ?? 0,
  };
}

/**
 * Whether this viewer may rotate or tilt the map by hand.
 *
 * The same R-49 prohibition, applied to the gestures rather than to the camera:
 * `cameraFor()` cannot return a rotated master camera, but a two-finger twist
 * would rotate one anyway, and nothing would ever put it back.
 */
export function interactionsFor(viewer: Viewer): { rotate: boolean; pitch: boolean } {
  return viewer === 'MASTER' ? { rotate: false, pitch: false } : { rotate: true, pitch: true };
}

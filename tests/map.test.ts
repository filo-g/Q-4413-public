import { describe, expect, it } from 'vitest';

import { absoluteArchiveUrl } from '../apps/web/src/map/archive.ts';
import {
  boundsOf,
  boundsOfBbox,
  cameraFor,
  framingKey,
  interactionsFor,
  MIN_ZOOM,
  NAVIGATION_PITCH,
  NAVIGATION_ZOOM,
} from '../apps/web/src/map/camera.ts';
import type { Dot, Frame } from '../apps/web/src/map/frame.ts';
import { circlePolygon, gameGeoJson, positionsGeoJson } from '../apps/web/src/map/layers.ts';
import {
  basemapStaysUnderTheGame,
  buildStyle,
  hasNoSymbolLayers,
  outlinesAreLineLayers,
  STREET_LABEL_LAYER,
  STYLE,
  theOnlySymbolLayerIsStreetNames,
} from '../apps/web/src/map/style.ts';
import type { Polygon } from '@q4413/shared';

/**
 * The map, in the parts that are arithmetic and invariants rather than a
 * canvas: R-47's bounds, R-48's two modes, R-49's prohibition, R-51's single
 * source of features, and §14.3's structural absence of labels.
 */
const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-4.49, 36.65],
      [-4.47, 36.65],
      [-4.47, 36.67],
      [-4.49, 36.67],
      [-4.49, 36.65],
    ],
  ],
};

const frame: Frame = {
  perimeter: [square],
  ingestArea: square,
  zones: [{ id: 'z1', name: 'NORTE ESTE', geometry: square, sector: 'norte' }],
  pois: [{ id: 'p1', name: 'PARKING', lat: 36.66, lon: -4.48, category: 'MEETING_POINT' }],
  markers: [
    { id: 'm1', label: 'ALFA', lat: 36.661, lon: -4.481, audience: { kind: 'all' }, placedAt: 0 },
  ],
  dropPoints: [{ id: 'p2', label: 'BRAVO', lat: 36.659, lon: -4.479 }],
  // R-64, two segments: a route with a blackout in the middle of it is the
  // shape `routeAt()` produces and the one the layer has to survive.
  route: [
    [
      [-4.48, 36.66],
      [-4.481, 36.661],
    ],
    [
      [-4.479, 36.662],
      [-4.478, 36.663],
    ],
  ],
};

const dot = (over: Partial<Dot> = {}): Dot => ({
  key: 'a',
  label: 'ALFA',
  lat: 36.66,
  lon: -4.48,
  kind: 'PLAYER',
  state: 'MOVING',
  uncertaintyMetres: 10,
  unlocatable: false,
  eliminated: false,
  ...over,
});

describe('style — §14.3', () => {
  /**
   * §14.3's argument, narrowed by R-69 rather than dropped. One symbol layer is
   * allowed and it is the street names, because a town is coordinated by street
   * name over the radio in a way a single venue was not. Everything else the
   * basemap carries — `places`, `pois`, `boundaries` — still cannot render,
   * because nothing references those layers: absent, not filtered.
   */
  it('has exactly one symbol layer and it is the street names, before and after patching', () => {
    expect(theOnlySymbolLayerIsStreetNames(STYLE)).toBe(true);
    expect(
      theOnlySymbolLayerIsStreetNames(
        buildStyle({ pmtilesUrl: 'https://tiles/v1/zone.pmtiles', streetNames: true }),
      ),
    ).toBe(true);
  });

  /**
   * R-69's exception is per location, so the locations that did not ask for it
   * get §14.3 unamended — **no symbol layer at all**, rather than one that is
   * present and switched off. A town is coordinated by street name; a shopping
   * centre is coordinated by zone name, and the lanes of its car park drawn on
   * top of those zones are the ground shouting over the figure.
   */
  it('takes the street names back out for a location that is read by zone name', () => {
    const venue = buildStyle({ pmtilesUrl: 'https://tiles/v3/un-recinto.pmtiles' });
    expect(hasNoSymbolLayers(venue)).toBe(true);
    expect(venue.layers.some((layer) => layer.id === STREET_LABEL_LAYER)).toBe(false);
    // The roads themselves stay: this removes the lettering, not the streets.
    expect(venue.layers.some((layer) => layer.id === 'roads-major')).toBe(true);
  });

  /**
   * Absent has to mean off, because a game is seeded and not deployed: the one
   * in storage predates the field, and a payload without it must get the style
   * §14.3 describes rather than the one R-69 relaxed it to.
   */
  it('reads a missing flag as off, so a stale payload fails back to the rule', () => {
    expect(hasNoSymbolLayers(buildStyle({ pmtilesUrl: 'https://tiles/v1/zone.pmtiles' }))).toBe(
      true,
    );
  });

  it('draws no label from a layer that is about places rather than streets', () => {
    const symbols = STYLE.layers.filter((layer) => layer.type === 'symbol');
    for (const layer of symbols) expect(layer['source-layer']).toBe('roads');
    // The label layers exist in the archive and are never referenced, which is
    // what keeps them unrenderable rather than merely hidden.
    const referenced = new Set(STYLE.layers.map((layer) => layer['source-layer']));
    for (const absent of ['places', 'pois', 'boundaries']) {
      expect(referenced.has(absent)).toBe(false);
    }
  });

  /**
   * MapLibre cannot draw any text without one, and it has to be same-origin:
   * R-52 puts the map offline, and a glyph range fetched from a CDN is a label
   * layer that works at the desk and not at the venue.
   */
  it('serves its glyphs from the bundle', () => {
    expect(STYLE.glyphs).toBe('/fonts/{fontstack}/{range}.pbf');
    const label = STYLE.layers.find((layer) => layer.id === STREET_LABEL_LAYER);
    expect((label?.layout as { 'text-font'?: string[] })?.['text-font']).toEqual(['VT323']);
  });

  it('points the basemap source at the archive from the payload', () => {
    const style = buildStyle({ pmtilesUrl: 'https://tiles.example/v1/zone.pmtiles' });
    expect(style.sources.basemap?.url).toBe('pmtiles://https://tiles.example/v1/zone.pmtiles');
  });

  /** No archive has been cut yet, so this is the state the map ships in (M7). */
  it('drops the basemap entirely when there is no archive, rather than failing per tile', () => {
    const style = buildStyle({ pmtilesUrl: '' });
    expect(style.sources.basemap).toBeUndefined();
    expect(style.layers.some((layer) => layer.source === 'basemap')).toBe(false);
    // The game geometry still draws, which is the point of not failing hard.
    expect(style.layers.some((layer) => layer.id === 'game-perimeter')).toBe(true);
    expect(style.layers.some((layer) => layer.id === 'position-dots')).toBe(true);
  });

  /**
   * The failure this caught: `roads-major-centreline` painted `#ffb000` with
   * `line-dasharray: [6, 5]` while `game-zones-outline` painted `#b3760a` with
   * `[7, 6]` — a dashed amber road and a dashed amber zone edge one dash unit
   * apart, with the road the brighter of the two. Nothing was broken; the two
   * layers were simply speaking the same language, and the ground was louder
   * than the figure.
   */
  it('keeps the dash and the top of the palette for the game', () => {
    expect(basemapStaysUnderTheGame(STYLE)).toBe(true);
    // With the labels in, because R-69's layer is a basemap layer and the rule
    // is about every one of them: amber lettering over the zone outlines would
    // be the loudest thing on the map and it would be the ground saying it.
    expect(
      basemapStaysUnderTheGame(
        buildStyle({ pmtilesUrl: 'https://tiles/v1/zone.pmtiles', streetNames: true }),
      ),
    ).toBe(true);
  });

  it('catches a basemap layer that takes the game vocabulary', () => {
    const style = buildStyle({ pmtilesUrl: 'https://tiles/v1/zone.pmtiles' });
    const road = style.layers.find((layer) => layer.id === 'roads-major');
    expect(road).toBeDefined();
    (road!.paint as Record<string, unknown>)['line-dasharray'] = [6, 5];
    expect(basemapStaysUnderTheGame(style)).toBe(false);
  });

  /**
   * The symptom was "the building lines look wrong at zoom", and both halves of
   * it are invisible from a desk. `fill-outline-color` draws one device pixel
   * with no antialiasing, so R-48's 50° pitch broke the far edges into a dotted
   * shimmer; and the archive stops at z15, so past z18 a corner lands on a
   * whole-pixel grid whatever the style says. The fix is a real line layer and
   * a fill under it — and the regression is a one-line simplification back.
   */
  it('draws every basemap outline as a line layer', () => {
    expect(outlinesAreLineLayers(STYLE)).toBe(true);
    expect(
      outlinesAreLineLayers(
        buildStyle({ pmtilesUrl: 'https://tiles/v1/zone.pmtiles', streetNames: true }),
      ),
    ).toBe(true);
  });

  it('catches a basemap outline drawn off a fill', () => {
    const style = buildStyle({ pmtilesUrl: 'https://tiles/v1/zone.pmtiles' });
    const buildings = style.layers.find((layer) => layer.id === 'buildings');
    expect(buildings).toBeDefined();
    (buildings!.paint as Record<string, unknown>)['fill-outline-color'] = '#4a3104';
    expect(outlinesAreLineLayers(style)).toBe(false);
  });

  /**
   * R-45's rule about time, applied to space: the line is a **direction, not a
   * route**. Nothing in this app knows where the walls are — §14.3 strips the
   * basemap's labels and there is no routing anywhere — so two points and a
   * straight line between them is the only honest shape, and it is what the
   * producer has to emit.
   */
  it('draws a course as two points and nothing in between', () => {
    const course = gameGeoJson(frame, {
      from: { lat: 36.66, lon: -4.48 },
      to: { lat: 36.661, lon: -4.481 },
    }).features.find((feature) => feature.properties?.featureType === 'COURSE');
    expect(course).toBeDefined();
    expect(course!.geometry.type).toBe('LineString');
    expect((course!.geometry as { coordinates: number[][] }).coordinates).toEqual([
      [-4.48, 36.66],
      [-4.481, 36.661],
    ]);
  });

  /** No destination, no line. A course with one end is a bearing off nowhere. */
  it('emits nothing when there is no destination', () => {
    const drawn = gameGeoJson(frame).features.map((feature) => feature.properties?.featureType);
    expect(drawn).not.toContain('COURSE');
  });

  /**
   * R-71's lookup, as data. The map has no labels (§14.3), so with fourteen
   * sectors the panel's list is the only place their names are written down —
   * and pointing at a row is how a master who has never walked the district
   * finds out which ground it is.
   */
  it('marks the zones of the sector being pointed at', () => {
    const lit = gameGeoJson(frame, undefined, { highlight: new Set(['z1']) });
    const zone = lit.features.find((feature) => feature.properties?.featureType === 'ZONE');
    expect(zone?.properties?.highlight).toBe(true);
    expect(zone?.properties?.closed).toBe(false);
  });

  /**
   * Both properties are written on every zone, never left off. MapLibre's
   * `case` wants a boolean and `["get", ...]` on a missing property answers
   * null, which is not one — the layer would take its default for every zone
   * and the highlight would silently never appear.
   */
  it('always writes both marks, because a missing one reads as null in the style', () => {
    const plain = gameGeoJson(frame);
    for (const zone of plain.features.filter((f) => f.properties?.featureType === 'ZONE')) {
      expect(zone.properties?.highlight).toBe(false);
      expect(zone.properties?.closed).toBe(false);
    }
  });

  /**
   * A closed sector's ground is on the master's map and out of play (R-71), and
   * the two are different states: highlighted wins, because the master is
   * pointing at it in order to open it again.
   */
  it('marks closed ground, and lets the highlight sit on top of it', () => {
    const shut = gameGeoJson(frame, undefined, {
      closed: new Set(['z1']),
      highlight: new Set(['z1']),
    });
    const zone = shut.features.find((feature) => feature.properties?.featureType === 'ZONE');
    expect(zone?.properties?.closed).toBe(true);
    expect(zone?.properties?.highlight).toBe(true);
  });

  it('does not mutate the imported style, which every map on the page shares', () => {
    buildStyle({ pmtilesUrl: '' });
    expect(STYLE.sources.basemap).toBeDefined();
  });

  /**
   * §14's documented silent failure: the starter style filtered on lower-case
   * `featureType` while every producer in the repo emits upper case, so the
   * game geometry rendered blank with nothing in the console.
   */
  it('filters game layers on the case the producers actually emit', () => {
    // With a course, because a layer filtering on a `featureType` nothing emits
    // is the failure this test is for — and `COURSE` is only emitted when the
    // player has said where they are going, so the producer has to be asked the
    // way the map asks it. `ROUTE` is the same shape of conditional feature and
    // is on the fixture's frame for the same reason.
    const emitted = new Set(
      gameGeoJson(frame, {
        from: { lat: 36.66, lon: -4.48 },
        to: { lat: 36.661, lon: -4.481 },
      }).features.map((feature) => feature.properties?.featureType as string),
    );
    for (const layer of STYLE.layers) {
      if (layer.source !== 'game') continue;
      const filter = layer.filter as [string, unknown, string] | undefined;
      expect(filter).toBeDefined();
      expect(emitted).toContain(filter![2]);
    }
  });
});

describe('absoluteArchiveUrl — R-52b', () => {
  /**
   * The blank-map footgun of the new arrangement: `Protocol` matches the
   * style's `pmtiles://` reference against `Source.getKey()` **by string**, so
   * a path resolved on one side and not the other silently draws nothing.
   */
  it('resolves a same-origin path against the page', () => {
    expect(absoluteArchiveUrl('/basemap/v3/madrid.pmtiles', 'https://q4413.example.com')).toBe(
      'https://q4413.example.com/basemap/v3/madrid.pmtiles',
    );
  });

  it('leaves an absolute URL alone, which is what object storage still is', () => {
    const remote = 'https://tiles.example/v1/zone.pmtiles';
    expect(absoluteArchiveUrl(remote, 'https://q4413.example.com')).toBe(remote);
  });

  it('is idempotent, so resolving twice cannot produce two keys', () => {
    const once = absoluteArchiveUrl('/basemap/v1/x.pmtiles', 'https://q4413.example.com');
    expect(absoluteArchiveUrl(once, 'https://q4413.example.com')).toBe(once);
  });
});

describe('layers — R-51 and R-12', () => {
  it('draws the frame it was given, and nothing else', () => {
    const types = gameGeoJson(frame).features.map((feature) => feature.properties?.featureType);
    expect(types).toEqual(['PERIMETER', 'INGEST_AREA', 'ZONE', 'ROUTE', 'ROUTE']);
  });

  /**
   * R-64. One feature per segment, because a gap has to be structurally a gap:
   * a single MultiLineString draws the same picture today and leaves the
   * blackout as a property of the coordinate array, one flatten away from a
   * straight line across it.
   */
  it('emits one route feature per segment, and none for an empty route', () => {
    const segments = gameGeoJson(frame).features.filter(
      (feature) => feature.properties?.featureType === 'ROUTE',
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]!.geometry.type).toBe('LineString');
    expect(gameGeoJson({ ...frame, route: [] }).features).toHaveLength(3);
  });

  /**
   * The POIs and the markers are diamonds now, and a diamond that holds its
   * size on screen cannot be a layer in this style — §14.3 leaves it no symbol
   * layer, and metres would swell as the map zooms out. They are DOM markers in
   * `GameMap`, so nothing may be emitted for them here: a feature in a source
   * that no layer reads looks drawn and is not, which is the silent-blank
   * failure §14 warns about, arriving from the other direction.
   */
  it('emits nothing for the furniture the DOM draws', () => {
    const emitted = gameGeoJson(frame).features.map((feature) => feature.properties?.featureType);
    expect(emitted).not.toContain('POI');
    expect(emitted).not.toContain('MARKER');
    expect(frame.pois.length).toBeGreaterThan(0);
  });

  it('gives a NO_LINK dot a circle in metres, not pixels', () => {
    const features = positionsGeoJson([dot({ state: 'NO_LINK', uncertaintyMetres: 100 })]);
    const circle = features.features.find((f) => f.properties?.featureType === 'UNCERTAINTY');
    expect(circle).toBeDefined();
    const ring = (circle!.geometry as Polygon).coordinates[0]!;
    // 100 m north of the centre, in degrees of latitude.
    const north = Math.max(...ring.map(([, lat]) => lat ?? 0));
    expect((north - 36.66) * 111_132).toBeCloseTo(100, 0);
  });

  it('gives a live dot no circle at all (R-12)', () => {
    const features = positionsGeoJson([dot({ state: 'STATIONARY', uncertaintyMetres: 40 })]);
    expect(features.features.map((f) => f.properties?.featureType)).toEqual(['DOT']);
  });

  it('gives an unlocatable dot no circle, and still draws the dot', () => {
    const features = positionsGeoJson([
      dot({ state: 'NO_LINK', uncertaintyMetres: 900, unlocatable: true }),
    ]);
    expect(features.features.map((f) => f.properties?.featureType)).toEqual(['DOT']);
    expect(features.features[0]?.properties?.unlocatable).toBe(true);
  });

  /**
   * R-22 on the map. An eliminated player's dot kept moving for a master in
   * AUTHORITATIVE — the mode whose entire purpose is knowing who is out — and
   * was drawn exactly like a live one. The mark is `✕` and it is a DOM marker,
   * because a glyph has to hold its size on screen; what this source has to do
   * is emit **nothing**, so the cross replaces the dot rather than sitting on
   * top of one.
   */
  it('emits no feature at all for an eliminated player', () => {
    expect(positionsGeoJson([dot({ eliminated: true, state: 'MOVING' })]).features).toEqual([]);
  });

  it('gives an eliminated player no uncertainty circle either', () => {
    const features = positionsGeoJson([
      dot({ eliminated: true, state: 'NO_LINK', uncertaintyMetres: 100 }),
    ]);
    expect(features.features).toEqual([]);
  });

  /**
   * And nothing when they are the selection either, which is what the two rules
   * above cost and where the cost was found.
   *
   * Everything a dot does on the map, it does through a feature in this source:
   * `position-selected` filters on `selected`, and `GameMap`'s click handler
   * reads `queryRenderedFeatures` on the dot layer. With no feature there, an
   * eliminated player could not be picked off the map at all — and because a
   * press that hits nothing is taken for a press on open ground, the cross
   * *closed* the card instead of opening it.
   *
   * The fix is not here. Emitting an invisible dot to be clicked would put a
   * second mark on the position R-22 gave a cross, which is the thing this
   * source refuses to do. The cross carries the key instead, and the ring is
   * drawn on it in CSS — so this stays empty on purpose, and this test says so.
   */
  it('emits nothing for an eliminated player even when they are selected', () => {
    const out = dot({ key: 'p-out', eliminated: true, state: 'MOVING' });
    expect(positionsGeoJson([out], 'p-out').features).toEqual([]);
  });

  it('puts every circle under every dot', () => {
    const features = positionsGeoJson([
      dot({ key: 'a', state: 'NO_LINK', uncertaintyMetres: 200 }),
      dot({ key: 'b', state: 'NO_LINK', uncertaintyMetres: 200 }),
    ]);
    expect(features.features.map((f) => f.properties?.featureType)).toEqual([
      'UNCERTAINTY',
      'UNCERTAINTY',
      'DOT',
      'DOT',
    ]);
  });

  it('closes the circle ring', () => {
    const ring = circlePolygon(-4.48, 36.66, 50).coordinates[0]!;
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });
});

describe('camera — R-47, R-48, R-49', () => {
  it('reads bounds off a ring and off §14.2 bbox order alike', () => {
    expect(boundsOf(square)).toEqual([
      [-4.49, 36.65],
      [-4.47, 36.67],
    ]);
    expect(boundsOfBbox([-4.49, 36.65, -4.47, 36.67])).toEqual([
      [-4.49, 36.65],
      [-4.47, 36.67],
    ]);
    expect(boundsOf({ type: 'Polygon', coordinates: [] })).toBeUndefined();
  });

  /**
   * The fit holds until the ground moves, which is the whole of why a profile
   * switch no longer needs a reload. Two rings over the same box are the same
   * framing and must not re-ease the camera; a ring somewhere else must.
   */
  it('keys the framing on the ground, not on the snapshot (R-47)', () => {
    const shifted: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-4.49, 36.65],
          [-4.48, 36.65],
          [-4.47, 36.65],
          [-4.47, 36.67],
          [-4.49, 36.67],
          [-4.49, 36.65],
        ],
      ],
    };
    // Same box, one more vertex: the camera has nothing to do.
    expect(framingKey(boundsOf(shifted))).toBe(framingKey(boundsOf(square)));
    const elsewhere: Polygon = {
      type: 'Polygon',
      coordinates: [square.coordinates[0]!.map(([lon, lat]) => [lon! + 0.2, lat!])],
    };
    expect(framingKey(boundsOf(elsewhere))).not.toBe(framingKey(boundsOf(square)));
    // Absent bounds are "never framed", which is what the empty key means.
    expect(framingKey(undefined)).toBe('');
    expect(framingKey(boundsOf({ type: 'Polygon', coordinates: [] }))).toBe('');
  });

  it('follows the player, pitched and turned, in navigation mode (R-48)', () => {
    const camera = cameraFor('PLAYER', 'NAVIGATION', {
      position: { lat: 36.66, lon: -4.48 },
      bearing: 120,
    });
    expect(camera.center).toEqual([-4.48, 36.66]);
    expect(camera.zoom).toBe(NAVIGATION_ZOOM);
    expect(camera.pitch).toBe(NAVIGATION_PITCH);
    expect(camera.bearing).toBe(120);
  });

  /**
   * R-48 says "tight zoom" and gives no number, so the only thing a test can
   * hold is the relationship: navigation is closer than the widest the map is
   * ever allowed to be. The number itself moved once already — it was picked
   * when the archive stopped at z15 and everything past 17 was overzoom.
   */
  it('is closer than the zoom floor, whatever the number is', () => {
    expect(NAVIGATION_ZOOM).toBeGreaterThan(MIN_ZOOM);
  });

  it('leaves the camera where it was when there is no fix to follow', () => {
    const camera = cameraFor('PLAYER', 'NAVIGATION', { bearing: 90 });
    expect(camera.center).toBeUndefined();
  });

  it('is north up and flat in overview (R-48)', () => {
    const camera = cameraFor('PLAYER', 'OVERVIEW', {
      position: { lat: 36.66, lon: -4.48 },
      bearing: 120,
    });
    expect(camera.pitch).toBe(0);
    expect(camera.bearing).toBe(0);
  });

  /**
   * R-49 is a prohibition, so it is enforced where it cannot be forgotten: a
   * master asking for navigation still gets north up and no pitch.
   */
  it('refuses to rotate or tilt a master map in either mode (R-49)', () => {
    for (const mode of ['NAVIGATION', 'OVERVIEW'] as const) {
      const camera = cameraFor('MASTER', mode, {
        position: { lat: 36.66, lon: -4.48 },
        bearing: 200,
      });
      expect(camera.pitch).toBe(0);
      expect(camera.bearing).toBe(0);
    }
    expect(interactionsFor('MASTER')).toEqual({ rotate: false, pitch: false });
    expect(interactionsFor('PLAYER')).toEqual({ rotate: true, pitch: true });
  });
});

describe('buildStyle — R-24\'s palette', () => {
  const URL_ = 'https://tiles/v1/zone.pmtiles';
  const paintOf = (style: ReturnType<typeof buildStyle>, id: string) =>
    style.layers.find((layer) => layer.id === id)!.paint as Record<string, unknown>;

  /**
   * `:root[data-view-mode]` turns every surface in the app green except the one
   * that is a WebGL canvas, so the map needs the swap as data. Amber roads under
   * a green roster is the machine disagreeing with itself about which mode it is
   * in, which is the one thing R-24's colour exists to say.
   */
  it('turns the game geometry green, and the ground stays put', () => {
    const green = buildStyle({ pmtilesUrl: URL_ }, { authoritative: true });
    expect(paintOf(green, 'background')['background-color']).toBe('#140f0a');
    expect(JSON.stringify(green.layers)).not.toContain('#ffb000');
  });

  /**
   * §14 puts the basemap under the game, and it is held by luminance rather than
   * by layer order alone. The green ramp is luminance-matched per colour for
   * exactly this reason, so the predicate that guards the amber style has to
   * answer the same way for the green one.
   */
  it('keeps the basemap under the game', () => {
    expect(basemapStaysUnderTheGame(buildStyle({ pmtilesUrl: URL_ }, { authoritative: true }))).toBe(
      true,
    );
  });

  /**
   * Daylight wins, and the stylesheet settles it the same way — equal
   * specificity, `[data-contrast='daylight']` written second. Reading the screen
   * outdoors is why that mode exists; a mode indicator that costs legibility is
   * a worse trade than one that is missing while the sun is out.
   */
  it('gives way to daylight when both are asked for', () => {
    const both = buildStyle({ pmtilesUrl: URL_ }, { daylight: true, authoritative: true });
    expect(paintOf(both, 'background')['background-color']).toBe('#e7dcc6');
  });

  /** Neither option is the authored style, untouched. */
  it('leaves the authored style alone when neither is asked for', () => {
    const plain = buildStyle({ pmtilesUrl: URL_ });
    expect(paintOf(plain, 'background')['background-color']).toBe('#140f0a');
    expect(JSON.stringify(plain.layers)).toContain('#ffb000');
  });
});

describe('buildStyle — the daylight palette', () => {
  /**
   * R-69's lettering goes through `repaint()` like everything else, and it has
   * to: `text-color` and `text-halo-color` are the authored dark-screen pair,
   * so a label left unswapped in daylight is amber-on-pale with a near-black
   * halo — the one combination on the map that is *less* legible outdoors than
   * the mode it was turned on to fix.
   *
   * It works because `repaint()` walks paint values rather than naming
   * properties, which is the whole reason it was written that way. This is the
   * first layer to arrive since, so it is the first proof.
   */
  it('repaints the street names with everything else', () => {
    const lit = buildStyle(
      { pmtilesUrl: 'https://tiles/v1/zone.pmtiles', streetNames: true },
      { daylight: true },
    );
    const paint = lit.layers.find((layer) => layer.id === STREET_LABEL_LAYER)!.paint as Record<
      string,
      string
    >;
    expect(paint['text-color']).toBe('#6d5a30');
    expect(paint['text-halo-color']).toBe('#e7dcc6');
  });

  /**
   * The map is why `daylight` exists. Everywhere else in the app a token swap is
   * enough; MapLibre paint values are colour literals inside a style object and
   * no stylesheet reaches them, so the swap has to arrive as data.
   */
  it('repaints the ground and leaves the authored style alone', () => {
    const lit = buildStyle({ pmtilesUrl: 'https://tiles/v1/zone.pmtiles' }, { daylight: true });
    const background = lit.layers.find((layer) => layer.id === 'background');
    expect((background!.paint as Record<string, unknown>)['background-color']).toBe('#e7dcc6');

    // The imported style is a singleton shared by every map on the page, and
    // `buildStyle` clones before touching anything.
    const dark = buildStyle({ pmtilesUrl: 'https://tiles/v1/zone.pmtiles' });
    expect(
      (dark.layers.find((layer) => layer.id === 'background')!.paint as Record<string, unknown>)[
        'background-color'
      ],
    ).toBe('#140f0a');
  });

  /**
   * Prominence inverts with the ground: on a pale screen the most prominent
   * value is the darkest one. What must survive is the *order* — §14 puts the
   * basemap under the game, and a palette that lifted a road above the
   * perimeter would undo that without changing a single rule.
   */
  it('keeps the game above the basemap, upside down', () => {
    const lit = buildStyle({ pmtilesUrl: 'https://tiles/v1/zone.pmtiles' }, { daylight: true });
    const paintOf = (id: string, key: string): string =>
      (lit.layers.find((layer) => layer.id === id)!.paint as Record<string, string>)[key] as string;

    const luminance = (hex: string): number =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);

    // Darker is louder here, so the game's line has to be darker than the
    // brightest road under it.
    expect(luminance(paintOf('game-perimeter', 'line-color'))).toBeLessThan(
      luminance(paintOf('roads-major', 'line-color')),
    );
    // And every road has to be darker than the ground it is drawn on.
    expect(luminance(paintOf('roads-minor', 'line-color'))).toBeLessThan(
      luminance(paintOf('background', 'background-color')),
    );
  });

  /**
   * `circle-color` on the dots is a `case` expression with colour literals
   * inside it. A swap that only looked at plain strings would leave the people
   * amber on a pale screen — which is the one thing on the map that has to be
   * found at a glance.
   */
  it('reaches colours inside an expression', () => {
    const lit = buildStyle({ pmtilesUrl: 'https://tiles/v1/zone.pmtiles' }, { daylight: true });
    const dots = lit.layers.find((layer) => layer.id === 'position-dots');
    const paint = JSON.stringify((dots!.paint as Record<string, unknown>)['circle-color']);
    expect(paint).not.toContain('#ffb000');
  });
});

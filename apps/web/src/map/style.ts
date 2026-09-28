import type { Game } from '@q4413/shared';

import styleJson from './style.json';

/**
 * The style as MapLibre receives it: the file in this directory, with §14.4's
 * archive URL patched in.
 *
 * The URL cannot live in the file. It is per location and per deploy — a
 * versioned R2 path (`.../v1/zone.pmtiles`), and the two geo profiles need two
 * archives (§11, §14.6) — so it arrives on the payload as `Game.basemap` and is
 * substituted here.
 *
 * The style is otherwise authored rather than generated, which is the whole of
 * why R-47's "no labels" is safe: §14.3 makes the absence structural, and the
 * one thing this function must never do is add a layer.
 */

/**
 * The shape actually used here, rather than MapLibre's `StyleSpecification`.
 *
 * Deliberate: this module is in the root Vitest suite (tsconfig.tests.json), and
 * pulling MapLibre's types in would pull a DOM-shaped dependency into a test
 * that only wants to know which layers exist. The component casts on the way in.
 */
export interface MapStyle {
  version: number;
  name: string;
  sources: Record<string, { type: string; url?: string; [key: string]: unknown }>;
  layers: Array<{ id: string; type: string; source?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export const STYLE: MapStyle = styleJson as MapStyle;

/** The source id every basemap layer draws from, and the one this file patches. */
export const BASEMAP_SOURCE = 'basemap';

/**
 * @param basemap `Game.basemap` from the payload. An empty `pmtilesUrl` is the
 *        normal state until an archive has been extracted and uploaded (§14.6),
 *        and it is handled rather than tolerated: the basemap source and every
 *        layer drawn from it are **removed**. MapLibre given a source that
 *        cannot load logs a network error per tile and renders nothing; removed,
 *        the game geometry draws on the background colour and the map still
 *        works, which is what the scatter has been doing all along.
 */
/**
 * The daylight palette, as a substitution over the authored one.
 *
 * The map is the reason `daylight` exists at all: a street at two in the
 * afternoon defeats an amber-on-black screen whatever the contrast setting
 * does, because almost none of its pixels are producing light. Everywhere else
 * a CSS token swap is enough — here it cannot be, because MapLibre paint values
 * are colour literals inside a style object and a stylesheet cannot reach them.
 * So the swap arrives as data.
 *
 * **Prominence inverts with the ground.** Amber `#ffb000` is the game's colour
 * on a dark screen because it is the brightest thing there; on a pale one the
 * most prominent value is the darkest, so the game geometry comes out as strong
 * ink and the basemap as tints of the ground. The hierarchy §14 sets — the
 * basemap under the game, the game owning the dash and the top of the palette —
 * is kept by keeping the *order*, not the values.
 *
 * Every key is a colour that appears in `style.json`. A colour added there
 * without a partner here simply does not change, which is the safe failure: it
 * stays legible on a dark ground and is merely wrong on a pale one, rather than
 * vanishing.
 */
const DAYLIGHT: Readonly<Record<string, string>> = {
  // The ground, and what is drawn on it as tints of itself.
  '#140f0a': '#e7dcc6',
  '#1a140c': '#dccfb4',
  '#241a0e': '#d3c4a4',
  '#0f1418': '#b6c4cd',
  // The roads, dark on pale where they were pale on dark, and still three
  // weights apart.
  '#4a3104': '#a08d68',
  '#6b4606': '#8a7346',
  '#7d5205': '#6d5a30',
  // The game. `#ffb000` is R-51's geometry and `#ffd899` its emphasis, so the
  // second has to stay the *more* prominent of the two — which is darker here.
  '#ffb000': '#3d2a06',
  '#ffd899': '#120c04',
  '#b3760a': '#6a5834',
};

/**
 * R-24's palette, as a substitution over the authored one.
 *
 * The map needs its own copy of the green for the same reason `daylight` does:
 * MapLibre paint values are colour literals inside a style object, a stylesheet
 * cannot reach them, and `:root[data-view-mode]` therefore turns the whole app
 * green **except the one surface that is a WebGL canvas**. Amber roads under a
 * green roster is the machine disagreeing with itself about which mode it is
 * in, which is the one thing this mode exists to say.
 *
 * The six values are the same computation as `terminal.css`: hue held at 135°
 * and **luminance matched per colour**, so every contrast against the ground is
 * the one §14 already tuned. Four have a token twin there; `#4a3104` and
 * `#7d5205` are the two road weights that live only in the style, and they are
 * rotated the same way so the three weights stay three weights apart.
 *
 * The grounds are deliberately absent. `--screen` does not move for this mode
 * either, so a ground listed here would be the map disagreeing with the panel
 * it sits behind.
 */
const AUTHORITATIVE: Readonly<Record<string, string>> = {
  // The game. R-51's geometry and its emphasis, the twins of `--phosphor` and
  // `--phosphor-bright`.
  '#ffb000': '#00de37',
  '#ffd899': '#25ff5b',
  '#b3760a': '#08982c',
  // The roads, three weights apart before and after.
  '#4a3104': '#033f12',
  '#6b4606': '#055b1a',
  '#7d5205': '#046a1e',
};

export function buildStyle(
  basemap: Pick<Game['basemap'], 'pmtilesUrl' | 'streetNames'>,
  options: { daylight?: boolean; authoritative?: boolean } = {},
): MapStyle {
  // Structured clone rather than a shallow copy: the caller hands this to
  // MapLibre, which mutates the style it is given, and the imported JSON module
  // is a singleton shared by every map on the page.
  const style = structuredClone(STYLE);

  if (!basemap.pmtilesUrl) {
    delete style.sources[BASEMAP_SOURCE];
    style.layers = style.layers.filter((layer) => layer.source !== BASEMAP_SOURCE);
    return style;
  }

  const source = style.sources[BASEMAP_SOURCE];
  if (source) source.url = `pmtiles://${basemap.pmtilesUrl}`;

  /**
   * R-69's exception, taken back out for a location that did not ask for it.
   *
   * **Removed, not hidden.** A `visibility: none` layer is still a layer that
   * requests glyph ranges and still one §14.3's predicate has to count, so
   * hiding it would leave the invariant answering "one symbol layer" for a map
   * that draws no text — and the whole value of that rule is that it is
   * countable. Off here means the style is the one §14.3 originally described.
   *
   * Absent means off (see `Game.basemap.streetNames`), so a payload from before
   * the field existed gets the old style rather than the new one.
   */
  if (!basemap.streetNames) {
    style.layers = style.layers.filter((layer) => layer.id !== STREET_LABEL_LAYER);
  }

  // Daylight wins, and the stylesheet settles it the same way: the two `:root`
  // rules have equal specificity and `[data-contrast='daylight']` is written
  // second. Reading the screen outdoors is why that mode exists at all, and a
  // mode indicator that costs legibility is a worse trade than one that is
  // missing for as long as the sun is out.
  if (options.daylight) return repaint(style, DAYLIGHT);
  if (options.authoritative) return repaint(style, AUTHORITATIVE);
  return style;
}

/**
 * Swap every colour a palette names, wherever it appears in a paint block.
 *
 * Walks the values rather than naming the properties, because the properties
 * are not a fixed list — `fill-color`, `line-color`, `circle-stroke-color`,
 * `fill-outline-color` and `background-color` are all in this style today and
 * the next layer added will bring another. A colour is recognised by being one,
 * which is the only thing all of them have in common.
 *
 * Expressions are walked too: `circle-color` is a `case` expression with colour
 * literals inside it, and a swap that only looked at plain strings would leave
 * the dots amber on a pale screen.
 */
function repaint(style: MapStyle, palette: Readonly<Record<string, string>>): MapStyle {
  const swap = (value: unknown): unknown => {
    if (typeof value === 'string') return palette[value.toLowerCase()] ?? value;
    if (Array.isArray(value)) return value.map(swap);
    return value;
  };
  for (const layer of style.layers) {
    const paint = layer['paint'] as Record<string, unknown> | undefined;
    if (!paint) continue;
    for (const key of Object.keys(paint)) {
      paint[key] = swap(paint[key]);
    }
  }
  return style;
}

/**
 * The one symbol layer there is allowed to be, as a predicate (R-69, §14.3).
 *
 * §14.3's original invariant was that **no** layer is of type `symbol`: with
 * none, street names and POI labels cannot render at all, so there is nothing
 * to filter and nothing that leaks through a misconfiguration. R-69 keeps that
 * argument and narrows it to one exception — a town is coordinated by street
 * name over the radio in a way a single venue was not, and a player who cannot
 * read the street they are standing on cannot say where they are.
 *
 * So the rule is no longer "none" but "exactly this one", which is a rule a
 * test can still hold. Everything else the basemap carries — `places`, `pois`,
 * `boundaries` — stays absent by never being referenced, which is the part of
 * §14.3 that did the work.
 *
 * **Both predicates are live, because the layer is per location.**
 * `Game.basemap.streetNames` is derived from the geo profile, so the authored
 * style always has the one symbol layer and a built style has it only where the
 * place is read by street name. `hasNoSymbolLayers()` is what the other
 * locations are held to, and it is §14.3 unamended.
 *
 * Still worth being a function, because the temptation it was written against
 * has not gone anywhere: a callsign drawn as a label arrives with a legitimate
 * reason every time, and a symbol layer cannot hold it at a fixed screen size
 * the way a DOM marker does.
 */
export const STREET_LABEL_LAYER = 'roads-labels';

export function hasNoSymbolLayers(style: MapStyle): boolean {
  return style.layers.every((layer) => layer.type !== 'symbol');
}

export function theOnlySymbolLayerIsStreetNames(style: MapStyle): boolean {
  const symbols = style.layers.filter((layer) => layer.type === 'symbol');
  if (symbols.length !== 1) return false;
  const [only] = symbols;
  return (
    only!.id === STREET_LABEL_LAYER &&
    only!.source === BASEMAP_SOURCE &&
    only!['source-layer'] === 'roads'
  );
}

/**
 * §14 again, and this one is about rendering rather than about palette.
 *
 * `fill-outline-color` looks like the cheap way to draw a building: one
 * property, no second layer. What it actually draws is **exactly one device
 * pixel, with no width to set and none of a line layer's antialiasing** — so
 * under R-48's 50° navigation pitch the far edges broke into a dotted shimmer,
 * and a phone at 2× drew them at half the weight of everything around them.
 *
 * The archive is the other half of it. It stops at z15 with 4096-unit tiles, so
 * at z18 a building corner lands on a 1 px grid and at z19 on a 2 px one; the
 * staircase on a diagonal wall is the archive's resolution and cannot be styled
 * away. A hairline makes that read as a broken line, and a fill with a proper
 * stroke makes it read as a block of a shopping centre.
 *
 * So the basemap draws its outlines as `line` layers. Held by a test because
 * the temptation is a one-line simplification that looks identical in a
 * screenshot taken flat, at desktop zoom, on a 1× display — which is every
 * screenshot anybody takes while editing the style.
 */
export function outlinesAreLineLayers(style: MapStyle): boolean {
  return style.layers
    .filter((layer) => layer.source === BASEMAP_SOURCE)
    .every((layer) => {
      const paint = (layer.paint ?? {}) as Record<string, unknown>;
      return paint['fill-outline-color'] === undefined;
    });
}

/**
 * The two brightest values in §9's palette. They belong to the game (R-51), and
 * the basemap is the ground it is drawn on.
 */
const GAME_ONLY_COLOURS = ['#ffb000', '#b3760a'];

/**
 * §14's figure and ground, as a predicate.
 *
 * The zone boundaries became unreadable and it was not the boundaries' fault:
 * `roads-major-centreline` painted `#ffb000` with `line-dasharray: [6, 5]`
 * while `game-zones-outline` painted `#b3760a` with `[7, 6]`. A dashed amber
 * road and a dashed amber zone edge, one dash unit apart — and the road was the
 * **brighter** of the two, which is the hierarchy upside down.
 *
 * Two rules keep it the right way up, and both are about vocabulary rather than
 * taste. **The dash belongs to the game**: the perimeter is solid, the zones
 * and the ingest area are dashed, R-12's circle is dotted, and a basemap that
 * dashes anything is speaking the same language as the geometry drawn over it.
 * **The top of the palette belongs to the game too**: the map is context, and
 * context that is as bright as content is not context.
 *
 * Held by a test, like the symbol rule above, because both temptations arrive
 * with a good reason — a dashed centreline is how a dual carriageway reads as
 * one road, and it was right about that.
 */
export function basemapStaysUnderTheGame(style: MapStyle): boolean {
  return style.layers
    .filter((layer) => layer.source === BASEMAP_SOURCE)
    .every((layer) => {
      const paint = (layer.paint ?? {}) as Record<string, unknown>;
      if (paint['line-dasharray'] !== undefined) return false;
      return Object.values(paint).every(
        (value) => typeof value !== 'string' || !GAME_ONLY_COLOURS.includes(value.toLowerCase()),
      );
    });
}

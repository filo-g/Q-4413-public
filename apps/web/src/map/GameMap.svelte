<script lang="ts">
  import 'maplibre-gl/dist/maplibre-gl.css';

  import {
    GeoJSONSource,
    LngLatBounds,
    Map as MapLibreMap,
    Marker,
    ScaleControl,
    addProtocol,
    type MarkerOptions,
    type StyleSpecification,
  } from 'maplibre-gl';
  import { PMTiles, Protocol } from 'pmtiles';
  import { onMount, untrack } from 'svelte';

  import { display } from '../display.svelte.ts';
  import { GLYPHS } from '../glyphs.ts';
  import { bearingDelta, bearingTo, Heading } from '../heading.ts';
  import { t } from '../i18n.ts';
  import { useBundledMapWorker } from '../map-worker.ts';
  import {
    boundsOf,
    boundsOfBbox,
    cameraFor,
    framingKey,
    interactionsFor,
    FIT_PADDING,
    FOCUS_ZOOM,
    MIN_ZOOM,
    type MapMode,
    type Viewer,
  } from './camera.ts';
  import { absoluteArchiveUrl, WholeArchiveSource } from './archive.ts';
  import type { Dot, Frame } from './frame.ts';
  import {
    DOT_LAYER,
    GAME_SOURCE,
    POSITIONS_SOURCE,
    gameGeoJson,
    positionsGeoJson,
  } from './layers.ts';
  import { Glide } from './glide.ts';
  import { buildStyle } from './style.ts';
  import type { Game, ProjectedPosition } from '@q4413/shared';

  /**
   * The map (R-47..R-52, §14). MapLibre driven imperatively, not wrapped in a
   * component abstraction — §15.4 says so because the camera work in R-48 and
   * R-50 is frame-level, and a reactive wrapper fights it.
   *
   * The basemap is a self-hosted `.pmtiles` extract read straight from R2 over
   * range requests: no tile server, no API key, and a single immutable file the
   * service worker can precache (R-52). Until one is uploaded `pmtilesUrl` is
   * empty and `buildStyle()` drops the basemap layers — the game geometry still
   * draws, on the background colour.
   *
   * There are no `symbol` layers anywhere in the style (§14.3), so street names
   * and POI labels cannot render. Callsigns and marker labels below are DOM
   * markers for that reason: they are ours, they are drawn outside the style,
   * and the invariant stays a structural fact rather than a convention somebody
   * has to remember while adding a label.
   */
  interface Props {
    frame: Frame | null;
    dots: Dot[];
    basemap: Game['basemap'];
    config: Game['config'];
    viewer: Viewer;
    /**
     * R-24's mode is open, so the map turns green with the rest of the app
     * (`AUTHORITATIVE` in `style.ts`).
     *
     * A prop and not a read of `game`: this component takes its world as
     * arguments, and a map that imported the session's view mode would be a
     * player's map depending on a master's state. The master passes it; the
     * player never does, which is also the projection's answer (§4).
     */
    authoritative?: boolean | undefined;
    /** The recipient's own position, for R-48's follow and R-50's heading. */
    self?: ProjectedPosition | undefined;
    /** Given by the master's marker panel: clicking the map reads back a coordinate pair. */
    onPick?: ((lon: number, lat: number) => void) | undefined;
    /**
     * A dot was tapped, or the tap missed every dot (`null`).
     *
     * The map is the interface now, so the detail about a person has to be
     * reachable **from the person** rather than from a table beside it. Dots are
     * a `circle` layer, so the hit test is MapLibre's own — it is done against
     * the rendered geometry, which means it lands where the dot appears rather
     * than where the coordinate is, and that is what makes it usable at the
     * zoom a venue is looked at.
     */
    onSelect?: ((key: string | null) => void) | undefined;
    /** The selected dot's key, drawn with a ring around it. */
    selected?: string | undefined;
    /**
     * A point was tapped, or the tap missed every point (`null`).
     *
     * Separate from `onSelect` rather than sharing its key space: a dot is a
     * person and a point is a place, they are drawn by two different mechanisms
     * — a `circle` layer and a DOM marker — and one callback returning ids from
     * two namespaces is one collision away from a card describing the wrong
     * thing.
     */
    onPoi?: ((id: string | null) => void) | undefined;
    /** The selected point's id, drawn brighter than the rest. */
    selectedPoi?: string | undefined;
    /**
     * A master's marker, tapped (R-20b).
     *
     * Its own callback and not `onPoi`, even though the gesture is the same and
     * the player's handler does the same thing with both. A point is the venue
     * and a marker is the master saying *go here, now*; they are separate id
     * spaces, they expire differently, and the master's own panel wants one of
     * them to open a card and the other to do nothing at all. One callback over
     * two namespaces is one collision away from a card describing the wrong
     * thing, which is the argument `onPoi` already makes against `onSelect`.
     *
     * Absent — as it is for the master — and a marker keeps the
     * `pointer-events: none` every other piece of furniture on the map has.
     */
    onMarker?: ((id: string) => void) | undefined;
    /** The marker the player is walking to, drawn lit. */
    selectedMarker?: string | undefined;
    /**
     * A point to light without selecting it.
     *
     * The master's list of points is the index for a map that cannot carry
     * their names (§14.3), and pointing at a row is the lookup. Separate from
     * `selectedPoi` because selecting opens a card and hovering must not.
     */
    highlightPoi?: string | undefined;
    /**
     * Zones to light without selecting anything, for the same reason as
     * `highlightPoi` above and at the next level up.
     *
     * The map carries no names (§14.3), so with a dozen sectors the panel's
     * list is the only place they are written down — and a master who has never
     * walked the ground cannot tell one outline from another. Pointing at a row lights the ground it names, which is what
     * makes closing one (R-71) a decision rather than a guess.
     */
    highlightZoneIds?: readonly string[] | undefined;
    /**
     * Zones that are on the map because the viewer may still point at them, and
     * are not in play (R-71).
     *
     * Master only in practice: `project()` gives a player the open sectors'
     * zones and nothing else, so for them this is always empty. Drawn as ground
     * that is out of play — no fill, no glow, a quiet outline — because the
     * alternative to drawing it is a panel row naming ground that is nowhere on
     * the screen.
     */
    closedZoneIds?: readonly string[] | undefined;
    /**
     * Where the player said they are going, as a line from where they are.
     *
     * Player only in practice, and it is a direction rather than a route — see
     * `Course` in `layers.ts` for why a straight line is the honest shape. The
     * near end is `self`, so a course with no fix to start from simply is not
     * drawn: a line from the middle of the venue would be a bearing off
     * somewhere nobody is standing.
     */
    course?: { lat: number; lon: number } | undefined;
    /**
     * Somewhere to look at for a moment, before coming back.
     *
     * A player taps *show me* beside a point in a list: the panel closes, the
     * camera slides over, and a second or two later it slides back to them. The
     * caller owns the clock — this is a coordinate that is either set or not —
     * because "how long is a glance" is a question about the list the tap came
     * from, not about the map.
     *
     * It moves the centre and nothing else. Zoom, pitch and bearing carry on
     * doing what they were doing, so what the player sees is the same map
     * panning rather than a second camera taking over.
     */
    peek?: { lat: number; lon: number } | undefined;
    /** Fired when the camera takes its axes back, so a view can drop its peek. */
    onRecentre?: (() => void) | undefined;
    /**
     * Somewhere to put the camera, from outside the map.
     *
     * A **new object every time**, even for the same pair — asking twice for
     * the same player is a real request, and identity is what makes the second
     * one arrive. There is no nonce to keep in step because of it.
     *
     * Only the master has this. R-48 gives a player a camera that follows them,
     * and a control that took it somewhere else would be a control that turns
     * navigation off without saying so.
     */
    focus?: { lon: number; lat: number } | undefined;
  }

  const {
    frame,
    dots,
    basemap,
    config,
    viewer,
    authoritative,
    self,
    onPick,
    onSelect,
    selected,
    onPoi,
    selectedPoi,
    onMarker,
    selectedMarker,
    highlightPoi,
    highlightZoneIds,
    closedZoneIds,
    course,
    peek,
    onRecentre,
    focus,
  }: Props = $props();

  let container: HTMLDivElement;
  /**
   * Where the scale bar is mounted. MapLibre offers four control corners and
   * this app has already spent all four — the callsign, the status block, the
   * HUD and the master's card — so the scale is placed by the layout rather
   * than by the library. See the chrome column below.
   */
  let scaleHost: HTMLDivElement;
  let map = $state<MapLibreMap | null>(null);
  /**
   * What went wrong, on screen.
   *
   * §14 warns twice that this map fails **blank with no useful console error**:
   * a wrong `source-layer`, a CORS policy, an archive that is not there. All of
   * them look identical to a working map over empty ground, and all of them are
   * discovered at the venue. MapLibre does raise an `error` event for every one
   * — it just has nowhere to put it — so this is that event, rendered.
   *
   * Kept in production deliberately. The person who needs it is a master on
   * game night with no devtools, not a developer.
   */
  let mapError = $state<string | null>(null);
  /** Set when the style and its initial sources have loaded. Absent is itself a symptom. */
  let styleReady = $state(false);
  /**
   * R-48's toggle, and R-49 layered over it: a master has no mode to be in.
   * Derived rather than initialised from `viewer`, so the prohibition is not a
   * value somebody could later set — there is no state a master's camera can be
   * put into that is not north up and flat.
   */
  let requestedMode = $state<MapMode>('NAVIGATION');
  const mode = $derived<MapMode>(viewer === 'MASTER' ? 'OVERVIEW' : requestedMode);
  const labels = new Map<string, Marker>();

  /**
   * R-50, held across frames rather than in a rune: this is read and written
   * inside a requestAnimationFrame loop, and routing 60 writes a second through
   * reactivity would cost a re-render per frame to be read back by the same loop.
   */
  const heading = new Heading(0);
  let frameHandle: number | undefined;

  /**
   * Which ground the camera has been framed on, or `''` for none.
   *
   * `fitBounds` runs once per mode change. Repeating it on every snapshot would
   * yank an overview map back to the whole play area every five seconds, which
   * makes it impossible to look closely at anything.
   *
   * A key rather than a flag, because the geometry can now change under a
   * running app: a profile switch lands new zones in the next snapshot, and a
   * flag would keep the camera on the town the master just left. See
   * `framingKey()` for why it is the bounds and not the ring.
   */
  let fittedTo = '';

  /**
   * The pmtiles protocol is registered on the MapLibre module, which is global
   * to the page, and registering it twice throws — so both the protocol and the
   * archives added to it are module-level rather than per component.
   *
   * The archive is handed over explicitly instead of being left to `Protocol`'s
   * own fetching: `WholeArchiveSource` reads the file once and slices it in
   * memory, because the asset server answers a range request with a 200 and
   * pmtiles treats that as fatal (R-52b).
   *
   * **Switching profiles adds a second archive and never drops the first.** The
   * set is what keeps `Protocol.add` from throwing on a URL already registered,
   * and the buffer behind each one stays resident for as long as the page does.
   * Deliberate: a switch is a setup act a master performs once or twice, the
   * ceiling on one archive is 25 MiB (R-52b), and the alternative is unregistering
   * a source the style may still be tearing down.
   */
  let protocol: Protocol | undefined;
  const archives = new Set<string>();

  function archiveUrlFor(url: string): string {
    const absolute = absoluteArchiveUrl(url, window.location.origin);
    protocol ??= (() => {
      const created = new Protocol();
      addProtocol('pmtiles', created.tile);
      return created;
    })();
    if (!archives.has(absolute)) {
      protocol.add(new PMTiles(new WholeArchiveSource(absolute)));
      archives.add(absolute);
    }
    return absolute;
  }

  /**
   * The style as it should be right now, palette included.
   *
   * A function rather than a `$derived`, because it is read once at
   * construction and once per palette change — and a rune here would make the
   * map's *creation* depend on the display mode, which is a re-run of `onMount`
   * waiting to happen.
   */
  function styleNow() {
    return buildStyle(
      {
        pmtilesUrl: basemap.pmtilesUrl ? archiveUrlFor(basemap.pmtilesUrl) : '',
        // R-69, per location: the town is read by street name and the venue by
        // zone name, so the label layer comes and goes with the geometry.
        // Coerced rather than passed through because `exactOptionalPropertyTypes`
        // separates absent from `undefined`, and both mean off here.
        streetNames: basemap.streetNames ?? false,
      },
      { daylight: display.daylight, authoritative: authoritative ?? false },
    );
  }

  onMount(() => {
    // Before the map, not after: MapLibre reads the worker URL out of module
    // config when it spins the pool up (see map-worker.ts — without this the built
    // bundle asks for a worker nothing emitted and gets index.html back).
    useBundledMapWorker();
    const interactions = interactionsFor(viewer);
    const instance = new MapLibreMap({
      container,
      style: styleNow() as unknown as StyleSpecification,
      // R-47: the ingest area, which is the larger of the two boxes and the one
      // the archive was cut to (§14.2). Bounding to the perimeter would make the
      // streets around the venue unpannable, and a player walking out of it
      // would slide off their own map.
      maxBounds: new LngLatBounds(...boundsOfBbox(basemap.bbox)),
      // The floor of last resort. The real one is derived — see syncMinZoom().
      minZoom: MIN_ZOOM,
      maxZoom: basemap.maxZoom,
      // R-49, on the gestures as well as on the camera: cameraFor() cannot
      // return a rotated master map, but a two-finger twist would rotate one
      // anyway and nothing would put it back.
      dragRotate: interactions.rotate,
      pitchWithRotate: interactions.pitch,
      touchZoomRotate: true,
      /**
       * No snap to north. MapLibre pulls the bearing to 0 at the end of a
       * rotate gesture that finished within 7° of it, and it does that with an
       * `easeTo` — which the navigation loop's next `jumpTo` cancels, because
       * `jumpTo` calls `stop()`. The result is a snap that starts and is then
       * abandoned wherever it got to.
       *
       * A player who turns the map to within 7° of north has turned it there.
       * The one thing that puts it back is the mode toggle, which is R-48's own
       * way back to the default camera.
       */
      bearingSnap: 0,
      // §14.5 and §9. MapLibre's own attribution control is a modern UI overlay
      // inside the phosphor area, which is the one thing the art direction rules
      // out — so the credit moves to the case bezel, where it is silkscreened
      // beside the model plate and visible on **every** screen rather than only
      // where a map happens to be. ODbL asks for visible credit, not for credit
      // in a particular widget.
      attributionControl: false,
    });
    if (!interactions.rotate) instance.touchZoomRotate.disableRotation();
    // `ScaleControl` is an IControl, and `onAdd()` returns its element — which
    // is all `addControl()` does with it before dropping it into one of the
    // four corner stacks. Mounting it by hand skips the corner and lands it in
    // the chrome column, where it cannot end up under the HUD.
    const scale = new ScaleControl({ unit: 'metric', maxWidth: 90 });
    scaleHost.append(scale.onAdd(instance));
    /**
     * Which camera changes were the player's, and which were ours.
     *
     * **`originalEvent` is the whole test.** MapLibre's handlers fire
     * `zoomstart`, `rotatestart` and `pitchstart` carrying the DOM event that
     * caused them; the camera API fires the same events with nothing attached,
     * and the navigation loop's `jumpTo` goes through the camera API sixty
     * times a second. Comparing numbers instead — "the zoom is not where we put
     * it" — would be a race with our own writes.
     */
    const takeOver = (axis: keyof typeof held) => (event: { originalEvent?: unknown }) => {
      if (!event.originalEvent) return;
      held[axis] = true;
    };
    /* The gesture's own duration, which `takeOver` above does not measure: that
       one records who owns an axis afterwards. See `pointers`. */
    const release = (event: PointerEvent): void => {
      pointers.delete(event.pointerId);
    };
    instance
      .getCanvasContainer()
      .addEventListener('pointerdown', (event) => pointers.add(event.pointerId));
    /**
     * Down on the map, up **anywhere**.
     *
     * A touch is implicitly captured to the element that received `pointerdown`,
     * so on a handset the release would come back to the canvas either way. A
     * mouse is not: press on the map, drag onto the bar and let go, and the
     * `pointerup` belongs to whatever is under the cursor. Listening on the
     * canvas alone, that pointer would stay in the set and the camera would
     * never follow anything again for the rest of the session — a worse bug
     * than the one this fixes, and a rarer one to reproduce.
     */
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);

    instance.on('dragstart', takeOver('centre'));
    instance.on('zoomstart', takeOver('zoom'));
    instance.on('rotatestart', takeOver('bearing'));
    instance.on('pitchstart', takeOver('pitch'));

    // The viewport's shape decides the floor, so a rotation of the phone or a
    // panel opening under the map changes it.
    instance.on('resize', () => syncMinZoom());

    /**
     * Two ways the container changes size without the window doing anything,
     * and MapLibre's own `trackResize` catches neither reliably.
     *
     * **The fonts arrive after the map does.** The bar's height is set by text
     * in `Barlow Condensed`, which is self-hosted (R-52) and therefore swaps in
     * after first paint — so the bar grows a few pixels, the stage above it
     * shrinks by the same, and a canvas sized before the swap is left standing
     * in a container that is no longer its size. That is the strip of empty
     * screen under the map with DOM markers still drawing into it: the markers
     * are placed from the map's transform and the transform was never told.
     *
     * **The bar rewraps.** It is a flex row whose contents change — R-57's
     * replay button appears with `AUTHORITATIVE` and goes with it — so the
     * stage's height moves during a session, not only at load.
     *
     * MapLibre does observe its container, but it deliberately drops the first
     * observation and throttles the rest by 50 ms; a resize that lands in
     * either gap leaves the canvas stale for good, because nothing asks again.
     */
    void document.fonts?.ready.then(() => instance.resize());
    const resizes = new ResizeObserver(() => instance.resize());
    resizes.observe(container);

    if (onSelect) {
      // Whether the pointer is over something that answers a press. Cheap for
      // the handful of features this layer ever holds, and it is the only way
      // to know — a dot is rendered geometry, not an element with a `:hover`.
      const track = (event: { point: { x: number; y: number } }): void => {
        // The layer has to exist before it can be queried, and the pointer moves
        // long before the style loads: MapLibre answers a query for an absent
        // layer by **throwing**, which lands in the `error` handler and puts
        // "the layer 'position-dots' does not exist" in the red box meant for
        // real cartography faults.
        if (!instance.getLayer(DOT_LAYER)) return;
        hovering =
          instance.queryRenderedFeatures(event.point as never, { layers: [DOT_LAYER] }).length > 0;
      };
      instance.on('mousemove', track);
      instance.on('mouseout', () => (hovering = false));
    }

    if (onPick || onSelect) {
      instance.on('click', (event) => {
        /**
         * Armed, the coordinate wins outright.
         *
         * `onPick` is supplied only while the master has armed the tool, so its
         * presence *is* the mode — and in that mode a tap means "this spot" and
         * nothing else. A dot winning here would be the tool refusing to work
         * over the part of the map with people on it, which is most of the part
         * anybody is pointing at.
         *
         * Unarmed, a dot still wins: selecting somebody and clearing a
         * selection are both a click on open ground, and the person is what the
         * tap was about.
         */
        if (onPick) {
          onPick(event.lngLat.lng, event.lngLat.lat);
          return;
        }
        const hits =
          onSelect && instance.getLayer(DOT_LAYER)
            ? instance.queryRenderedFeatures(event.point, { layers: [DOT_LAYER] })
            : [];
        const key = hits[0]?.properties?.['key'];
        if (onSelect && typeof key === 'string') {
          onSelect(key);
          return;
        }
        // A tap on empty ground clears both cards: the panel decides which of
        // those it cares about, and a master should not have to dismiss one
        // before reading the other.
        onSelect?.(null);
        onPoi?.(null);
      });
    }

    // Before `load`, so a failure that stops the style loading is still caught.
    instance.on('error', (event) => {
      const error = event.error as Error | undefined;
      mapError = error?.message ?? 'unknown map error';
      console.error('[map]', error);
    });

    instance.on('load', () => {
      styleReady = true;
      map = instance;
    });

    return () => {
      if (frameHandle !== undefined) cancelAnimationFrame(frameHandle);
      if (glideHandle !== undefined) cancelAnimationFrame(glideHandle);
      resizes.disconnect();
      // Detaches its own `move` listener. `instance.remove()` would take the
      // element with it either way, but the listener outlives the element.
      scale.onRemove();
      for (const label of labels.values()) label.remove();
      labels.clear();
      clearTimeout(foundTimer);
      // The canvas goes with `instance.remove()` and its listener with it; these
      // two are on `window` and outlive the map. See `pointers`.
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      pointers.clear();
      instance.remove();
      map = null;
    };
  });

  /**
   * Every input to `styleNow()`, as one key.
   *
   * One key and not three guards. A profile switch changes the archive, and a
   * master switching profiles while R-24's mode or the sun mode changes in the
   * same tick would repaint twice — and the second `setStyle` throws away the
   * first one's data push before its `styledata` has fired, which leaves the
   * venue blank until the next snapshot.
   */
  function styleKey(): string {
    // `streetNames` is folded in rather than assumed to follow the archive: it
    // is derived from the same profile today, but a master may point
    // `pmtilesUrl` at object storage (§14.6) and the two would stop moving
    // together. A key that missed it would leave the old labels on a new map.
    return `${display.daylight}/${authoritative ?? false}/${basemap.pmtilesUrl}/${basemap.streetNames ?? false}`;
  }
  /**
   * Repaint when the style's inputs change — the two palettes, and the archive.
   *
   * `setStyle` rather than a pile of `setPaintProperty` calls: the palette is a
   * substitution over the whole style and the diff MapLibre computes from two
   * styles with identical ids is exactly the set of paint changes we want. The
   * archive is the same operation for a different reason: `buildStyle()` either
   * patches `pmtiles://<url>` into the basemap source or **removes** that source
   * and every layer drawn from it, and neither is reachable by setting a
   * property.
   *
   * **The data has to be pushed back afterwards.** The style carries its
   * GeoJSON sources with `features: []` — they are filled by `setData` from the
   * projection — so the diff sees "same source, different data" and resets them
   * to empty. Nothing would be on the map until the next snapshot arrived,
   * which for a player standing still is five seconds of a blank venue.
   * `styledata` is the event that says the new style is in place.
   *
   * Guarded on a first run: an effect that re-styled the map the frame it was
   * created would throw away the style it was built with.
   */
  // `untrack` because capturing the value the map was *built* with is exactly
  // the point: the guard exists so the first run of the effect does not restyle
  // a map that already has this style.
  let painted = untrack(styleKey);
  $effect(() => {
    const wanted = styleKey();
    const instance = map;
    if (!instance || wanted === painted) return;
    painted = wanted;
    instance.setStyle(styleNow() as unknown as StyleSpecification);
    instance.once('styledata', () => {
      pushGameData(instance);
      pushPositions(instance);
    });
  });

  /**
   * R-47's box, after the map has been built.
   *
   * `maxBounds` and `maxZoom` are constructor arguments, and everything that
   * writes them writes them once — which was true of the whole basemap until a
   * geometry that can change under a running app made it false. The bbox is
   * derived from the geometry by `basemapBbox()`, so a profile switch moves the
   * box to another town while the camera is still bounded to this one: the
   * player can see the new zones and cannot pan to them.
   *
   * Its own effect rather than the repaint above, because neither of these is
   * the style. Restyling to move a boundary would throw the tiles away and
   * refetch every one of them to end up with the same picture in a different
   * box.
   *
   * **Created before the fit effect on purpose.** Both run in the flush that
   * carries a profile switch, effects run in creation order, and the fit has to
   * find the new bounds already in place — an ease to ground outside the old
   * box would be clamped on the way.
   */
  let bounded = untrack(() => `${basemap.bbox.join(',')}/${basemap.maxZoom}`);
  $effect(() => {
    const wanted = `${basemap.bbox.join(',')}/${basemap.maxZoom}`;
    const instance = map;
    if (!instance || wanted === bounded) return;
    bounded = wanted;
    instance.setMaxBounds(new LngLatBounds(...boundsOfBbox(basemap.bbox)));
    instance.setMaxZoom(basemap.maxZoom);
    // The floor is the zoom at which the perimeter fills the viewport, clamped
    // by the archive's ceiling — so it moves when the ceiling does.
    syncMinZoom();
    /**
     * And the camera goes back to the play area.
     *
     * A box that moved has usually taken the geometry with it, and the fit is
     * keyed on the geometry, so most of the time this is already going to
     * happen. It is here for the case where it is not: `POST
     * /api/master/game/basemap` points at a different archive over the same
     * ground, and MapLibre clamps the centre into the new box the moment it is
     * set — which can leave a master looking at the edge of it.
     */
    fittedTo = '';
  });

  function pushGameData(instance: MapLibreMap): void {
    if (!frame) return;
    (instance.getSource(GAME_SOURCE) as GeoJSONSource | undefined)?.setData(
      gameGeoJson(frame, self && course ? { from: self, to: course } : undefined, {
        highlight: new Set(highlightZoneIds ?? []),
        closed: new Set(closedZoneIds ?? []),
      }) as never,
    );
  }

  function pushPositions(instance: MapLibreMap): void {
    /**
     * The mark is the selection ring — `position-selected` in `style.json` —
     * and not a second drawing that means the same thing.
     *
     * That ring is already what *this dot, the one you asked about* looks like
     * on both screens: the master picking a callsign out of the roster, a
     * player tapping a teammate. A recentre asks the same question about
     * yourself, so it gets the same answer, and the player has to learn one
     * mark rather than one per place it is used.
     *
     * It borrows the selection for as long as the mark lasts and hands it back
     * — a teammate the player had selected is lit again when it ends, because
     * `selected` is still the prop and nothing here writes it.
     */
    const mark = found ? shown.find((dot) => dot.kind === 'SELF')?.key : undefined;
    (instance.getSource(POSITIONS_SOURCE) as GeoJSONSource | undefined)?.setData(
      positionsGeoJson(shown, mark ?? selected) as never,
    );
  }

  /** R-51's features, from the projection and never from the file. */
  $effect(() => {
    const instance = map;
    if (!instance || !frame) return;
    pushGameData(instance);
  });

  $effect(() => {
    const instance = map;
    if (!instance) return;
    pushPositions(instance);
  });

  /**
   * Callsigns and marker labels as DOM, outside the style (§14.3). Reused per
   * key rather than recreated: a marker torn down and rebuilt every five seconds
   * flickers, and there are only ever a handful of them.
   */
  $effect(() => {
    const instance = map;
    if (!instance) return;
    const wanted = new Map<string, WantedLabel>();
    for (const dot of shown) {
      wanted.set(`dot:${dot.key}`, {
        lon: dot.lon,
        lat: dot.lat,
        text: dot.label,
        kind: dot.unlocatable ? 'unlocatable' : dot.kind.toLowerCase(),
      });
      /**
       * R-22's elimination mark, and it is a marker rather than a layer for one
       * reason: **a glyph has to hold its size on screen.** Geometry drawn in
       * metres grows as the master zooms out, which is exactly right for R-12's
       * uncertainty circle — that one is a claim in metres — and exactly wrong
       * for a state marker, which has to stay the size of the dots it replaces.
       * §14.3 leaves the style with no symbol layer to put a character in, so
       * this is the same DOM mechanism the callsigns already use.
       *
       * `positionsGeoJson()` emits nothing for these, so the cross replaces the
       * dot rather than sitting on top of one: two marks on one position read
       * as two people.
       *
       * **Which is why it carries `select`.** The map's own click handler reads
       * `queryRenderedFeatures` on the dot layer, and this player has no feature
       * in it — so a press on the cross found nothing, fell through to the
       * canvas and was taken for a press on open ground, which *clears* the
       * selection. Not a dot that ignores you: a dot that closes the card you
       * opened from the roster. The cross is this player's dot, so it answers
       * the press the dots do, and takes the ring with it.
       */
      if (dot.eliminated) {
        wanted.set(`out:${dot.key}`, {
          lon: dot.lon,
          lat: dot.lat,
          text: GLYPHS.ELIMINATED,
          kind: 'eliminated',
          mark: true,
          select: dot.key,
          on: dot.key === selected,
        });
      }
    }
    /**
     * The POIs and the markers, as diamonds.
     *
     * Both were `circle` layers, which is the one shape MapLibre draws — so a
     * fixed POI read as a dimmer, smaller player, and at a glance over a map of
     * amber roads that is no distinction at all. A diamond is a different
     * *shape*, which survives the scanlines, a colour-blind reader and a phone
     * held at arm's length, and it is the mark the vector schematic has always
     * used for a marker.
     *
     * Here rather than in the style for the same reason R-22's cross is: a
     * shape that stands for a place has to hold its size on screen. Geometry in
     * metres would swell as the master zooms out, and §14.3 leaves this style
     * with no symbol layer to put an icon in.
     */
    /**
     * The player's own sweep: a ring leaving their position every few seconds.
     *
     * A marker rather than an overlay, because it has to be *at* the dot and
     * MapLibre is the only thing that knows where that is on screen. It is the
     * one piece of effect layer that is not on the glass — which is the point:
     * §9's machine is looking for them, and the search starts where they are.
     *
     * Player only. A master watches six of these at once, and six expanding
     * rings over a venue is weather rather than information — their tube gets
     * the refresh sweep instead.
     *
     * Screen-sized rather than metre-sized, deliberately: it is decoration, and
     * a ring in metres beside R-12's uncertainty circle — which *is* a claim in
     * metres — would be a second circle around the same dot saying something
     * that is not true.
     *
     * **On the map's plane rather than on the glass** (`flat`). R-48 pitches the
     * camera, and a ring that stayed square to the viewport read as a disc held
     * up in front of the map rather than as something happening on the ground —
     * the one place it is not allowed to look, since the whole idea is that the
     * machine is sweeping the ground the player is standing on. Tilting it costs
     * nothing: it is a circle, so it has no upright to lose, which is exactly
     * what the glyphs beside it do have.
     */
    if (viewer === 'PLAYER' && self) {
      wanted.set('ping', {
        lon: self.lon,
        lat: self.lat,
        text: '',
        kind: 'ping',
        shape: true,
        flat: true,
      });
    }
    for (const poi of frame?.pois ?? []) {
      wanted.set(`poi:${poi.id}`, {
        lon: poi.lon,
        lat: poi.lat,
        text: '',
        kind: 'poi',
        shape: true,
        poi: poi.id,
        category: poi.category,
        on: selectedPoi === poi.id || highlightPoi === poi.id,
      });
    }
    for (const marker of frame?.markers ?? []) {
      /**
       * Both halves answer the tap, and the label is the half that matters: the
       * diamond is about fifteen pixels and the label beside it is the width of
       * a name, which on a phone at a run is the difference between a target
       * and a dare. They are two elements because a mark sits *on* a position
       * and a label sits beside one, so they cannot be anchored the same way.
       */
      wanted.set(`marker-shape:${marker.id}`, {
        lon: marker.lon,
        lat: marker.lat,
        text: '',
        kind: 'marker',
        shape: true,
        marker: marker.id,
        on: selectedMarker === marker.id,
      });
      wanted.set(`marker:${marker.id}`, {
        lon: marker.lon,
        lat: marker.lat,
        text: marker.label,
        kind: 'marker',
        marker: marker.id,
        on: selectedMarker === marker.id,
      });
    }
    /**
     * R-31. Where a player was when they declared, which is a **place** and not
     * a person: drawn dim and with the callsign, so it cannot be mistaken for
     * somebody standing there. A record with no drop point is a player who had
     * no fix at the time (M6) and contributes nothing here.
     */
    for (const drop of frame?.dropPoints ?? []) {
      wanted.set(`drop:${drop.id}`, {
        lon: drop.lon,
        lat: drop.lat,
        text: GLYPHS.ELIMINATED,
        kind: 'drop',
        mark: true,
      });
      wanted.set(`drop-label:${drop.id}`, {
        lon: drop.lon,
        lat: drop.lat,
        text: drop.label,
        kind: 'drop',
      });
    }

    for (const [key, label] of labels) {
      if (!wanted.has(key)) {
        label.remove();
        labels.delete(key);
      }
    }
    for (const [key, want] of wanted) {
      let label = labels.get(key);
      if (!label) {
        const element = document.createElement('span');
        // A mark sits *on* the position and a label sits beside it, so they are
        // anchored differently and cannot be the same element.
        element.className = want.shape ? 'map-shape' : want.mark ? 'map-mark' : 'map-label';
        // The diamond is a rotated square, and the rotation cannot go on this
        // element: MapLibre writes `transform` on it every frame to place it,
        // and would overwrite the rotation with a translation. So the shape is
        // an inner box that MapLibre never touches.
        if (want.shape) element.append(document.createElement('i'));
        /**
         * A POI answers a tap, and the handler goes on the element rather than
         * through `queryRenderedFeatures`: a DOM marker is not a rendered
         * feature, so the map's own click handler cannot see it. It also never
         * fires — a press on a marker never reaches the canvas — which is what
         * stops a master picking a drop point on top of a point they meant to
         * read.
         */
        if (want.poi && onPoi) {
          const id = want.poi;
          element.addEventListener('click', (event) => {
            event.stopPropagation();
            onPoi(id);
          });
        }
        /* R-22's cross, selecting the player it stands for. Same mechanism and
           the same reason as the two above — a DOM marker is not a rendered
           feature — except that here the press has nowhere else it could have
           gone: for everybody still playing the dot layer answers it. */
        if (want.select && onSelect) {
          const id = want.select;
          element.addEventListener('click', (event) => {
            event.stopPropagation();
            onSelect(id);
          });
          element.dataset.tap = '';
        }
        /* Same mechanism and the same reason it cannot go through the map's own
           click handler: a DOM marker is not a rendered feature. */
        if (want.marker && onMarker) {
          const id = want.marker;
          element.addEventListener('click', (event) => {
            event.stopPropagation();
            onMarker(id);
          });
          /* The CSS below takes back the pointer events the map gives up, and it
             may only do that where a listener was actually attached. On the
             master's map `onMarker` is absent: without this flag every marker
             would swallow a click that currently reaches the canvas and closes
             an open card, and it would do it under a pointer cursor promising
             something that does not happen. */
          element.dataset.tap = '';
        }
        const options: MarkerOptions =
          want.mark || want.shape
            ? { element, anchor: 'center' }
            : { element, anchor: 'left', offset: [10, 0] };
        // The sweep lies on the ground rather than on the glass; everything
        // else here is a glyph and has to face the reader. See `flat`.
        if (want.flat) options.pitchAlignment = 'map';
        label = new Marker(options).setLngLat([want.lon, want.lat]);
        label.addTo(instance);
        labels.set(key, label);
      }
      label.setLngLat([want.lon, want.lat]);
      const element = label.getElement();
      // Never on a shape: the text is empty and writing it would take the inner
      // box out with it.
      if (!want.shape) element.textContent = want.text;
      element.dataset.kind = want.kind;
      if (want.category) element.dataset.category = want.category;
      if (want.on) element.dataset.on = '';
      else delete element.dataset.on;
    }
  });

  interface WantedLabel {
    lon: number;
    lat: number;
    text: string;
    kind: string;
    /** Centred on the position rather than offset beside it. */
    mark?: boolean;
    /** Drawn rather than lettered: a rotated box, with no text of its own. */
    shape?: boolean;
    /** Set on a POI, which answers a tap. */
    poi?: string;
    /** Set on a master's marker, which answers one too (R-20b). */
    marker?: string;
    /**
     * Set on R-22's cross, which is the only dot that is a marker — so it is the
     * only dot whose press cannot arrive through the layer the others use.
     */
    select?: string;
    /** R-16's category, for the one of them that gets its own mark. */
    category?: string;
    /** Whether this is the selection whose card is open. */
    on?: boolean;
    /**
     * Drawn on the map's plane rather than on the viewport's: MapLibre tilts
     * the element by the camera's pitch, so a circle reads as a circle lying on
     * the ground instead of a disc held up in front of it.
     *
     * The sweep is the only thing here that wants it. Every other marker is a
     * glyph — a diamond, a cross, a callsign — and a glyph that tilts with the
     * camera is a glyph you cannot read; that is the same reason they are DOM
     * markers rather than geometry in the first place.
     *
     * Bearing is deliberately left alone. `rotationAlignment: 'map'` would turn
     * the element with the map, and a circle has nothing to turn: the only
     * effect would be to make `pitchAlignment` default off if this is ever
     * reordered.
     */
    flat?: boolean;
  }

  /**
   * The dots as drawn, which is not always the dots as reported.
   *
   * A phone reports every five to ten seconds, so a walking player's dot moves
   * in seven-metre steps and reads as a stutter. `Glide` slides it instead, for
   * about two thirds of a second after each fix — see `glide.ts` for what that
   * is allowed to touch, and the longer list of what it is not.
   *
   * The labels read this too. A callsign that kept the reported position while
   * its dot slid would detach from the thing it names.
   */
  const glide = new Glide();
  let shown = $state<Dot[]>([]);
  let glideHandle: number | undefined;
  let glideAt = 0;

  $effect(() => {
    // Adopt new keys and drop gone ones at once, so a dot appears where it is
    // rather than a frame later; then let the loop cover the distance.
    shown = glide.step(dots, 0);
    startGliding();
  });

  function startGliding(): void {
    if (glideHandle !== undefined) return;
    glideAt = performance.now();
    const tick = (at: number): void => {
      glideHandle = undefined;
      const elapsed = at - glideAt;
      glideAt = at;
      shown = glide.step(dots, elapsed);
      // Stops the moment every dot has arrived. This runs on a phone in a
      // pocket for four hours; a loop that never sleeps is a battery.
      if (!glide.settled) glideHandle = requestAnimationFrame(tick);
    };
    glideHandle = requestAnimationFrame(tick);
  }

  /**
   * The axes the player has taken over by hand.
   *
   * R-48's navigation camera is a **default, not a lock**. The gestures were
   * always allowed — `interactionsFor()` gives a player rotate and pitch, and
   * pinch zoom is on for everybody — but the loop below rewrote all three every
   * frame, so a player could turn or zoom the map and watch it undo itself at
   * the next fix. A control that reverts on a timer is worse than no control:
   * it reads as the app fighting you.
   *
   * So each axis is the camera's until the player touches it, and theirs
   * afterwards. Not the centre: following the player *is* the mode (R-48), and
   * a pan is how you look at something without leaving it.
   *
   * The way back is the mode toggle, which is R-48's own way back to the
   * default camera and already resets the heading filter. Nothing else clears
   * these, and in particular a new fix does not — a camera that reclaimed the
   * zoom five seconds later would be the original problem with a delay on it.
   *
   * A plain object rather than a rune, for the same reason `Heading` is one:
   * this is read inside a `requestAnimationFrame` loop driving an imperative
   * camera (§15.4), and nothing renders from it.
   */
  const held = { centre: false, zoom: false, bearing: false, pitch: false };

  /**
   * How many fingers are on the map, and the reason the loop has to care.
   *
   * **`jumpTo` cancels the gesture in progress.** Not a side effect worth
   * knowing about — the whole of it, in `maplibre-gl` 6.6:
   *
   *     jumpTo(options)  ->  this.stop()              // no argument
   *                      ->  _stop(allowGestures)     // undefined, so falsy
   *                      ->  this._stopHandlers()
   *                      ->  handlers.stop(false)
   *                      ->  for (const { handler } of this._handlers)
   *                            handler.reset()        // the drag is now dead
   *
   * The loop writes the camera sixty times a second, so a drag survives about
   * one frame. The player lifts, presses again, gets another frame, and pans a
   * four-hour game in sixteen-millisecond nudges.
   *
   * It is invisible on a desktop browser and that is not luck: with nothing
   * feeding the map, every axis arrives, `settled` goes true and the loop stops
   * scheduling itself, so there is no `jumpTo` left to cancel anything. On a
   * handset with a real feed, each fix wakes it and `Glide` keeps it awake
   * across the slide — which is the cadence of the nudges. Overview never had
   * it either, for the same reason: `tick` returns on its first frame there.
   *
   * `held` cannot fix this. It is about **ownership** — which axis the loop may
   * still write once the gesture is over — and this is about the *duration* of
   * the gesture, during which the loop may not touch the camera at all. Leaving
   * every axis out still calls `jumpTo`, and `jumpTo` is what resets the
   * handlers.
   *
   * Pointer events rather than `dragPan.isActive()`, which is public and would
   * read better. A touch handler becomes active on the first `touchmove`, so
   * between the press and the first movement it is not active yet and a frame
   * landing in that window resets the touch the gesture was about to be made
   * of. A pointer is down from the press.
   *
   * There is no way for this to strand the camera: a pointer that goes down
   * raises `pointerup` or `pointercancel`, and a set keyed by `pointerId`
   * cannot drift the way a counter can.
   */
  const pointers = new Set<number>();

  /**
   * How long the player's own dot wears the selection ring after they ask to be
   * found.
   *
   * Long enough to find on a screen held at a run, short enough that it is over
   * before it becomes the map's normal state — the ring means *this one* and a
   * ring that never goes out means nothing.
   */
  const FOUND_MS = 2000;

  /** Whether that mark is currently on. Read by the label effect. */
  let found = $state(false);
  let foundTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Say where you are, briefly.
   *
   * The centre moving is not an answer on its own: in overview the camera may
   * be over a venue that is already entirely on screen, where `maxBounds`
   * clamps the pan to almost nothing and the map appears not to have responded
   * at all. The dot is what was asked about, so the dot is what replies — see
   * `pushPositions()` for which drawing does it and why it is not a new one.
   */
  function markSelf(): void {
    found = true;
    clearTimeout(foundTimer);
    foundTimer = setTimeout(() => {
      found = false;
    }, FOUND_MS);
  }

  /**
   * Whether the centre is still **catching up** with what it is aiming at.
   *
   * The dot is already smoothed. `Glide` slides it across each seven-metre fix
   * step over about two thirds of a second, and the camera follows the drawn
   * dot rather than the raw fix — so putting the centre through a second
   * low-pass on top of that is two filters in series, and the second one's only
   * contribution is lag. The symptom is the camera trailing a dot that is
   * moving well: it is worst exactly when the dot is moving fastest, which is
   * during a glide, which is most of the time a player is walking.
   *
   * So while it is following, the centre is written to the dot's own position —
   * no filter, no lag, the dot pinned where a navigation camera should pin it.
   *
   * The low-pass is kept for the one case it was actually for: the target
   * jumping somewhere else. A peek starting or ending, a held centre handed
   * back by the recentre button, the mode toggle. Those are events, so this is
   * set by them and cleared when the centre arrives, rather than being a state
   * the camera is permanently in.
   */
  let reacquiring = true;

  /**
   * The position the camera follows, which is **the one the dot is drawn at**.
   *
   * A phone reports every five to ten seconds, so `self` arrives in seven-metre
   * steps; `Glide` slides the dot across each of them and the camera was
   * following the steps instead. Two symptoms, and they look like different
   * bugs: the map twitched under a dot that was moving smoothly, and the
   * course-up bearing recomputed from a position that had just jumped, so the
   * whole view swung once per fix — the rotation looked unsmoothed while the
   * dot beside it plainly was not.
   *
   * Reading the drawn dot rather than the payload is the fix, and it is the
   * same reasoning as the callsign labels: anything that names or follows the
   * dot has to use the position the dot is at, or it detaches from the thing it
   * is about.
   */
  function followedPosition(): { lat: number; lon: number } | undefined {
    const dot = shown.find((entry) => entry.kind === 'SELF');
    return dot ? { lat: dot.lat, lon: dot.lon } : self;
  }

  /** R-50.1: a new fix either moves the target bearing or fails to. */
  $effect(() => {
    heading.update(self, config);
    startAnimating();
  });

  /**
   * A peek or a new course has to wake the loop.
   *
   * It stops the moment every axis has arrived — a phone in a pocket for four
   * hours cannot afford a loop that never sleeps — so anything that moves a
   * target between snapshots has to start it again, or the camera simply never
   * goes.
   */
  $effect(() => {
    void peek;
    void course;
    // Either of them is a discontinuous change of what the camera is aiming at,
    // which is the one case the centre is smoothed for. See `reacquiring`.
    reacquiring = true;
    startAnimating();
  });

  /**
   * The same peek, for the camera the loop does not own.
   *
   * `startAnimating()` returns on the first frame in overview — that mode is one
   * transition, not a loop — so a player who pressed *show me this on the map*
   * from the overview got nothing at all. The fit has already run and marked
   * itself done, so there was no second writer either: the map simply sat there.
   *
   * An `easeTo` is safe here for the same reason it is safe on a master's
   * screen: no loop is writing the camera per frame, so there is no transition
   * to be cancelled on the first one.
   *
   * It does not come back. In navigation the peek ends and the loop resumes
   * following the player, which is where the camera belongs; overview has no
   * follow target, and the framing the player left was one they panned and
   * zoomed by hand. Undoing that would be the map arguing with them.
   */
  $effect(() => {
    const target = peek;
    const instance = map;
    if (!target || !instance) return;
    if (mode === 'NAVIGATION' && viewer === 'PLAYER') return;
    instance.easeTo({
      center: [target.lon, target.lat],
      zoom: Math.max(instance.getZoom(), FOCUS_ZOOM),
      duration: 600,
    });
  });

  /**
   * **One loop owns the navigation camera** — centre, zoom, pitch and bearing
   * together — and this is not tidiness, it is the only arrangement that works.
   *
   * MapLibre cancels an in-flight `easeTo` on any other camera change, and
   * `setBearing()` is one. So a per-frame bearing filter and an eased centre
   * cannot coexist: the first frame of the filter killed the ease, which is why
   * returning from overview used to leave the map flat and zoomed out while the
   * bearing still tracked. It looked like the zoom was never asked for; it was
   * asked for and then cancelled, sixteen milliseconds later.
   *
   * So there is no easing machinery here at all. Every frame low-passes each
   * axis toward its target and writes the whole camera once with `jumpTo`,
   * which starts no animation and therefore has nothing to cancel. R-50's
   * bearing rules are unchanged and still live in `Heading`; the other three
   * axes borrow the same smoothing so the camera moves as one thing rather than
   * four things arriving separately.
   *
   * §15.4 called this frame-level work and said a reactive wrapper would fight
   * it. So does an animation API.
   */
  function startAnimating(): void {
    if (frameHandle !== undefined) return;
    const tick = (): void => {
      frameHandle = undefined;
      const instance = map;
      if (!instance) return;
      // Overview and every master map are a single transition, not a loop.
      if (viewer === 'MASTER' || mode !== 'NAVIGATION') return;

      /**
       * Hands off while the player's hand is on it.
       *
       * `jumpTo` resets MapLibre's handlers — see `pointers` for the call chain
       * — so a frame written under a finger ends the drag. The loop keeps
       * scheduling itself and writes nothing, which is what makes this a pause
       * rather than a stop: the frame after the last pointer lifts carries on
       * from wherever the player left the camera, with `held` now recording
       * what they took.
       *
       * `isMoving()` for the same reason one step later. Letting go of a flick
       * hands the map to MapLibre's own inertia, which is an `easeTo`, and the
       * first `jumpTo` after the finger lifts would stop it dead. It is safe to
       * ask between frames because a `jumpTo` fires `movestart` through
       * `moveend` **synchronously**, inside the call — so it is never still
       * moving on our account by the time the next frame looks. Nothing else
       * eases here: a peek is the loop's own smoothing in this mode, which is
       * the note on `centreOn` below.
       */
      if (pointers.size > 0 || instance.isMoving()) {
        frameHandle = requestAnimationFrame(tick);
        return;
      }

      const alpha = Math.min(1, Math.max(0, config.bearingSmoothing));
      const followed = followedPosition();
      /**
       * Course up, when there is a course.
       *
       * R-48 says the bearing follows the heading and there is no heading to
       * follow: the measured phone sends no `bearing`, so R-50's filter is fed
       * nothing and the map holds north. A destination is a direction that is
       * both known and wanted, and `Heading` puts it through the same low-pass
       * — see the note on `course` there for why this cannot be mistaken for a
       * heading claim.
       */
      heading.course = followed && course ? bearingTo(followed, course) : undefined;
      /**
       * A peek moves the centre and nothing else.
       *
       * It is the same target the follow uses, so getting there and coming back
       * are the loop's own smoothing rather than a transition — which is the
       * whole reason it can exist at all next to a camera written with `jumpTo`
       * sixty times a second.
       */
      const centreOn = peek ?? followed;
      const target = cameraFor(viewer, mode, {
        ...(centreOn === undefined
          ? {}
          : { position: { lat: centreOn.lat, lon: centreOn.lon } }),
      });

      // Stepped only while the camera owns it. Calling it under a held bearing
      // would advance R-50's filter against a camera it is not writing, so the
      // frame the player handed it back would start from a turn that happened
      // off screen.
      const bearing = held.bearing ? instance.getBearing() : heading.step(alpha);
      const centre = instance.getCenter();
      // No fix to follow: hold position rather than drifting to a default. A map
      // that slides to the middle of the venue every time GPS drops indoors is
      // worse than one that stays where the player last was.
      const toLon = target.center?.[0] ?? centre.lng;
      const toLat = target.center?.[1] ?? centre.lat;
      // A peek overrides a held centre, and only for as long as it lasts: the
      // player asked to be shown a place, which is a different request from
      // "stop following me".
      const following = peek !== undefined || !held.centre;
      // Smoothed only while catching up; on the dot exactly once it is there.
      // `Glide` is the smoothing, and it has already run.
      const dLon = toLon - centre.lng;
      const dLat = toLat - centre.lat;
      if (reacquiring && Math.abs(dLon) < 1e-7 && Math.abs(dLat) < 1e-7) reacquiring = false;
      const trailing = following && reacquiring;
      const lon = following ? (trailing ? centre.lng + dLon * alpha : toLon) : centre.lng;
      const lat = following ? (trailing ? centre.lat + dLat * alpha : toLat) : centre.lat;
      const zoom = instance.getZoom() + ((target.zoom ?? instance.getZoom()) - instance.getZoom()) * alpha;
      const pitch = instance.getPitch() + (target.pitch - instance.getPitch()) * alpha;

      // A held axis is left out of the write rather than written with its
      // current value: `jumpTo` leaves out what it is not given, and a value
      // read back and written again is a frame of rounding per frame.
      instance.jumpTo({
        // Left out under a held centre for the reason the other three are: the
        // value written would be the one just read back, which is a frame of
        // rounding per frame on the axis the player is holding.
        ...(following ? { center: [lon, lat] as [number, number] } : {}),
        ...(held.zoom ? {} : { zoom }),
        ...(held.pitch ? {} : { pitch }),
        ...(held.bearing ? {} : { bearing }),
      });

      // Stop when every axis has arrived, or this is a phone that never sleeps
      // — it runs in a pocket for four hours. A new fix or a mode change starts
      // it again. The bearing test goes through bearingDelta: 10° from a target
      // of 350° is 20° of turn left, and subtracting them reads as 340.
      // A held axis is settled by definition. Testing it against a target the
      // loop is deliberately not chasing would keep the loop awake for the rest
      // of the game, which on a phone in a pocket is the battery.
      const settled =
        // The dot is still sliding, so there is still something to follow. This
        // was unreachable while the centre was low-passed — a filter chasing a
        // moving target never arrives — and became load-bearing the moment the
        // centre started being written exactly.
        glide.settled &&
        (held.bearing || Math.abs(bearingDelta(bearing, heading.target)) < 0.05) &&
        (held.zoom || Math.abs(zoom - (target.zoom ?? zoom)) < 0.002) &&
        (held.pitch || Math.abs(pitch - target.pitch) < 0.05) &&
        // ~1 cm, well under any fix's own error.
        (!following || (Math.abs(lon - toLon) < 1e-7 && Math.abs(lat - toLat) < 1e-7));
      if (!settled) frameHandle = requestAnimationFrame(tick);
    };
    frameHandle = requestAnimationFrame(tick);
  }

  function stopAnimating(): void {
    if (frameHandle !== undefined) cancelAnimationFrame(frameHandle);
    frameHandle = undefined;
  }

  /**
   * R-48 and R-49's camera for everything that is not the navigation loop: the
   * player's overview, and every master map.
   *
   * One eased transition rather than a jump. `fitBounds` with `duration: 0` was
   * a hard cut, and it landed on top of a separate 400 ms ease of the pitch —
   * two transitions fighting, which read as a stutter and then a snap.
   */
  $effect(() => {
    const instance = map;
    if (!instance) return;
    if (mode === 'NAVIGATION' && viewer === 'PLAYER') {
      startAnimating();
      return;
    }

    /**
     * R-48 fits "the whole play area", which is **the perimeter, for both**.
     *
     * The master used to get the ingest area instead, so that a stray tracker
     * outside the playable area was in frame. That was asking for a camera that
     * cannot exist: `maxBounds` is the basemap's box, and framing a 2,8 km
     * ingest area on a 16:9 screen needs 4,9 km of width — more than the box —
     * so MapLibre clamped the fit and the play area came out cropped at the one
     * zoom where it must not be.
     *
     * Nothing is lost. The box still contains the whole ingest area
     * (`basemapBbox()` guarantees it), so a stray tracker is one pan away rather
     * than in frame — and the alternative was 36% of every screen spent on a
     * buffer of empty ground around the game.
     */
    const area = frame?.perimeter;
    const bounds = area && area.length > 0 ? boundsOf(area) : undefined;
    const ground = framingKey(bounds);
    if (!bounds || ground === fittedTo) return;

    // Computed rather than animated to, so the flattening and the framing are
    // one movement instead of two.
    const framed = instance.cameraForBounds(new LngLatBounds(...bounds), {
      padding: FIT_PADDING,
    });
    // Undefined for a degenerate box — geometry that has not arrived, or a
    // profile with an empty ring. Flattening without framing is still the right
    // half of R-48, and refusing to mark it fitted lets the next snapshot try.
    if (!framed) {
      instance.easeTo({ pitch: 0, bearing: 0, duration: 600 });
      return;
    }
    instance.easeTo({ ...framed, pitch: 0, bearing: 0, duration: 600 });
    fittedTo = ground;
  });

  /**
   * Taking the camera to a coordinate somebody asked for.
   *
   * An `easeTo` is safe here and would not be on a player's screen: the
   * navigation loop returns early for a master, so nothing is writing the
   * camera per frame and there is no transition to be cancelled on the first
   * one. That collision is why R-48's own camera uses `jumpTo` and no
   * animation API at all.
   *
   * Centre and zoom only. R-49 gives a master one camera — north up and flat —
   * and a focus that tilted or turned it would be a second way into a state
   * nothing puts back.
   *
   * The zoom is raised to a useful level and never lowered: asked from the
   * fully zoomed-out view, a plain centring would put the player in the middle
   * of a picture where everybody already was.
   */
  $effect(() => {
    const target = focus;
    const instance = map;
    if (!target || !instance) return;
    instance.easeTo({
      center: [target.lon, target.lat],
      zoom: Math.max(instance.getZoom(), FOCUS_ZOOM),
      duration: 600,
    });
  });

  /**
   * The zoom floor is **the perimeter, not a number**.
   *
   * `MIN_ZOOM` is 12 and arbitrary, and `maxBounds` does not save it: MapLibre
   * bounds the *centre*, not the content, so at a floor wide enough to show four
   * times the play area the camera can sit anywhere in the box with the game
   * off-screen. Zoom in, pan, zoom back out, and the perimeter is somewhere
   * behind you — pannable, which is the only reason it reads as a nuisance
   * rather than a broken map.
   *
   * So the floor is recomputed as the zoom at which the perimeter exactly fills
   * the viewport. Below that there is nothing to see that is not a buffer, and
   * above it the worst the camera can do is sit a couple of hundred metres off
   * centre — `basemapBbox()` leaves 12% of slack over the fit, and that slack is
   * the whole of the drift that remains.
   *
   * Derived rather than configured because it depends on the viewport's shape:
   * the same geometry needs a different floor on a phone held upright and on a
   * laptop, which is exactly the 16:9-and-9:16 problem one level down.
   */
  function syncMinZoom(): void {
    const instance = map;
    const perimeter = frame?.perimeter;
    if (!instance || !perimeter || perimeter.length === 0) return;
    const bounds = boundsOf(perimeter);
    if (!bounds) return;
    const fit = instance.cameraForBounds(new LngLatBounds(...bounds), { padding: FIT_PADDING });
    // Undefined for a degenerate ring, and for a container the browser has not
    // laid out yet. Leaving the floor alone is correct in both: the next resize
    // or the next snapshot tries again.
    if (!fit || typeof fit.zoom !== 'number' || !Number.isFinite(fit.zoom)) return;
    // Clamped only by the archive's own ceiling: a floor above the ceiling is a
    // map that cannot render at any zoom. Deliberately **not** clamped up to
    // MIN_ZOOM — that constant exists to stop a pinch reaching the Atlantic
    // before a real floor was derived, and applying it here would refuse to show
    // a venue that genuinely needs a wider one.
    const floor = Math.min(fit.zoom, basemap.maxZoom);
    if (Math.abs(instance.getMinZoom() - floor) < 0.01) return;
    instance.setMinZoom(floor);
  }

  /**
   * The cursor says what a press would do **here**, which is not one answer for
   * the whole canvas.
   *
   * It used to be: acting cursor whenever anything was selectable, which for a
   * master is always — so the map claimed every pixel was a control, including
   * the 99% of it that is ground. A cursor that is the same everywhere carries
   * no information at all.
   *
   * Three answers now. Armed, the whole canvas is the tool and the crosshair is
   * honest everywhere. Over a dot, the acting cursor. Everywhere else the
   * inline style is cleared so MapLibre's own `grab`/`grabbing` classes show
   * through — which is the truthful one, because what the map mostly does is
   * pan, and `:active` makes the hand close as it moves.
   *
   * `hovering` is held rather than written straight to the canvas because the
   * armed state has to win without the pointer moving: arming from the window
   * is a click somewhere else, and the cursor must change before the next
   * `mousemove` arrives.
   */
  let hovering = $state(false);

  $effect(() => {
    const instance = map;
    if (!instance) return;
    instance.getCanvas().style.cursor = onPick
      ? 'var(--cursor-cross), crosshair'
      : hovering
        ? 'var(--cursor-hand), pointer'
        : '';
  });

  /** Geometry arriving, or changing under `/api/master/game/geo`, moves the floor. */
  $effect(() => {
    void frame?.perimeter;
    syncMinZoom();
  });

  function toggleMode(): void {
    // Cancelled first: a frame still queued from the old mode would write the
    // camera on top of the transition about to be started, which is the same
    // collision the loop exists to avoid.
    stopAnimating();
    requestedMode = mode === 'NAVIGATION' ? 'OVERVIEW' : 'NAVIGATION';
    // Cleared rather than keyed on the mode: a player who walked away from the
    // overview and came back has the same ground in front of them and still
    // wants it framed, so "already fitted here" must not survive the toggle.
    fittedTo = '';
    // Overview holds the map north up, so there is no turn in progress to
    // unwind on the way back — and resuming a stale one would spin the map
    // through an angle the player never saw.
    if (requestedMode === 'NAVIGATION') {
      heading.reset(0);
      recentre();
      // And the camera takes back every axis the player had. This is the only
      // thing that clears them, which is what makes the toggle the answer to
      // "put it back how it was" — the same button that is already the answer
      // to "show me the whole place".
    }
  }

  /**
   * The way back, and the only one.
   *
   * Every axis the player took by hand returns to the camera at once. It is one
   * control because it is one thought — *put it back* — and splitting it into
   * four would be four controls on a screen held at a run. R-48's toggle does
   * the same thing on the way through overview, which is why that is the other
   * way back.
   */
  function recentre(): void {
    // Before the flags, not after: the filter has to be told where the camera
    // *is* while it is still the player's, or the first frame back writes the
    // bearing it was left at and the map snaps.
    const instance = map;

    /**
     * Overview does it itself, because there is no loop here to hand the camera
     * back to.
     *
     * `tick` returns on its first line outside navigation, so clearing `held`
     * and starting the loop — which is the whole of what this function did —
     * scheduled a frame that returned immediately. The button worked in one
     * mode and was inert in the other, with nothing to say which.
     *
     * An `easeTo` is safe for the reason the peek's is: no loop is writing this
     * camera per frame, so there is no transition for a `jumpTo` to cancel.
     *
     * **The centre only, never the zoom.** Overview is the framing the player
     * chose — R-48 gives them the whole area and they may have zoomed into a
     * corner of it — and this was asked as *where am I*, not *start again*. The
     * pan is clamped by `maxBounds` on the way, which is what keeps it inside
     * the basemap's box without this having to know where the edges are.
     */
    if (mode !== 'NAVIGATION') {
      onRecentre?.();
      if (instance && self) {
        instance.easeTo({ center: [self.lon, self.lat], duration: 600 });
        markSelf();
      }
      return;
    }

    if (instance && held.bearing) heading.resume(instance.getBearing());
    // The camera is wherever the player left it, so this one is a catch-up.
    reacquiring = true;
    held.centre = false;
    held.zoom = false;
    held.bearing = false;
    held.pitch = false;
    onRecentre?.();
    markSelf();
    startAnimating();
  }
</script>

<!-- The map fills whatever it is given and draws its own chrome on top. It is
     the interface rather than a section of one, so the parent decides the box
     and nothing here scrolls. -->
<!-- `picking` is the armed coordinate tool. It makes the points inert, so a tap
     over one is a coordinate rather than a card: the tool exists to read a spot
     off the map, and a spot with a POI on it is a likely spot. -->
<section class:picking={!!onPick} class:master={viewer === 'MASTER'}>
  <div class="map" bind:this={container}></div>

  <!--
    Everything the *map* draws over itself, in one column.

    A corner is a single tenant. Four corners and this screen has five things
    wanting one — the scale, R-48's toggle, the faults, the callsign, the
    status block — so two of them landed on top of each other: the toggle under
    QRA, the scale under the HUD's nearest-POI line. Stacking the map's own
    chrome here leaves the other three corners to the view, and the column
    grows downwards into empty map instead of into whatever is beside it.

    Top left because R-43's alert takes the top edge whole, and the one thing
    it is allowed to cover is the machine talking about itself.
  -->
  <div class="chrome">
    <div class="scale" bind:this={scaleHost}></div>

    <!--
      R-48's toggle and the way back, as two icons rather than two words.

      Absent for a master: R-49 gives them one camera and neither control has
      anything to do.

      Drawn rather than lettered, and rather than a glyph. `⤢` and `⌖` are not in
      VT323 — §9.7's four state marks were already lost to exactly that — and a
      word that changes between VISTA GENERAL and NAVEGACION is a button that
      changes width under a thumb aiming at it. Both keep their words where they
      belong on a control this small, in `aria-label` and `title`.
    -->
    {#if viewer === 'PLAYER'}
      <button
        type="button"
        class="mode"
        aria-label={mode === 'NAVIGATION' ? t.map.overview : t.map.navigation}
        title={mode === 'NAVIGATION' ? t.map.overview : t.map.navigation}
        onclick={toggleMode}
      >
        <i class="icon" data-icon={mode === 'NAVIGATION' ? 'overview' : 'navigate'}></i>
      </button>
      <button
        type="button"
        class="mode"
        aria-label={t.map.recentre}
        title={t.map.recentre}
        onclick={recentre}
      >
        <i class="icon" data-icon="recentre"></i>
      </button>

      <!--
        R-68c. The whole screen, on a press.

        In this column because to a player it is a camera control in the only
        sense that matters: it decides how much ground is on screen. The two
        above change what the camera looks at, and this changes how big the
        window is.

        **It cannot be automatic**, which is the requirement and not a shortcut.
        `requestFullscreen()` needs a user gesture, so no rotation handler may
        call it, and the manifest's `display` is read once at install and cannot
        differ between orientations. Pressed once, it survives every rotation
        until the player leaves.

        **Inside the player's block**, with the other two. A floating control on
        the map is furniture this app gives to a phone held in one hand; the
        master has a bar with room on it and gets the same thing as a key.
      -->
      {#if display.canFullscreen}
        <button
          type="button"
          class="mode"
          aria-label={display.fullscreen ? t.map.windowed : t.map.fullscreen}
          title={display.fullscreen ? t.map.windowed : t.map.fullscreen}
          onclick={() => void display.toggleFullscreen()}
        >
          <i class="icon" data-icon={display.fullscreen ? 'windowed' : 'fullscreen'}></i>
        </button>
      {/if}
    {/if}

    <!-- The two silent failures, made loud. A blank map and a broken map look
         the same, so the difference has to be written down somewhere. -->
    {#if mapError}
      <p class="fault">{t.map.fault}: {mapError}</p>
    {:else if !styleReady}
      <p class="hint">{t.map.loading}</p>
    {/if}
    {#if !basemap.pmtilesUrl}
      <p class="hint">{t.map.noBasemap}</p>
    {/if}
  </div>
</section>

<style>
  section {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .map {
    position: absolute;
    inset: 0;
  }

  /**
   * The hand appears when the hand is doing something, and not before.
   *
   * An open hand resting over the map is a promise about every pixel, the same
   * mistake the acting cursor made one commit earlier — it just says "draggable
   * here" instead of "clickable here". The map is draggable everywhere, so
   * saying so everywhere says nothing. The plain pointer sits over ground; the
   * hand closes on `:active`, which is exactly when a hand is holding
   * something.
   *
   * MapLibre supplies the class and the `:active` state; this only supplies the
   * images. The inline cursor on the canvas beats both when the coordinate tool
   * is armed or the pointer is over a dot, which is the precedence wanted: the
   * specific answer beats the general one.
   */
  :global(.maplibregl-canvas-container.maplibregl-interactive) {
    cursor: var(--cursor-arrow), default;
  }
  :global(.maplibregl-canvas-container.maplibregl-interactive:active) {
    cursor: var(--cursor-grabbing), grabbing;
  }

  /**
   * Everything below floats over the canvas. The column sets `pointer-events`
   * explicitly and so does the one control inside it: an overlay that forgets
   * eats the map's click handler, and picking a drop point by clicking real
   * ground silently stops working.
   *
   * `max-width` rather than a right edge: a fault message is a sentence, and
   * left to span the screen it would run under the callsign in the opposite
   * corner — which is the collision this column exists to end.
   */
  .chrome {
    position: absolute;
    top: calc(0.5ch + var(--safe-top));
    left: calc(0.5ch + var(--safe-left));
    max-width: min(48ch, calc(100% - 1ch - var(--safe-left) - var(--safe-right)));
    display: grid;
    gap: 0.3lh;
    justify-items: start;
    pointer-events: none;
  }

  /**
   * The master's view keeps a row in this corner — R-65's pilot and R-66's clock
   * — so on that view the column starts a line lower rather than sharing the
   * spot. The player's map has the corner to itself and does not move.
   *
   * Keyed off `viewer`, which this component is already told and already renders
   * differently for, and **not** off whether a recording is running: the clock
   * is there either way, and a rule that moved with the recording would put the
   * scale under it for the whole of every game that was not being recorded.
   * Nothing here learns what mode the app is in, which is the same line the
   * replay's route respects by arriving as frame furniture.
   */
  section.master .chrome {
    top: 2.2lh;
  }

  .mode {
    pointer-events: auto;
    background: var(--overlay-light);
    /* Square, because what is in it is a mark rather than a word. `--touch` is
       R-9's 44 px and it is the floor for both axes here. */
    width: var(--touch);
    min-width: var(--touch);
    min-height: var(--touch);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  /**
   * The two camera marks, drawn in CSS for the same reason §9.7's state marks
   * are: the characters that would say this (`⤢`, `⌖`, `➤`) are not in VT323,
   * and a mark that falls back to whatever the operating system supplies is a
   * different mark on every handset — a tofu box on one that supplies nothing.
   *
   * `currentColor` throughout, so both survive inverse video on hover and both
   * invert with the palette in daylight without a second rule.
   */
  .icon {
    position: relative;
    display: block;
    width: 1.1rem;
    height: 1.1rem;
    flex: none;
  }

  /* Navigation: the cursor a moving machine draws for itself, pointed the way
     the camera is about to face. */
  .icon[data-icon='navigate']::before {
    content: '';
    position: absolute;
    inset: 0;
    background: currentColor;
    clip-path: polygon(50% 0, 100% 100%, 50% 76%, 0 100%);
  }

  /**
   * Overview: the whole area, with you in it.
   *
   * It was four corner brackets, which is the standard *fit to screen* mark and
   * says nothing to somebody who has not seen it before — the complaint was
   * exactly that. A bordered area with a dot inside is the picture of what the
   * button does: here is the ground, here is where you are on it. It also
   * pairs with the arrow beside it — one is you, the other is you *and the
   * place* — which is what makes a pair of icons legible where one on its own
   * is a guess.
   */
  .icon[data-icon='overview']::before {
    content: '';
    position: absolute;
    inset: 4% 0;
    border: 2px solid currentColor;
  }

  .icon[data-icon='overview']::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 0.3rem;
    height: 0.3rem;
    margin: -0.15rem 0 0 -0.15rem;
    background: currentColor;
    border-radius: 50%;
  }

  /**
   * R-68c's two states, as brackets.
   *
   * Four corner brackets were rejected for `overview` because that mark is the
   * standard *fit to screen* one and says nothing about the whole area with you
   * in it. Here it says exactly what it does, and the objection does not carry:
   * the meaning wanted **is** fit to screen. Two opposite corners rather than
   * four, because at 1,1rem four brackets are a smudge, and open brackets can
   * never be confused with `overview`'s closed rectangle beside them.
   *
   * The two states point opposite ways, so the mark says which direction the
   * press goes rather than which state you are in — the same reading as the
   * camera toggle above, where the icon is the thing you are about to get.
   */
  .icon[data-icon='fullscreen']::before,
  .icon[data-icon='fullscreen']::after,
  .icon[data-icon='windowed']::before,
  .icon[data-icon='windowed']::after {
    content: '';
    position: absolute;
    width: 40%;
    height: 40%;
  }

  /**
   * The exit mark's brackets are smaller than the enter mark's, and that is the
   * only way to separate them.
   *
   * These two face **inwards**, so the corner each one draws sits at `size` from
   * its edge — two 40% boxes put both corners within a sixth of the icon of each
   * other, which at 1,1rem is under three pixels and reads as one smudge. At 28%
   * the corners are more than a third of the icon apart and the mark is two
   * brackets again. The arms shorten with them, which is the trade and is worth
   * it: what carries the meaning here is the gap.
   */
  .icon[data-icon='windowed']::before,
  .icon[data-icon='windowed']::after {
    width: 28%;
    height: 28%;
  }

  .icon[data-icon='fullscreen']::before {
    top: 0;
    left: 0;
    border-top: 2px solid currentColor;
    border-left: 2px solid currentColor;
  }

  .icon[data-icon='fullscreen']::after {
    bottom: 0;
    right: 0;
    border-bottom: 2px solid currentColor;
    border-right: 2px solid currentColor;
  }

  /* The same two corners with the brackets turned inwards: out of the screen
     rather than into it. */
  .icon[data-icon='windowed']::before {
    top: 0;
    left: 0;
    border-bottom: 2px solid currentColor;
    border-right: 2px solid currentColor;
  }

  .icon[data-icon='windowed']::after {
    bottom: 0;
    right: 0;
    border-top: 2px solid currentColor;
    border-left: 2px solid currentColor;
  }

  /* Recentre: a reticle. The same idea as the master's roster button, which is
     the same gesture — put the camera back on somebody. */
  .icon[data-icon='recentre']::before {
    content: '';
    position: absolute;
    inset: 22%;
    border: 2px solid currentColor;
    border-radius: 50%;
  }

  .icon[data-icon='recentre']::after {
    content: '';
    position: absolute;
    inset: 0;
    background:
      linear-gradient(currentColor, currentColor) 50% 0 / 2px 24% no-repeat,
      linear-gradient(currentColor, currentColor) 50% 100% / 2px 24% no-repeat,
      linear-gradient(currentColor, currentColor) 0 50% / 24% 2px no-repeat,
      linear-gradient(currentColor, currentColor) 100% 50% / 24% 2px no-repeat;
  }

  /**
   * The scale bar ships as a white box with a dark border, which is a modern UI
   * widget inside the phosphor area — the one thing §9 and §14.5 rule out. It
   * is redrawn here as a machine annotation: case lettering, no bloom, and the
   * bar itself in phosphor. The element is MapLibre's, so the rule reaches it
   * through `:global()`, scoped by `.scale` so it cannot touch anything else.
   */
  .scale :global(.maplibregl-ctrl-scale) {
    margin: 0;
    padding: 0 0.4ch;
    font-family: var(--case-font);
    font-weight: 600;
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    color: var(--phosphor-dim);
    background: var(--overlay-light);
    border-color: var(--phosphor-dim);
    border-width: 0 2px 2px;
    text-shadow: none;
  }

  .hint {
    color: var(--phosphor-dim);
    background: var(--overlay-light);
    padding: 0 0.6ch;
  }
  /* Outside the game aesthetic, like R-43's warnings and for the same reason:
     this is the machine reporting on itself, not part of the fiction. It keeps
     the alarm colour and a hard border rather than taking §9.4's inverse video,
     because inverse video is how this interface emphasises *game* content and a
     fault must not be mistakable for any of it. */
  .fault {
    font-family: var(--case-font);
    font-weight: 600;
    letter-spacing: 0.08em;
    border: 1px solid var(--alarm);
    color: var(--alarm);
    background: var(--overlay);
    padding: 0.3ch 0.6ch;
    text-shadow: none;
  }
  /**
   * The labels are DOM markers rather than a symbol layer (§14.3), and they are
   * the one place in the app where phosphor sits on something other than the
   * flat screen colour.
   *
   * **They inherit the tube's bloom, and over a map that is unreadable.** The
   * `text-shadow` on `.screen` is what makes glyphs glow, which works because
   * every other glyph in the app sits on `--screen`; a callsign sits on amber
   * roads, zone dashes and a growing uncertainty circle, and a glow spreads it
   * into all three. §9 is unambiguous about which side wins — the effect must
   * never compromise legibility — so the bloom is cancelled here and replaced
   * with an opaque plate.
   *
   * A plate rather than a heavier halo: a halo thickens with the background
   * behind it and a player reads this while walking, at night, at arm's length.
   * It also reads as a terminal annotation on the tube, which is what it is.
   */
  :global(.map-label) {
    font-family: var(--screen-font);
    font-size: 1rem;
    line-height: 1.1;
    color: var(--phosphor-bright);
    /* Not a glow. The inner shadow is a 1 px hard edge that keeps the glyph off
       the plate's own border; the bloom from .screen is cancelled outright. */
    text-shadow: 0 1px 0 var(--screen);
    background: rgb(var(--overlay-ink) / 0.82);
    border-left: 2px solid var(--phosphor-dim);
    padding: 0 0.4ch;
    white-space: nowrap;
    pointer-events: none;
    /* A drag across the map is a pan, and without this it also highlights every
       callsign it passes over. */
    user-select: none;
    -webkit-user-select: none;
  }
  :global(.map-label[data-kind='self']) {
    color: var(--screen);
    background: var(--phosphor);
    border-left-color: var(--phosphor-bright);
  }
  :global(.map-label[data-kind='unlocatable']) {
    color: var(--phosphor-dim);
    background: rgb(var(--overlay-ink) / 0.6);
    border-left-color: var(--phosphor-deep);
  }

  /**
   * The state marks (§9.7). Sized in `rem` like every other glyph, so they hold
   * their size on screen while the map zooms under them — which is the whole
   * reason they are not layers.
   */
  :global(.map-mark) {
    font-family: var(--screen-font);
    font-size: 1.5rem;
    line-height: 1;
    color: var(--phosphor-bright);
    text-shadow: 0 0 3px var(--screen);
    pointer-events: none;
    user-select: none;
  }
  /**
   * R-22's cross answers a press, and it says so the way the diamonds do.
   *
   * `[data-tap]` for the same reason they use it: the flag is written where a
   * listener was attached, so a map passing no `onSelect` gets no pointer events
   * back and no cursor promising something that does not happen. `.picking`
   * turns it off, because a master dropping a pin has to be able to click the
   * ground under somebody who is out — and that ground is exactly where a drop
   * point is likely to go.
   *
   * The box is the glyph and the glyph is 1.5rem, which is already bigger than
   * the 13 px circle a living player is picked by. Nothing to enlarge.
   */
  :global(.map-mark[data-kind='eliminated'][data-tap]) {
    pointer-events: auto;
    cursor: var(--cursor-hand), pointer;
  }
  .picking :global(.map-mark[data-kind='eliminated'][data-tap]) {
    pointer-events: none;
  }
  /**
   * The selection ring, as a ring — the same mark `position-selected` draws
   * around a dot, in the same colour and at the same 13 px radius, because it
   * means the same thing and a master should not have to learn a second way of
   * being told which card is open.
   *
   * A border rather than an `outline`: the element is a glyph box, and an
   * outline follows its corners.
   */
  :global(.map-mark[data-kind='eliminated'][data-on]) {
    box-sizing: border-box;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px solid var(--phosphor-bright);
    border-radius: 50%;
  }
  /**
   * The diamonds: a POI (R-16) and a master's marker (R-20b).
   *
   * Drawn from a rotated box rather than set as `◆`, so nothing depends on the
   * screen face carrying that character — a missing glyph is a tofu box, which
   * is a worse mark than no mark. The two are told apart by three things at
   * once, none of them hue: size, brightness and whether the shape is filled.
   * That is §9.7's rule applied to furniture instead of to people.
   */
  :global(.map-shape) {
    display: flex;
    align-items: center;
    justify-content: center;
    /* A box far larger than the diamond in it. The shape is ~12 px and a finger
       is not, so the target is sized for the hand while the mark stays sized
       for the map. Not `--touch`: thirty-four of those over a venue would cover
       most of it, and every one would be a place a master cannot drop a pin. */
    width: 1.7rem;
    height: 1.7rem;
    pointer-events: none;
  }
  :global(.map-shape i) {
    display: block;
    rotate: 45deg;
  }
  /**
   * Hollow, and at full phosphor.
   *
   * It was `--phosphor-dim` at a hairline, on the reasoning that a fixed point
   * must not compete with the people moving over it. On amber roads under a
   * scanline overlay that came out invisible — and a point nobody can find is
   * not a quiet point, it is an absent one. Hollow against the marker's solid
   * is what keeps the two apart now, which is a difference in *shape* and
   * survives at any brightness.
   */
  :global(.map-shape[data-kind='poi'] i) {
    width: 0.78rem;
    height: 0.78rem;
    border: 1.5px solid var(--phosphor);
  }
  /* Answers a tap, which nothing else floating over the map does — so it says
     so with the cursor, and takes back the pointer events the box gives up. */
  :global(.map-shape[data-kind='poi']) {
    pointer-events: auto;
    cursor: var(--cursor-hand), pointer;
  }
  .picking :global(.map-shape[data-kind='poi']) {
    pointer-events: none;
  }
  /**
   * A marker answers a tap too, on both halves (R-20b).
   *
   * The label is the target that matters — a diamond is fifteen pixels and a
   * name is the width of a name — which is why the rule reaches `.map-label`
   * and not only the shape.
   *
   * `[data-tap]` and not the kind alone: the flag is written where a listener
   * was attached, so on the master's map — which passes no `onMarker` — nothing
   * here applies. Taking the events back without one would swallow a click that
   * reaches the canvas today, under a cursor promising something that does not
   * happen. `.picking` turns it off for the same reason it does for a point: a
   * master dropping a pin has to be able to click the ground under a marker.
   */
  :global(.map-shape[data-kind='marker'][data-tap]),
  :global(.map-label[data-kind='marker'][data-tap]) {
    pointer-events: auto;
    cursor: var(--cursor-hand), pointer;
  }
  .picking :global(.map-shape[data-kind='marker'][data-tap]),
  .picking :global(.map-label[data-kind='marker'][data-tap]) {
    pointer-events: none;
  }
  /* Solid: a marker is the master speaking, and R-21's TTL means it is on
     screen because somebody put it there a moment ago. */
  :global(.map-shape[data-kind='marker'] i) {
    width: 0.95rem;
    height: 0.95rem;
    border: 1.5px solid var(--phosphor-bright);
    background: var(--phosphor);
  }
  /**
   * An entrance, as a gap in a wall.
   *
   * The only mark on the map that is **not a closed shape**, which is what
   * makes it readable at twelve pixels through a scanline overlay: every other
   * thing on screen — the dots, the diamonds, the uncertainty circle — encloses
   * an area, and this one is open down the middle. A door drawn as a door would
   * have been a curve, and the player dot is already a curve.
   *
   * It is the one category that gets its own mark, because it is the one whose
   * reading changes what you do without opening anything: where you get in is
   * where you get out, which is the question R-43's warning creates. The other
   * four differ in what they are for, not in how you move, and the card says
   * which is which.
   */
  :global(.map-shape[data-kind='poi'][data-category='ENTRANCE'] i) {
    width: 0.55rem;
    height: 0.85rem;
    /* Undoes the diamond's turn: this one is upright, and a rotated gate is a
       gate you cannot walk through. */
    rotate: none;
    border: none;
    border-left: 2px solid var(--phosphor);
    border-right: 2px solid var(--phosphor);
  }

  /**
   * The ring itself. `transform` and `opacity` only — the two properties a
   * compositor animates without touching layout or paint, which is what keeps
   * this off the back of a WebGL canvas R-48 rewrites every frame.
   *
   * Two rings half a period apart, so the sweep reads as repeating rather than
   * as one circle that keeps restarting.
   */
  :global(.map-shape[data-kind='ping']) {
    width: 0;
    height: 0;
    overflow: visible;
  }
  :global(.map-shape[data-kind='ping'] i),
  :global(.map-shape[data-kind='ping'])::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 8rem;
    height: 8rem;
    margin: -4rem 0 0 -4rem;
    border: 1px solid var(--phosphor-bright);
    border-radius: 50%;
    opacity: 0;
    rotate: none;
    animation: ping var(--ping-period) ease-out infinite;
    will-change: transform, opacity;
  }
  :global(.map-shape[data-kind='ping'])::after {
    animation-delay: calc(var(--ping-period) / 2);
  }

  @keyframes ping {
    0% {
      transform: scale(0.05);
      opacity: var(--sweep-opacity);
    }
    70% {
      opacity: calc(var(--sweep-opacity) * 0.25);
    }
    100% {
      transform: scale(1);
      opacity: 0;
    }
  }

  /* §9's motion obligation, both halves: the token alone leaves the animation
     running at zero amplitude, which still wakes the compositor every frame on
     a device whose owner asked for less of exactly that. */
  @media (prefers-reduced-motion: reduce) {
    :global(.map-shape[data-kind='ping'] i),
    :global(.map-shape[data-kind='ping'])::after {
      animation: none;
    }
  }

  /**
   * The open card's point, at the brightness the selected dot's ring uses.
   *
   * The halo goes on the outer box as a radial gradient rather than on the mark
   * as a `box-shadow`: a shadow follows the border box, so on the gate — which
   * has only two borders — it would draw the rectangle the gate deliberately is
   * not. A glow behind the mark works whatever shape the mark is.
   */
  :global(.map-shape[data-kind='poi'][data-on]) {
    background: radial-gradient(circle, rgb(255 216 153 / 0.3) 42%, transparent 62%);
  }
  :global(.map-shape[data-kind='poi'][data-on] i) {
    border-color: var(--phosphor-bright);
  }

  /* The same halo for the marker the player is walking to. The mark is already
     solid, so the selection is carried by the glow and by the label going up to
     full phosphor — there is no border left to brighten. */
  :global(.map-shape[data-kind='marker'][data-on]) {
    background: radial-gradient(circle, rgb(255 216 153 / 0.3) 42%, transparent 62%);
  }
  :global(.map-label[data-kind='marker'][data-on]) {
    color: var(--phosphor-bright);
  }

  /* R-31's drop point is a place, not a person: dimmer than the mark for where
     their phone is now, so the two cannot be read as two players. */
  :global(.map-mark[data-kind='drop']) {
    color: var(--phosphor-deep);
    font-size: 1.2rem;
  }
  :global(.map-label[data-kind='drop']) {
    color: var(--phosphor-dim);
    background: rgb(var(--overlay-ink) / 0.6);
    border-left-color: var(--phosphor-deep);
    font-size: 0.85rem;
  }

  /**
   * High contrast takes the plate to solid and the text to the top of the
   * palette. This is the reading §9 means by "raises text contrast": the
   * effects are already gone by then, and what is left to improve is the one
   * surface where phosphor competes with a picture.
   */
  :global(:root[data-contrast='high'] .map-label) {
    background: var(--screen);
    color: var(--phosphor-bright);
    border-left-color: var(--phosphor-bright);
  }
  :global(:root[data-contrast='high'] .map-label[data-kind='unlocatable']) {
    color: var(--phosphor);
    background: var(--screen);
  }
</style>

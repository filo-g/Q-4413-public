<script lang="ts">
  import type { Poi, Sector, Zone } from '@q4413/shared';


  import { claimsFocus } from './claimsFocus.ts';
  import { draggable } from './draggable.ts';
  import Eta from './Eta.svelte';
  import { formatCoords, formatDistance, placeName } from '../format.ts';
  import { t } from '../i18n.ts';

  /**
   * What a point is, opened from the point.
   *
   * The names are not drawn on the map, and that is a decision rather than an
   * omission. A venue carries tens of points; that many labels at a zoom
   * where the venue fits is an unreadable map, which is the same reason §14.3
   * strips the basemap's own labels. So the diamond says *there is something
   * here* and this says what — the same bargain the callsign markers make with
   * the player card, and reached the same way.
   *
   * Distance and rough time are here because this is where they are wanted. The
   * panel lists every point with both (R-18, R-44, R-45) and always will; that
   * list answers "where is the nearest X", and this answers "what is that".
   * They are omitted rather than shown as a dash when there is no fix to measure
   * from — a blank distance is a reading, and there is no reading.
   */
  let {
    poi,
    zones,
    sectors,
    metres,
    seconds,
    anchor = 'bottom-right',
    coords = true,
    onclose,
  }: {
    poi: Poi;
    /**
     * Every zone and every sector, to name the place the point is in (R-70).
     *
     * **The lookup, not the derivation.** This card used to run `zoneAt()`
     * itself, because a POI was a coordinate pair and nothing assigned it a
     * zone — and the docblock here said in as many words that two derivations
     * of one fact drift. R-71 gave the point a `zone`, derived once in
     * `gameGeoFromGeoJson()` where the geometry is, so there is one answer now
     * and this is a name for it.
     *
     * §4 does not stand in the way: `project()` sends every open zone to
     * everybody, because the zones are the map and a player has to see the shape
     * of the one they are standing in.
     */
    zones: readonly Zone[];
    sectors: readonly Sector[];
    metres?: number;
    seconds?: number;
    /**
     * Which corner it rests in. Not a style choice: every view has different
     * corners spoken for, and two cards in one corner means the card you opened
     * covers the card you had. The master keeps its people card bottom right,
     * so points go top right; the player has the callsign there and the status
     * block below it, so points go left, above the HUD's line.
     */
    anchor?: 'bottom-right' | 'bottom-left' | 'top-right';
    /**
     * Whether to print the coordinate pair.
     *
     * Off for a player, and it is the same decision their QTH makes: a player
     * says "estoy en Outlet" on the radio, and six decimal places is a reading
     * nobody uses at a run. A master keeps them — they are what a marker is
     * placed with and what gets read out when something has to be found.
     */
    coords?: boolean;
    onclose: () => void;
  } = $props();

  const hasDistance = $derived(metres !== undefined && Number.isFinite(metres));

  /**
   * Whether the line is answering "where is this" or "where does this take me",
   * because for an entrance those are different questions.
   *
   * Every other point answers the first: the zone containing it. An entrance
   * answers the second, and the containing zone is not even a stable answer to
   * the first — the entrances are drawn **on** the ring of the zone they serve,
   * a boundary counts as inside, and `zoneAt()` then answers with whichever zone
   * the file lists first, which for some of them is the car park you walk in
   * *from*.
   *
   * `Poi.zone` already resolves that the right way round (see `withZone()`), so
   * this only decides the **label**. Absent when there is nothing true to say,
   * and the line goes with it rather than printing a dash — the card's rule
   * throughout.
   */
  const leadsTo = $derived(poi.category === 'ENTRANCE' && poi.entranceTo !== undefined);
  const zone = $derived(
    poi.zone === undefined ? undefined : placeName(zones, sectors, poi.zone),
  );
</script>

<!-- `claimsFocus` gives it the panels' contract: focus moves in when it opens
     and back where it came from when it closes, so a point opened from the
     table's row is one `Tab` from its own controls rather than a dozen. -->
<aside
  class="card"
  class:left={anchor === 'bottom-left'}
  class:top={anchor === 'top-right'}
  use:claimsFocus
>
  <div class="card-head" use:draggable>
    <strong>{poi.name}</strong>
    <button
      type="button"
      class="close"
      aria-label={t.card.close}
      title={t.card.close}
      onclick={onclose}>×</button>
  </div>
  <div class="card-body">
    <p class="hint">{t.pois.category[poi.category]}</p>
    {#if hasDistance}
      <p>
        <span class="q">{t.pois.distance}</span>
        {formatDistance(metres as number)}
        {#if seconds !== undefined && Number.isFinite(seconds)}
          · <Eta seconds={seconds} />
        {/if}
      </p>
    {/if}
    {#if zone}
      <p>
        <span class="q">{leadsTo ? t.pois.entranceTo : t.players.place}</span>
        {zone}
      </p>
    {/if}
    {#if coords}
      <p class="hint">
        <span class="q">{t.q.qth}</span>
        {formatCoords(poi.lat, poi.lon)}
      </p>
    {/if}
    {#if poi.description}
      <p>{poi.description}</p>
    {/if}
  </div>
</aside>

<style>
  /**
   * The same window the player card is, in the corner the view has left free —
   * and draggable from its title bar for the same reason: a card lands on top
   * of the thing it describes often enough that moving it beats closing it,
   * panning, and opening it again.
   */
  .card {
    position: absolute;
    right: 0.4ch;
    bottom: 0.4ch;
    /* See the note on the master's card: 40ch is wider than a phone, so the
       cap has to be the smaller of the two. */
    max-width: min(40ch, calc(100% - 0.8ch));
    max-height: 60%;
    overflow: auto;
    background: var(--overlay);
    border: 1px solid var(--phosphor-dim);
    pointer-events: auto;
    z-index: 2;
  }

  /* Focused by `claimsFocus` when it opens, so `Tab` continues inside it rather
     than behind it — and no ring, for the same reason the panels have none: a
     ring around a container nobody navigated to reads as a fault. The controls
     inside keep theirs. */
  .card:focus,
  .card:focus-visible {
    outline: none;
  }

  .card.left {
    right: auto;
    left: 0.4ch;
    /* Clear of the HUD's line, which runs the width of the screen. */
    bottom: 2.2lh;
  }

  .card.top {
    bottom: auto;
    top: 0.4ch;
  }

  .card-head {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1ch;
    padding: 0 0.6ch;
    background: var(--phosphor);
    color: var(--screen);
    text-shadow: none;
  }

  .card-head button {
    color: var(--screen);
    border-color: var(--screen);
  }

  .card-head button:hover:not(:disabled),
  .card-head button:focus-visible {
    background: var(--screen);
    color: var(--phosphor);
  }

  .card-body {
    padding: 0.3lh 0.6ch;
    display: grid;
    gap: 0.2lh;
  }

  .card-body p {
    margin: 0;
  }

  .hint {
    color: var(--phosphor-dim);
  }
</style>

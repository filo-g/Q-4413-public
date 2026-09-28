<script lang="ts">

  import { onDestroy, untrack } from 'svelte';

  import { distanceMetres, etaSeconds, poiDistances } from '@q4413/core';

  import { declareEliminated, recordRadioContact } from '../../api.ts';
  import {
    formatAge,
    formatBearing,
    formatDistance,
    formatDuration,
    formatUncertainty,
    placeName,
  } from '../../format.ts';
  import Eta from '../../chrome/Eta.svelte';
  import PoiCard from '../../chrome/PoiCard.svelte';
  import Qsa from '../../chrome/Qsa.svelte';
  import { display } from '../../display.svelte.ts';
  import { game } from '../../game.svelte.ts';
  import Scramble from '../../chrome/Scramble.svelte';
  import { stateMark } from '../../glyphs.ts';
  import { t } from '../../i18n.ts';
  import { matchBinding, type Binding } from '../../keys.ts';
  import GameMap from '../../map/GameMap.svelte';
  import {
    nextPerimeterState,
    PERIMETER_UNKNOWN,
    PERIMETER_VIBRATION,
    type PerimeterState,
  } from '../../perimeter.ts';
  import { dotsOf, frameOf } from '../../map/frame.ts';

  /**
   * Player view over a projected payload. Deliberately plain: the map (M7), the
   * boundary warnings (R-43) and the CRT layer (§9) come later.
   *
   * What it is for now is M2's exit criterion — with this open, a devtools
   * inspection of the socket shows exactly what a player is allowed to hold.
   * Everything on screen came out of project(); nothing was fetched around it.
   */
  const payload = $derived(game.payload);
  /**
   * Everybody, in the order the server sent them.
   *
   * **Not split and not re-sorted.** R-42 puts same-zone players first and
   * says the client must not reorder — doing so is how an out-of-zone player
   * re-enters a ranking they were removed from. What used to be two sections is
   * one list with two kinds of row, and which kind a row is is decided by what
   * `project()` put on it rather than by anything read here.
   */
  const roster = $derived(payload?.players ?? []);

  /**
   * R-21d as a reading rather than as a sentence.
   *
   * It used to be a line of prose at the top of the panel saying extended comms
   * was on and what it did. That is a notice, and a notice is read once — the
   * fact it carries is a *state of the link*, which is the kind of thing this
   * machine reports with a meter and keeps reporting.
   *
   * Three levels, because there are exactly three things to say:
   *
   * - **0** — nothing is arriving. The socket is down or still opening, which is
   *   the same `SIN CONEXION` the bar prints, and no comms setting means
   *   anything while it is true.
   * - **3** — the game as built: you see your own zone (§4).
   * - **5** — extended comms (R-21d): your team, in any zone.
   *
   * QSA is a 1-to-5 scale on a real set, which is why the scale is five and why
   * the master's bar already prints this fact that way. The fiction does the
   * explaining the prose used to do: better comms is a stronger signal.
   */
  const signal = $derived(game.signal);

  /** What the level means, in a line. */
  const signalHint = $derived(
    signal === 0 ? t.qsa.none : t.qsa[signal],
  );

  /**
   * Who made the radio contact, by callsign (R-29).
   *
   * `reportedBy` is a playerId or the literal `MASTER`, and an id on screen is
   * not a reading — a player says "BRAVO me ha oído", never a uuid. The master's
   * card resolves it the same way and the two say the same sentence.
   *
   * **Nothing is revealed by resolving it.** Every player in the payload carries
   * a callsign already, out-of-zone ones included — that is exactly what R-40
   * leaves them — so this reads a name the viewer was handed rather than asking
   * for one. `payload.self` is checked separately because the roster is other
   * people: the contact a player made themselves is the common case and it is
   * the one the roster cannot answer.
   *
   * The id remains the fallback, and it is reachable rather than defensive:
   * `roster.ts` leaves contact records naming a removed player alone, so the
   * lookup legitimately misses for anyone taken off the roster since.
   */
  function reporterName(reportedBy: string): string {
    if (reportedBy === 'MASTER') return t.radio.byMaster;
    if (reportedBy === payload?.self?.id) return payload.self.callsign;
    return roster.find((candidate) => candidate.id === reportedBy)?.callsign ?? reportedBy;
  }

  /**
   * A zone id as its name.
   *
   * The zone comes off the projected position, which is the same value the
   * server used to decide who may see this player — running `zoneAt()` again on
   * the client would be a second arithmetic for one fact, and the two disagree
   * the first time somebody stands on a boundary. Everybody gets every zone
   * (§4), so there is nothing to withhold here; what is withheld is the
   * position that points at one.
   */
  const zoneNameOf = (id: string | undefined): string =>
    placeName(payload?.zones, payload?.sectors, id);

  /**
   * Drawn from the payload, so it can only show what §4 let through: an
   * out-of-zone player has no position here, and there is nothing to render as a
   * ghost marker (R-40). Framed on the perimeter — a player cares about the
   * playable area, not the ingest box around it.
   */
  const frame = $derived(payload ? frameOf(payload, game.serverNow) : null);
  const dots = $derived(payload ? dotsOf(payload, game.serverNow) : []);

  /**
   * R-32's deliberate confirmation: three seconds of press-and-hold, not a tap
   * and not a dialog.
   *
   * The hold *is* the confirmation, which is why there is no second screen to
   * accept. A player reaches for this while out of breath and probably in the
   * dark, so the failure to protect against is the accidental brush — and a
   * three-second hold is the one gesture that cannot happen by accident and
   * cannot be dismissed by reflex either.
   *
   * Keyboard gets the same three seconds through keydown/keyup rather than a
   * separate path: a screen reader user should not have a faster route to an
   * irreversible action than everybody else. Auto-repeat keydowns are ignored, so
   * holding the key is a hold rather than a stream of presses.
   */
  const HOLD_MS = 3_000;
  let holdStartedAt = $state<number | null>(null);
  let holdProgress = $state(0);
  let holdTimer: ReturnType<typeof setInterval> | undefined;
  let declaring = $state(false);
  let cancelled = $state(false);

  const eliminated = $derived(payload?.self?.eliminated !== undefined);
  /** M6 gates the button on the game state; the server refuses with 409 regardless. */
  const canDeclare = $derived(
    payload !== null &&
      !eliminated &&
      (payload.game.state === 'IN_PROGRESS' || payload.game.state === 'PAUSED'),
  );

  function stopHold(): void {
    if (holdTimer) clearInterval(holdTimer);
    holdTimer = undefined;
    holdStartedAt = null;
    holdProgress = 0;
  }

  function startHold(): void {
    if (!canDeclare || declaring || holdStartedAt !== null) return;
    cancelled = false;
    holdStartedAt = Date.now();
    holdTimer = setInterval(() => {
      if (holdStartedAt === null) return;
      holdProgress = Math.min(1, (Date.now() - holdStartedAt) / HOLD_MS);
      if (holdProgress >= 1) void completeHold();
    }, 50);
  }

  async function completeHold(): Promise<void> {
    stopHold();
    declaring = true;
    try {
      await declareEliminated();
    } catch (error) {
      console.error(error);
    } finally {
      declaring = false;
    }
  }

  /**
   * Releasing early says so, rather than leaving a player who let go at two
   * seconds wondering whether it went through. The alternative — silence — is the
   * one outcome nobody can act on.
   */
  function releaseHold(): void {
    if (holdStartedAt === null) return;
    cancelled = holdProgress < 1;
    stopHold();
  }

  function onHoldKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // The browser fires keydown repeatedly while a key is held; only the first
    // starts the clock, or every repeat would restart it and the hold never lands.
    if (event.repeat) return;
    event.preventDefault();
    startHold();
  }

  function onHoldKeyup(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    releaseHold();
  }

  /**
   * R-18, R-44, R-45. Name, distance and rough time, for every POI §4 let
   * through — ordered by distance rather than filtered by it, because R-16 makes
   * POIs visible from the start and R-18 says proximity unlocks nothing. The car
   * park is useful precisely when you are nowhere near it.
   */
  const pois = $derived(
    payload ? poiDistances(payload.self?.position, payload.pois, payload.config) : [],
  );

  /**
   * Read through game.markers, not payload.markers: expiry is derived on this side
   * too (R-21c), so a marker past its TTL leaves the screen with nothing arriving.
   * Each carries its own distance and rough time, because a marker is somewhere to
   * walk to (R-45).
   */
  const markers = $derived.by(() => {
    const from = payload?.self?.position;
    return game.markers.map((marker) => {
      const metres = from ? distanceMetres(from, marker) : Number.NaN;
      return {
        marker,
        metres,
        seconds: Number.isFinite(metres) && payload ? etaSeconds(metres, payload.config) : Number.NaN,
        remaining: game.markerRemainingSeconds(marker),
      };
    });
  });

  let busy = $state(false);

  /**
   * Which panel is open, or none. Three, because a player's screen is the map
   * and three things are all that is ever behind it: who is near, what is on the
   * ground, and the one irreversible control.
   *
   * `OUT` is a panel rather than a button on the bar deliberately. R-30 is
   * irreversible and the screen is carried at a run; the three-second hold
   * guards the gesture and one tap to reach it guards the screen.
   */
  type Panel = 'NEAR' | 'POINTS' | 'OUT';
  /**
   * `OUT` is offered only while there is something to declare. M6 gates R-30 on
   * the game state and the server refuses with a 409 regardless, so a button
   * outside `IN_PROGRESS`/`PAUSED` is a button that can only disappoint — and it
   * is the one button on this screen nobody should press twice to find out.
   * An eliminated player keeps it, because the panel is where their own record
   * is (R-30.4).
   */
  const PANELS = $derived<Panel[]>(
    canDeclare || eliminated ? ['NEAR', 'POINTS', 'OUT'] : ['NEAR', 'POINTS'],
  );
  const PANEL_LABEL: Record<Panel, string> = {
    NEAR: t.hud.team,
    POINTS: t.hud.points,
    OUT: t.eliminate.title,
  };
  /** Digits in bar order, so the number on screen is the number to press. */
  const PANEL_KEY: Record<Panel, string> = { NEAR: '1', POINTS: '2', OUT: '3' };
  let open = $state<Panel | null>(null);

  /**
   * Focus follows the panel, or a keyboard user opens one and carries on
   * tabbing through the bar behind it.
   */
  let panelBox = $state<HTMLElement | null>(null);
  let returnFocusTo: HTMLElement | null = null;

  function togglePanel(id: Panel): void {
    if (open === id) {
      open = null;
      returnFocusTo?.focus();
      returnFocusTo = null;
      return;
    }
    const active = document.activeElement;
    returnFocusTo = active instanceof HTMLElement ? active : null;
    open = id;
  }

  $effect(() => {
    if (open) panelBox?.focus();
  });

  /** The glass steps back while a panel is up (§9: legibility wins). */
  $effect(() => {
    if (!open) return;
    return display.openedReader();
  });

  /**
   * Escape, one step at a time: the point's card first, then the panel.
   *
   * R-30's hold is deliberately not reachable from the keyboard as a shortcut.
   * It already answers Enter and Space with the same three seconds every other
   * route gets — a key that declared somebody out on one press would be the
   * accidental brush the hold exists to prevent, with a keyboard instead of a
   * thumb.
   */
  function escape(): void {
    if (selectedPoi) {
      selectedPoi = null;
      return;
    }
    // One step out each press, innermost first: the card, then the course, then
    // the dot, then the panel. A player who pressed Escape meant "not that",
    // never "forget everything I was doing".
    if (destination) {
      destination = null;
      return;
    }
    if (selectedPlayer) {
      selectedPlayer = null;
      return;
    }
    if (open) togglePanel(open);
  }

  /**
   * The bindings at the moment a key is pressed, and the listener bound to the
   * component rather than registered by hand — see `MasterView` for the failure
   * that produced both.
   */
  function bindingsNow(): Binding[] {
    return [
      { key: 'Escape', run: escape },
      ...PANELS.map((id) => ({ key: PANEL_KEY[id], run: () => togglePanel(id) })),
    ];
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    const binding = matchBinding(event, bindingsNow());
    if (!binding) return;
    event.preventDefault();
    try {
      binding.run();
    } catch (error) {
      console.error('[keys]', error);
    }
  }

  /** A panel that stops being offered must not stay open behind the bar. */
  $effect(() => {
    const offered = PANELS;
    if (open && !offered.includes(open)) open = null;
  });

  /**
   * R-29 runs this game on walkies, so the status block speaks Q code: `QRA` is
   * the callsign, `QTH` the position, `QSA` the strength of the signal, `QRV`
   * readiness, `QRP` low power. Three letters read at arm's length in the dark
   * where a Spanish word does not, and the players are already saying them.
   *
   * QSA is a 1-to-5 scale on a real set, and what this app reports on it is
   * `game.signal` — see there. It used to be the link and nothing else, 5 for an
   * open socket and 1 for a closed one, which is a fact about a WebSocket rather
   * than about the game: always 5 while anything was working, so never worth a
   * glance. The HUD and the roster's gauge are now one reading.
   */

  /**
   * The zone the player is standing in, beside the coordinates on QTH.
   *
   * A pair of decimals is a position a radio can read out and nothing a person
   * can act on; the zone is the half of QTH that answers "where am I" in the
   * words the game is played in — it is what R-42's roster groups by, what the
   * zone rules cut on, and what a player says on the walkie.
   *
   * **Read off the position, never derived here.** `applyPing()` decides the
   * zone when the fix arrives, so this is the same value the server used to
   * decide who may see this player; running `zoneAt()` again on the client
   * would be a second arithmetic for one fact, and the two would disagree the
   * moment a fix lands on a boundary.
   *
   * Absent when there is none — a player outside every zone, or a game whose
   * positions predate the field. Omitted rather than dashed: no zone is a
   * true answer and `—` reads as a zone whose name we lost.
   */
  const selfZone = $derived.by(() => {
    const id = payload?.self?.position?.zoneId;
    if (!id) return undefined;
    // Sector and zone both (R-70). "Estoy en Comercio" locates nobody who has
    // not walked the place, and across a dozen sectors that is most people.
    return placeName(payload?.zones, payload?.sectors, id);
  });

  /**
   * R-18 and R-44 on the HUD: the nearest POI, with its distance.
   *
   * `poiDistances()` orders by distance and never filters by it — R-16 makes
   * POIs visible from the start and R-18 says proximity unlocks nothing — so the
   * first entry is the nearest and `undefined` only when there are none to see
   * or no fix to measure from.
   */
  const nearestPoi = $derived(
    payload?.self?.position && pois.length > 0 ? pois[0] : undefined,
  );

  /**
   * Which point's card is open.
   *
   * The names are not on the map — 34 of them over a venue is an unreadable
   * map, which is the same reason §14.3 strips the basemap's own labels — so
   * the diamond says there is something there and the card says what, with the
   * distance and the rough walk (R-18, R-44, R-45). The panel's list still
   * answers "where is the nearest X"; this answers "what is that".
   */
  let selectedPoi = $state<string | null>(null);

  /**
   * Where the player said they are going, and which dot they are looking for.
   *
   * One press does both jobs the panel had to do: the row lights its mark on
   * the map so you can see *which* of thirty-four it is, and the map draws a
   * line to it so you can see *which way*. Splitting them into "highlight" and
   * "set destination" would be two controls on a phone held at a run, and the
   * answer to both is the same gesture — I am going there.
   *
   * Ids rather than records, because the payload is replaced on every snapshot
   * and holding the object would freeze the distance at the moment it was
   * pressed.
   */
  let destination = $state<string | null>(null);
  let selectedPlayer = $state<string | null>(null);

  function toggleDestination(id: string): void {
    destination = destination === id ? null : id;
    // A point's card is its detail, so selecting it and reading it are the same
    // act. A marker has no card — its label *is* the detail, and it is already
    // drawn on the map.
    selectedPoi = destination && pois.some((entry) => entry.poi.id === destination) ? destination : null;
  }

  function togglePlayer(id: string): void {
    selectedPlayer = selectedPlayer === id ? null : id;
  }

  /**
   * How long the camera stays on the thing you asked to be shown.
   *
   * Long enough to see what is around it and short enough that nobody has to
   * wait for their own dot to come back. The slide each way is the map's own
   * per-frame smoothing rather than a transition, so this is the time *at* the
   * place, not the time including getting there.
   */
  const PEEK_MS = 2200;

  let peek = $state<{ lat: number; lon: number } | undefined>(undefined);
  let peekTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Show me this, then give me back.
   *
   * Closes the panel first, because a look at the map from behind a panel
   * covering the map is not a look at anything — which is what the list did
   * until now: it marked the point and left the sheet over it.
   */
  function showOnMap(place: { lat: number; lon: number }): void {
    open = null;
    peek = { lat: place.lat, lon: place.lon };
    if (peekTimer !== undefined) clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      peek = undefined;
      peekTimer = undefined;
    }, PEEK_MS);
  }

  /** The camera taking its axes back cancels a glance that is still running. */
  function endPeek(): void {
    if (peekTimer !== undefined) clearTimeout(peekTimer);
    peekTimer = undefined;
    peek = undefined;
  }

  onDestroy(() => {
    if (peekTimer !== undefined) clearTimeout(peekTimer);
  });

  /** A tap on bare map is "none of these", which is how Escape gets a second way in. */
  function clearDestination(): void {
    destination = null;
    selectedPoi = null;
  }

  /**
   * The destination as a place, whichever list it came from.
   *
   * Read back out of the derived lists rather than out of the payload, so the
   * distance beside the name is the one `poiDistances()` computed against the
   * same fix the line is drawn from — two arithmetics for one number is two
   * numbers eventually.
   */
  const destinationPlace = $derived.by(() => {
    if (!destination) return undefined;
    const poi = pois.find((entry) => entry.poi.id === destination);
    if (poi) {
      return {
        label: poi.poi.name,
        lat: poi.poi.lat,
        lon: poi.poi.lon,
        metres: poi.metres,
        seconds: poi.seconds,
      };
    }
    const marker = markers.find((entry) => entry.marker.id === destination);
    if (!marker) return undefined;
    return {
      label: marker.marker.label,
      lat: marker.marker.lat,
      lon: marker.marker.lon,
      metres: marker.metres,
      seconds: marker.seconds,
    };
  });

  /**
   * A destination that stops existing stops being one. A marker expires
   * (R-21c), a point can be withheld (R-16..R-18), and a line to a place that
   * is no longer on the payload is a line to a memory.
   */
  $effect(() => {
    if (destination && !destinationPlace) destination = null;
  });

  /** Same for a player §4 stops sending: no dot, nothing to have selected. */
  $effect(() => {
    if (selectedPlayer && !roster.some((other) => other.id === selectedPlayer)) {
      selectedPlayer = null;
    }
  });

  /**
   * Read out of `pois` rather than out of `payload.pois`, so the distance beside
   * the name is the one `poiDistances()` computed against the same fix — two
   * arithmetics for one number is two numbers eventually.
   */
  const selectedPoiEntry = $derived(pois.find((entry) => entry.poi.id === selectedPoi));

  /** A point §4 stops letting through must not leave a card describing it. */
  $effect(() => {
    if (selectedPoi && !selectedPoiEntry) selectedPoi = null;
  });

  /**
   * R-43, computed here and never fetched: the case this exists for is a player
   * walking out of the venue, which is exactly when the phone has the least
   * signal. Everything it needs — the perimeter and the player's own fix — is
   * already on screen.
   *
   * The state is carried across snapshots because "approaching" is a direction
   * and a single fix has none. §9 puts the warning **outside the game
   * aesthetic**: it is the one thing here that is not part of the fiction.
   */
  let perimeter = $state<PerimeterState>(PERIMETER_UNKNOWN);

  $effect(() => {
    const position = payload?.self?.position;
    // R-71: the live boundary, not the fixed recinto. A player warned about the
    // edge of ground that has been closed is warned about the wrong line.
    const ring = payload?.playArea;
    // The same reasoning R-04 gives the geofence, applied to the warning: setup
    // happens at home and in the car, hours before anybody reaches the venue,
    // and every one of those places is outside the perimeter. Warning there
    // would mean a red screen edge and a long vibration for the whole of
    // preparation, which teaches the player to ignore the one signal that has
    // to work when it matters.
    const playing = payload?.game.state === 'IN_PROGRESS' || payload?.game.state === 'PAUSED';
    if (!ring || !playing) {
      perimeter = PERIMETER_UNKNOWN;
      return;
    }
    // untrack, or this effect depends on the state it writes and re-runs itself
    // until the anchor stops moving. The snapshot is the trigger; the previous
    // warning is just what the new one is decided against.
    const previous = untrack(() => perimeter);
    const next = nextPerimeterState(previous, position, ring);
    if (next.warning !== previous.warning && next.warning !== 'NONE') {
      // On entering a state, never per ping: a buzz every five seconds for as
      // long as somebody stands outside is something they will learn to ignore.
      navigator.vibrate?.(PERIMETER_VIBRATION[next.warning]);
    }
    perimeter = next;
  });

  /**
   * R-14 and R-29. A player recording contact is the same call a master makes, and
   * it is offered for out-of-zone players too — that is the whole of R-29, since
   * contact is liveness rather than location and the walkie reaches further than
   * the zone does.
   */
  async function noteContact(playerId: string): Promise<void> {
    busy = true;
    try {
      await recordRadioContact(playerId);
    } catch (error) {
      console.error(error);
    } finally {
      busy = false;
    }
  }

</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if payload?.self}
{#snippet eliminateSection()}
    <section>
      <h2>{t.eliminate.title}</h2>
      {#if eliminated}
        <p><strong>{t.eliminate.done}</strong></p>
        <p class="hint">{t.eliminate.doneHint}</p>
        <p class="hint">{t.eliminate.irreversible}</p>
      {:else if canDeclare}
        <p class="hint">{t.eliminate.hint}</p>
        <p class="hint">{t.eliminate.irreversible}</p>
        <button
          type="button"
          class="hold"
          disabled={declaring}
          onpointerdown={() => startHold()}
          onpointerup={() => releaseHold()}
          onpointerleave={() => releaseHold()}
          onpointercancel={() => releaseHold()}
          onkeydown={onHoldKeydown}
          onkeyup={onHoldKeyup}
        >
          {holdStartedAt === null ? t.eliminate.hold : t.eliminate.holding}
        </button>
        <!-- The progress is the whole feedback: a hold with no visible clock is
             indistinguishable from a button that does nothing. -->
        <progress value={holdProgress} max="1"></progress>
        {#if cancelled}
          <p class="hint">{t.eliminate.cancelled}</p>
        {/if}
      {/if}
    </section>
{/snippet}

{#snippet rosterSection()}
    <section>
      <!-- R-21d, read off a meter and on the heading's own line.
           A player who can suddenly see a teammate two zones away deserves to
           know why rather than concluding the zone rules broke — and a machine
           answers that with a signal strength, not with a paragraph. It sits
           beside the heading because it is a property of this whole list: how
           much of it resolves. On a line of its own above it, it read as a
           reading about nothing.

           Always on screen, at all three levels: a reading that only appears
           when it has news is a reading nobody learns. -->
      <div class="section-head">
        <h2>{t.player.roster}</h2>
        <span class="qsa-block">
          <span class="q">{t.q.qsa}</span>
          <Qsa level={signal} label="{t.q.qsa} {signal}/5 — {signalHint}" />
        </span>
      </div>
      <p class="hint qsa-hint">{signalHint}</p>
      {#if roster.length === 0}
        <p>{t.player.noPlayers}</p>
      {:else}
        <!--
          One list, not two tables.

          Seven columns of `nowrap` is wider than a phone however it is wrapped,
          and the two sections it used to be said the quiet part out loud: a
          heading reading FUERA DE TU ZONA over a list of names is the roster
          telling you who you cannot see, which is a worse answer than showing
          them. Everybody is in one list in the order the server sent them —
          R-42 puts same-zone first and the client must not re-sort — and what
          differs is how much of each row resolves.

          Q code labels rather than words. R-29 runs this game on walkies and
          these are the abbreviations already being spoken: QRA the callsign,
          QTH the position, QRB the distance between two stations, QRP low
          power, QSL an acknowledged contact.
        -->
        <ul class="roster">
          {#each roster as other, index (other.id)}
            {@const state = game.linkState(other)}
            {@const accounted = game.accountability(other)}
            {@const mark = stateMark(other, state)}
            <li class:unresolved={other.outOfZone} class:on={selectedPlayer === other.id}>
              <!--
                Every reading about this player inside the one plate that carries
                their name, because the plate is what the selection lights up
                (§9.4) and a reading outside it is a reading the highlight does
                not claim. It was three siblings — name, readings, trail — of
                which only the first was the button, so selecting somebody lit
                a third of their entry and the other two rows floated between
                them and the next player.
              -->
              <button
                type="button"
                class="pick"
                aria-pressed={selectedPlayer === other.id}
                onclick={() => togglePlayer(other.id)}
              >
                <span class="row callsign-row">
                  {#if mark}
                    <span class="mark {mark.brightness}" data-mark={mark.shape}></span>
                  {:else}
                    <!-- No mark rather than `◌`. `stateMark()` refuses to draw one
                         for a withheld position, because `◌` is a claim — *we have
                         lost them* — about somebody who may be walking about with
                         a live feed this viewer is not allowed to see. -->
                    <span class="mark-gap"></span>
                  {/if}
                  <strong>{other.callsign}</strong>
                  <span class="grow"></span>
                  <!-- Only ever drawn for a player already in `NO_LINK`
                       (`accountabilityOf()`), which is what makes it worth the
                       width: the row above says we have lost them and this says
                       somebody has them anyway. `UNACCOUNTED` keeps its words
                       because there is no contact to print in their place. -->
                  {#if accounted === 'ACCOUNTED' && other.radioContact}
                    {@render contact(other.radioContact)}
                  {:else if accounted}
                    <span class="q">{t.q.qsl}</span>
                    <span class="quiet">{t.radio[accounted]}</span>
                  {/if}
                </span>

                <span class="row readings">
                  <span class="q">{t.q.qth}</span>
                  {#if other.position}
                    <!-- The zone, never the coordinate pair. A player says
                         "estoy en Outlet" on the radio; nobody reads out six
                         decimal places at a run, and the zone is what R-42
                         groups by anyway. -->
                    <span>{zoneNameOf(other.position.zoneId)}</span>
                  {:else}
                    <Scramble length={7} seed={index * 2} label={t.player.unknown} />
                  {/if}

                  <span class="q">{t.q.qrb}</span>
                  {#if other.distanceMetres !== undefined}
                    <span>{other.distanceMetres}{t.player.metres}</span>
                  {:else}
                    <Scramble length={4} seed={index * 2 + 1} label={t.player.unknown} />
                  {/if}

                  {#if other.battery !== undefined}
                    <span class="q">{t.q.qrp}</span>
                    <span>{other.battery}{t.units.percent}</span>
                  {/if}
                </span>

                <span class="row trail">
                  {#if other.position}
                    <span class="quiet">
                      {state ? t.state[state] : '—'}
                      {#if state === 'NO_LINK'}
                        · {formatUncertainty(game.uncertaintyMetres(other))}
                      {/if}
                      · {formatAge(other.position.ts, game.serverNow)}
                    </span>
                  {:else if other.radioContact && game.contactFresh(other)}
                    <!-- R-29: contact crosses zone boundaries on purpose, because
                         it is liveness rather than location and the walkie reaches
                         further than the zone does. Freshness only — a withheld
                         position is not silence, so nothing here may call anybody
                         unaccounted.

                         The same snippet the accounted row uses, so the two
                         states of the same fact are written the same way — and
                         this is the row where the reporter's callsign is worth
                         most, because it is the only thing on it. -->
                    {@render contact(other.radioContact)}
                  {/if}
                </span>
              </button>

              <!-- Top-aligned with the callsign, not centred on the plate: two
                   controls beside a three-line block have to say which block
                   they act on, and the name is the only line that identifies
                   it. -->
              <span class="actions">
                {#if other.position}
                  <button
                    type="button"
                    class="show"
                    aria-label={t.map.showOnMap}
                    title={t.map.showOnMap}
                    onclick={() => showOnMap(other.position!)}
                  >
                    <i class="icon" data-icon="recentre"></i>
                  </button>
                {/if}
                <!-- A Q code, not a picture. Two icons were drawn for this and
                     neither read: a walkie is a thin outline of a complicated
                     object at seventeen pixels, and a dot with arcs is the wifi
                     glyph. `QSL` is what the app already calls this exact fact
                     one line above, inside the same plate, and it is what a
                     radio operator says out loud — which makes it the register
                     of the whole screen rather than a borrowed pictogram. Three
                     characters, legible at any size, and still shorter than the
                     `CONTACTO` it replaced. -->
                <button
                  type="button"
                  class="show q"
                  disabled={busy}
                  aria-label={t.players.recordRadio}
                  title={t.players.recordRadio}
                  onclick={() => noteContact(other.id)}
                >
                  {t.q.qsl}
                </button>
              </span>
            </li>
          {/each}
        </ul>
        <!-- Withheld under extended comms, because the two readings disagree on
             screen: a meter at 5 says *your team, anywhere* and this says *you
             only get a callsign from outside your zone*. Both are true — R-21d
             reaches your own team and nobody else's — but a player reads them as
             one claim and the wrong half wins. The noise is its own explanation
             when there is a reason for it on the same panel. -->
        {#if !game.teamReachesOut}
          <p class="hint">{t.player.outOfZoneHint}</p>
        {/if}
        <p class="hint">{t.radio.hint}</p>
      {/if}
    </section>
{/snippet}

<!--
  A radio contact, printed once and rendered twice.

  `QSL` is the whole of what `LOCALIZADO POR RADIO` said — it is the Q code for
  an acknowledged contact and the register the rest of the screen is already in
  (R-29) — so the line spends its width on the two things the label could not
  carry: **when**, and **who heard them**. A contact with neither is a claim
  with no way to judge it: five minutes is a long time on foot, and "somebody
  spoke to BRAVO" is a different report from "you spoke to BRAVO".

  Both ages are derived client-side against `serverNow`, like every other age on
  this screen (R-15), so they keep counting with nothing arriving.
-->
{#snippet contact(record: { ts: number; reportedBy: string })}
  <span class="q">{t.q.qsl}</span>
  <span class="quiet">
    {formatAge(record.ts, game.serverNow)} · {t.radio.by} {reporterName(record.reportedBy)}
  </span>
{/snippet}

{#snippet markersSection()}
    <section>
      <h2>{t.player.marker}</h2>
      <!-- Above the points, and that is the order of authority rather than of
           arrival: a POI is the venue and is there every game, a marker is the
           master saying **go here, now** (R-20b) and expires (R-21c). What was
           put on the screen for you outranks what was always on it.

           Distance and rough time on the same terms as a POI (R-45): a marker is
           somewhere to walk to. The countdown is derived from the TTL timestamp,
           so it runs with nothing arriving from the server (R-15) — and so does
           the disappearance when it reaches zero. -->
      {#if markers.length === 0}
        <p>{t.player.noMarker}</p>
      {:else}
        <ul class="places">
          {#each markers as entry (entry.marker.id)}
            <li class:on={destination === entry.marker.id}>
              <button
                type="button"
                class="place"
                aria-pressed={destination === entry.marker.id}
                onclick={() => toggleDestination(entry.marker.id)}
              >
                <span class="row">
                  <span class="place-name">{entry.marker.label}</span>
                  {#if destination === entry.marker.id}
                    <span class="course">{t.hud.heading}</span>
                  {/if}
                  <span class="grow"></span>
                  {#if Number.isFinite(entry.metres)}
                    <span class="q">{t.q.qrb}</span>
                    <span>{formatDistance(entry.metres)}</span>
                    <span class="quiet"><Eta seconds={entry.seconds} /></span>
                  {/if}
                </span>
                <span class="place-meta">
                  {entry.remaining === undefined
                    ? t.marker.indefinite
                    : `${t.marker.expiresIn} ${formatDuration(entry.remaining)}`}
                </span>
              </button>
              <!-- Its own control, because it is its own request: the row says
                   *I am going there*, this says *show me where that is*. The
                   panel closes with it — a look at the map from behind a sheet
                   covering the map is not a look at anything. -->
              <button
                type="button"
                class="show"
                aria-label={t.map.showOnMap}
                title={t.map.showOnMap}
                onclick={() => showOnMap(entry.marker)}
              >
                <i class="icon" data-icon="recentre"></i>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
{/snippet}

{#snippet poisSection()}
    <section>
      <h2>{t.pois.title}</h2>
      {#if pois.length === 0}
        <p>{t.pois.empty}</p>
      {:else}
        <!-- A list rather than a four-column table, and no coordinates: a point
             is a name and a walk, and the coordinate pair was the column that
             made this wider than the screen it is read on.

             Nothing here is unlocked by being close (R-16, R-18): every POI in
             the payload is listed whether the player is standing on it or a
             kilometre away, and `near` only marks the row. -->
        <ul class="places">
          {#each pois as entry (entry.poi.id)}
            <li class:on={destination === entry.poi.id}>
              <button
                type="button"
                class="place"
                aria-pressed={destination === entry.poi.id}
                onclick={() => toggleDestination(entry.poi.id)}
              >
                <span class="row">
                  <span class="place-name">{entry.poi.name}</span>
                  <!-- Says it in a word, because the plate cannot.
                       §9.4 makes inverse video this interface's only emphasis,
                       so the selected row and the hovered row are painted the
                       same — and a pointer that has just deselected something is
                       still sitting on it. The row went amber, stayed amber, and
                       meant two opposite things. -->
                  {#if destination === entry.poi.id}
                    <span class="course">{t.hud.heading}</span>
                  {/if}
                  <span class="grow"></span>
                  {#if Number.isFinite(entry.metres)}
                    <span class="q">{t.q.qrb}</span>
                    <span>{formatDistance(entry.metres)}</span>
                    <span class="quiet"><Eta seconds={entry.seconds} /></span>
                  {/if}
                </span>
                <span class="place-meta">
                  {t.pois.category[entry.poi.category]}
                  {#if entry.near}· {t.pois.near}{/if}
                </span>
              </button>
              <!-- Its own control, because it is its own request: the row says
                   *I am going there*, this says *show me where that is*. The
                   panel closes with it — a look at the map from behind a sheet
                   covering the map is not a look at anything. -->
              <button
                type="button"
                class="show"
                aria-label={t.map.showOnMap}
                title={t.map.showOnMap}
                onclick={() => showOnMap(entry.poi)}
              >
                <i class="icon" data-icon="recentre"></i>
              </button>
            </li>
          {/each}
        </ul>
        {#if !payload?.self?.position}
          <p class="hint">{t.pois.noPosition}</p>
        {/if}
      {/if}
    </section>
{/snippet}

  <div class="deck">
    <div class="stage">
      <!-- R-48: navigation by default, overview on the toggle inside. The map is
           the view now, not a section of one — a player reads a distance off it
           while walking, and everything else is an annotation on top. -->
      <GameMap
        {frame}
        {dots}
        basemap={payload.basemap}
        config={payload.config}
        viewer="PLAYER"
        self={payload.self.position}
        onPoi={(id) => (id === null ? clearDestination() : toggleDestination(id))}
        selectedPoi={selectedPoi ?? undefined}
        onMarker={(id) => toggleDestination(id)}
        selectedMarker={destination ?? undefined}
        selected={selectedPlayer ?? undefined}
        course={destinationPlace}
        {peek}
        onRecentre={endPeek}
      />

      <!-- Left, above the HUD: the callsign owns the top right and the status
           block sits under it, and a card landing on either covers a reading a
           player takes without looking for it. -->
      {#if selectedPoiEntry}
        <PoiCard
          poi={selectedPoiEntry.poi}
          zones={payload.zones}
          sectors={payload.sectors}
          metres={selectedPoiEntry.metres}
          seconds={selectedPoiEntry.seconds}
          anchor="bottom-left"
          coords={false}
          onclose={() => (selectedPoi = null)}
        />
      {/if}

      <!--
        R-43, and the one thing on this screen that is not part of the fiction.

        §9 puts boundary warnings outside the game aesthetic so they cannot be
        mistaken for game content, and that is carried by **colour and
        typeface** — the alarm colour appears nowhere else in the app, and case
        lettering is the machine speaking rather than the game. Position is a
        separate question, and the honest answer is on the map: a player running
        at night is looking there and nowhere else.

        Non-modal and `pointer-events: none`, because the player may be running
        and must not have to dismiss anything.
      -->
      {#if perimeter.warning !== 'NONE'}
        <div class="edge {perimeter.warning.toLowerCase()}" aria-hidden="true"></div>
        <div class="alert {perimeter.warning.toLowerCase()}" role="status">
          <strong>{t.perimeter.alert}</strong>
          <span>
            {perimeter.warning === 'OUTSIDE' ? t.perimeter.outside : t.perimeter.approaching}
          </span>
          <span>
            {t.perimeter.distance} {formatDistance(perimeter.metres)}
            {#if perimeter.returnBearing !== undefined}
              · {t.perimeter.return} {formatBearing(perimeter.returnBearing)}
            {/if}
          </span>
        </div>
      {/if}

      <!--
        The HUD: what a player needs without touching anything. Own link state
        as §9.7's glyph, the fix's own error, the battery as a quiet label, and
        the nearest POI with its distance (R-18, R-44).

        R-30's declaration is deliberately **not** here. It is irreversible, and
        a control that is always under the thumb on a screen carried at a run is
        a control that gets pressed — the three-second hold guards the gesture,
        and one tap to reach it guards the screen.
      -->
      <!-- QRA, top right: the one thing on screen that says which set this is. -->
      <div class="qra">
        <span class="q">{t.q.qra}</span>
        <strong>{payload.self.callsign}</strong>
      </div>

      <!--
        The status block. It used to be three bare words in the bar and read as
        one — a callsign, a game state and a link state with nothing to say which
        was which. A Q code label per line is what a radio log does, and it is
        the same reason it works here.
      -->
      <div class="status">
        <!-- QTH is the zone, not the coordinate pair — here and in the roster
             and on a point's card. A player says "estoy en Outlet" on the radio;
             nobody reads six decimal places at a run, and the zone is the
             vocabulary the whole game is played in. The master keeps the
             coordinates, which is where they are actually used. -->
        {#if selfZone}
          <div>
            <span class="q">{t.q.qth}</span>
            <span>{selfZone}</span>
          </div>
        {/if}
        <!-- The gauge and not the digit. Every other line here is a reading
             that changes on its own — the zone, the state, the battery — and a
             number that said 5 for the whole game was furniture between them. -->
        <div class="qsa-line">
          <span class="q">{t.q.qsa}</span>
          <Qsa level={signal} label="{t.q.qsa} {signal}/5 — {signalHint}" />
        </div>
        <div>
          <span class="q">{t.q.qrv}</span>
          <span>{t.game.states[payload.game.state]}</span>
        </div>
        {#if payload.self.battery !== undefined}
          <div>
            <span class="q">{t.q.qrp}</span>
            <span>{payload.self.battery}%</span>
          </div>
        {/if}
      </div>

      <div class="hud">
        {#if payload.self.position}
          {@const mark = stateMark(payload.self, game.linkState(payload.self))}
          {#if mark}
            <span class="mark {mark.brightness}" data-mark={mark.shape}></span>
          {/if}
          <span>{formatUncertainty(game.uncertaintyMetres(payload.self))}</span>
          <span class="quiet">{formatAge(payload.self.position.ts, game.serverNow)}</span>
        {:else}
          <span class="mark dim" data-mark="no-link"></span>
          <span>{t.hud.noFix}</span>
        {/if}
        <!-- The destination outranks the nearest point, because one of them was
             asked for. `CERCA` answers "what is that over there" and is the
             right default; once a player has said where they are going, the
             thing they want at a glance is how far it still is — and the line
             on the map is already pointing at it. -->
        {#if destinationPlace}
          <span class="quiet">{t.hud.heading}</span>
          <span>{destinationPlace.label}</span>
          {#if Number.isFinite(destinationPlace.metres)}
            <span>{formatDistance(destinationPlace.metres)}</span>
            <span class="quiet"><Eta seconds={destinationPlace.seconds} /></span>
          {/if}
        {:else if nearestPoi}
          <span class="quiet">{t.hud.nearest}</span>
          <span>{nearestPoi.poi.name} {formatDistance(nearestPoi.metres)}</span>
        {/if}
      </div>

      {#if open}
        <aside class="panel" tabindex="-1" bind:this={panelBox}>
          <div class="panel-head">
            <h2>{PANEL_LABEL[open]}</h2>
            <button
              type="button"
              class="close"
              aria-label={t.panels.close}
              title={t.panels.close}
              onclick={() => (open = null)}>×</button>
          </div>
          <div class="panel-body">
            {#if open === 'NEAR'}
              {@render rosterSection()}
            {:else if open === 'POINTS'}
              {@render markersSection()}
              {@render poisSection()}
            {:else if open === 'OUT'}
              {@render eliminateSection()}
            {/if}
          </div>
        </aside>
      {/if}
    </div>

    <div class="bar">
      <div class="bar-controls">
        <!-- No key badges here, and the keys still work.

             htop prints them because htop is a keyboard program on a machine
             with a keyboard. This is a phone in a hand at a run: the digit is
             furniture for hardware the player is not carrying, and it takes room
             on the one strip that is always on screen. The bindings stay bound —
             a master may open a player's view on a laptop, and Escape is the
             way out of a panel for anybody who has one. -->
        {#each PANELS as id (id)}
          <button type="button" class:on={open === id} onclick={() => togglePanel(id)}>
            {PANEL_LABEL[id]}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}


<style>
  /* The map's row, and the bar's. Nothing here scrolls except a panel's body. */
  .deck {
    position: relative;
    height: 100%;
    display: grid;
    grid-template-rows: 1fr auto;
    overflow: hidden;
  }

  .stage {
    position: relative;
    min-height: 0;
  }

  /**
   * The HUD. Bottom of the map rather than the top, because the top is where
   * R-43's alert goes and a warning must never be the thing that gets covered.
   */
  .hud {
    position: absolute;
    left: calc(0.4ch + var(--safe-left));
    right: calc(0.4ch + var(--safe-right));
    bottom: calc(0.4ch + var(--safe-bottom));
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 1.2ch;
    padding: 0 0.6ch;
    background: var(--overlay-light);
    pointer-events: none;
    z-index: 1;
  }


  /**
   * The two corner blocks. Q code labels in case lettering, values in phosphor:
   * the label is the machine's print and the value is the reading, which is the
   * same distinction the bezel plates make against the tube.
   */
  .qra,
  .status {
    position: absolute;
    right: calc(0.4ch + var(--safe-right));
    background: var(--overlay-light);
    padding: 0 0.6ch;
    pointer-events: none;
    z-index: 1;
  }

  .qra {
    top: calc(0.4ch + var(--safe-top));
    display: flex;
    align-items: baseline;
    gap: 0.8ch;
  }

  .qra strong {
    font-weight: normal;
    letter-spacing: 0.1em;
    color: var(--phosphor-bright);
  }

  /* Above the HUD rather than beside it: the HUD wraps on a narrow screen and
     two blocks sharing a row would interleave. */
  .status {
    bottom: calc(2.2lh + var(--safe-bottom));
    display: grid;
    justify-items: end;
  }

  .status div {
    display: flex;
    align-items: baseline;
    gap: 0.8ch;
  }

  /**
   * The one row whose value is a drawing.
   *
   * `align-items: center` because an SVG has no baseline of its own — a
   * replaced element aligns by its bottom margin edge — so on the block's
   * shared baseline it hangs against the digits above and below it.
   *
   * And a step down in size, which the `font-size` does rather than a height:
   * the component sizes itself in `em`, so this reaches the meter and nothing
   * else — `.q` is `--label-size` in `rem` and a parent's font size cannot
   * touch it. At the block's own size the gauge stood taller than `PREPARACIÓN`
   * beside it and read as the loudest thing in the corner, which it is not:
   * this block is four readings a player takes without looking for them, and
   * the one drawn as a picture must not outrank the three drawn as words.
   *
   * The roster's copy stays large on purpose. There it is the answer to *why
   * does this list look like that* and it is read from further away; here it is
   * one line of four.
   */
  .status .qsa-line {
    align-items: center;
    font-size: 0.62em;
    /**
     * A drawing has no leading, and the rows either side of it do.
     *
     * The block has no row gap and has never needed one: a line of type fills
     * about half its line box and the ascender and descender space keeps one
     * line off the next. An SVG fills its box exactly, so at the same height it
     * arrives with nothing above or below it and sits against `QTH` and `QRV`.
     * This is that missing leading, put back by hand.
     *
     * `rem` and not `em` or `lh`: this row is 0,62 em, so both of those resolve
     * against the size the meter was shrunk to and the padding would shrink
     * with it — the one measurement here that must not follow the font is the
     * gap that stops it touching a different font.
     */
    padding-block: 0.22rem;
  }


  .hud .quiet {
    font-family: var(--label-font);
    font-size: var(--label-size);
    letter-spacing: var(--label-tracking);
    color: var(--phosphor-dim);
  }

  /**
   * The roster. One block per player rather than one row per player, because a
   * row of seven readings is a table and a table is what did not fit.
   *
   * Three lines: who, where, and how long ago. They are separate lines rather
   * than a run of `·` separators so the eye can take the callsign without
   * reading the rest, which is what somebody glancing at a phone mid-game is
   * actually doing.
   */
  .roster {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.6lh;
  }

  .roster li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0 0.8ch;
    padding: 0.2lh 0;
    border-bottom: 1px solid var(--phosphor-deep);
  }

  /**
   * The controls for one entry, at the **top** of it.
   *
   * Centred on a three-line plate they sat level with the readings, which is
   * the one line that does not say whose readings they are. Level with the
   * callsign there is nothing to work out. They keep their 44 px targets; what
   * moves is where the block starts.
   */
  .actions {
    display: flex;
    align-items: flex-start;
    align-self: start;
    gap: 0.2ch;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 0.8ch;
    min-width: 0;
  }

  /* The readings line carries the Q codes, and it wraps rather than scrolls:
     a label and its value stay together because the pair is one flex item's
     worth of gap apart and the next pair is a whole gap away. */
  .readings {
    gap: 0 1.4ch;
  }

  /* Movement and age: the least of the three lines, so the smallest. It is the
     same step the place's type takes, for the same reason. */
  .trail {
    font-size: 0.82em;
  }

  .grow {
    flex: 1;
  }

  .callsign-row strong {
    font-weight: normal;
    letter-spacing: 0.08em;
    color: var(--phosphor-bright);
  }

  /* Keeps the callsigns in a column when the row above has a mark and the row
     below does not — §9.7 draws nothing for a withheld position, and a ragged
     left edge reads as two lists. */
  .mark-gap {
    display: inline-block;
    width: 1.4rem;
    flex: none;
  }

  /**
   * A player §4 withheld. Dimmer, but **present** — the previous arrangement
   * put them under their own heading, which is a list telling you who you are
   * not allowed to see. The row is still a row: the callsign is real, the radio
   * contact is real (R-29), and what cannot be resolved is drawn as noise
   * rather than as a dash.
   */
  .roster li.unresolved strong {
    color: var(--phosphor);
  }

  .roster li.unresolved .q {
    color: var(--phosphor-deep);
  }

  /**
   * The places: markers first, then points. One row, one press.
   *
   * The whole row is the button because the target is a thumb on a phone at a
   * run — a name with a separate little control beside it is two things to aim
   * at, and §9's own obligation about one-handed use is the argument.
   */
  .places {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    /* Wider than the gap inside an entry, and that is the whole rule. A type
       line sitting halfway between two names belongs to neither of them: the
       same failure as a lamp between two switches, and it is fixed the same
       way — by spacing, because nothing else on the row says which way to
       read it. */
    gap: 0.9lh;
  }

  /* The row and its `show me` side by side: one big target for going there, one
     small one for looking at it. */
  .places li {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: start;
  }

  /**
   * The look-at-it control. Square and quiet — it sits beside a row that is
   * already the main target, and a second full-width button would make every
   * entry in the list a pair of decisions.
   */
  .show {
    flex: none;
    width: var(--touch);
    min-width: var(--touch);
    min-height: var(--touch);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid transparent;
    background: transparent;
    color: var(--phosphor-dim);
  }

  .show:hover:not(:disabled),
  .show:focus-visible {
    background: transparent;
    color: var(--phosphor-bright);
  }

  /**
   * The heading and the reading about the list under it, on one line.
   *
   * `space-between` rather than a spacer element: there are exactly two things
   * here and one of them belongs at each end, which is the one case where the
   * shorthand says what is meant.
   */
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1ch;
    /* Air either side, because this row is a boundary rather than a line.
       `.panel-body` pads by 0,6ch and nothing else separated the heading from
       the panel's own title above it or from the first entry below, so three
       different things — a panel title, a section title and a callsign — ran
       down the screen at one spacing and read as one list. */
    margin: 0.6lh 0 0.45lh;
  }

  /**
   * The gauge, a step up from the body.
   *
   * It is read at a glance and from further away than anything else in the
   * panel — it is the answer to *why does this list look like that* — and at
   * body size beside a heading it read as a decoration on the heading. The
   * component sizes itself in `em`, so this one number moves both halves.
   */
  .qsa-block {
    display: flex;
    align-items: center;
    gap: 0.8ch;
    font-size: 1.15rem;
  }

  /* Under the heading it explains, and quiet: somebody reads it once. The gap
     below it is the one that opens the list, so it is the larger of the two. */
  .qsa-hint {
    margin: 0 0 1lh;
  }

  /* Drawn, not lettered: the characters for a reticle are not in VT323, and
     §9.7's marks were already lost to exactly that. Same shape as the map's own
     recentre button, because it is the same gesture aimed at something else. */
  .icon {
    position: relative;
    display: block;
    width: 1.1rem;
    height: 1.1rem;
    flex: none;
  }

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
   * A plate, and everything about one entry is inside it.
   *
   * A stack of lines rather than one wrapping line: the selection lights the
   * plate (§9.4), so anything outside it is a reading the highlight does not
   * claim — and with two entries' worth of rows between two names, a line in
   * the middle belongs to whichever one the spacing says it does, which is the
   * failure this list already had twice.
   *
   * `align-content: start` so the lines stack from the top of the touch target
   * rather than spreading to fill it: the 44 px floor is a thumb's worth of
   * height, not a layout instruction.
   */
  .place,
  .pick {
    display: grid;
    align-content: start;
    width: 100%;
    min-width: 0;
    min-height: var(--touch);
    padding: 0.15lh 0.6ch;
    border: 1px solid transparent;
    background: transparent;
    color: inherit;
    text-align: left;
    text-transform: none;
    letter-spacing: normal;
  }

  .place-name {
    color: var(--phosphor-bright);
  }

  /**
   * The type of the place, **inside** its plate.
   *
   * It was a paragraph under the button, at the same distance from the name
   * above it as the list put between one entry and the next — so it read as
   * belonging to either. Spacing was the first fix and the structure is the
   * real one: a child cannot be ambiguous about its parent, and the selection
   * highlight now covers it, which says the same thing a second way.
   *
   * Smaller because it is the caption and the name is the reading, which is
   * §9.7's brightness channel said in size.
   */
  .place-meta {
    margin: 0;
    font-size: 0.82em;
    color: var(--phosphor-dim);
  }

  /**
   * The destination, said rather than painted.
   *
   * §9.4 makes inverse video the only emphasis this interface has, so the
   * selected row and the hovered row are the same plate — and after a press the
   * pointer is still on the row it just cleared. Amber meant *this is where you
   * are going* and *this is what your finger is on*, which are opposite answers
   * to the only question the list is asked.
   *
   * A word is the fix and not a second colour: there is no second colour to
   * spend (`--alarm` belongs to R-43), the plate has to keep inverting for the
   * hover it still needs to show, and the reading survives a screen in daylight
   * with a thumb over half of it. `currentColor` so the chip inverts with the
   * plate rather than fighting it.
   */
  .course {
    flex: none;
    align-self: center;
    border: 1px solid currentColor;
    padding: 0 0.4ch;
    font-family: var(--label-font);
    font-size: 0.72em;
    letter-spacing: var(--label-tracking);
  }

  /**
   * The one that is selected, in inverse video (§9.4) — which is how this
   * interface emphasises anything, and the reason the alarm colour stays free
   * for R-43. Every child that names its own colour has to give it back, or the
   * plate and the text resolve to the same value in high contrast, where
   * `--phosphor` *is* `--phosphor-bright`.
   */
  .places li.on .place,
  .roster li.on .pick {
    background: var(--phosphor);
    color: var(--screen);
    text-shadow: none;
  }

  .place:hover:not(:disabled),
  .place:focus-visible,
  .pick:hover:not(:disabled),
  .pick:focus-visible {
    background: var(--phosphor);
    color: var(--screen);
    text-shadow: none;
  }

  .places li.on .place .q,
  .places li.on .place .place-name,
  .places li.on .place .place-meta,
  .places li.on .place .quiet,
  .place:hover:not(:disabled) .q,
  .place:hover:not(:disabled) .place-name,
  .place:hover:not(:disabled) .place-meta,
  .place:hover:not(:disabled) .quiet,
  .place:focus-visible .q,
  .place:focus-visible .place-name,
  .place:focus-visible .place-meta,
  .place:focus-visible .quiet,
  .roster li.on .pick .q,
  .roster li.on .pick strong,
  .roster li.on .pick .quiet,
  .roster li.on .pick .mark,
  .pick:hover:not(:disabled) .q,
  .pick:hover:not(:disabled) strong,
  .pick:hover:not(:disabled) .quiet,
  .pick:hover:not(:disabled) .mark,
  .pick:focus-visible .q,
  .pick:focus-visible strong,
  .pick:focus-visible .quiet,
  .pick:focus-visible .mark {
    color: inherit;
  }

  /* Exactly the stage, never the deck: anchored to the deck, a long panel's
     last rows sit under the bar with nothing left to scroll. */
  .panel {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-rows: auto 1fr;
    background: var(--panel);
    z-index: 2;
  }

  /* Focused by script when it opens; a ring around a container nobody
     navigated to reads as a fault. The controls inside keep theirs. */
  .panel:focus,
  .panel:focus-visible {
    outline: none;
  }

  /**
   * The panel spans the glass, so its own row has to clear the corners (R-68b).
   *
   * `.strip` in `Terminal.svelte` takes the allowance because the chin is
   * plastic and it costs no glass there; the tube itself does not, and
   * everything absolutely positioned over it takes its own. A panel is the one
   * surface that was missed, and it is the one where it shows most: CERRAR sits
   * in the right corner of this row, which under a rounded screen in fullscreen
   * is exactly where the glass curves away. The control that closes the panel
   * was the hardest thing on it to press.
   *
   * On the head and the body both, because they are separate grid rows and the
   * body's first column would otherwise start under the curve.
   */
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1ch;
    padding: var(--safe-top) calc(0.6ch + var(--safe-right)) 0 calc(0.6ch + var(--safe-left));
    background: var(--phosphor);
    color: var(--screen);
    text-shadow: none;
  }

  .panel-head button {
    color: var(--screen);
    border-color: var(--screen);
  }

  .panel-head button:hover:not(:disabled),
  .panel-head button:focus-visible {
    background: var(--screen);
    color: var(--phosphor);
  }

  .panel-body {
    overflow: auto;
    /* See `.panel-head`: the panel spans the glass and takes its own allowance
       (R-68b). The bottom inset is on the scroll container rather than on its
       last child, so the final row can be scrolled clear of the chin. */
    padding: 0.6ch calc(0.6ch + var(--safe-right)) calc(0.6ch + var(--safe-bottom))
      calc(0.6ch + var(--safe-left));
    display: grid;
    gap: 1.5lh;
    align-content: start;
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.6ch;
    padding: 0.3ch 0.6ch;
    border-top: 1px solid var(--phosphor-deep);
    /* The bar keeps its own weight rather than the overlay token: it is the
       only chrome that is always on screen, so it is the only one where a map
       showing through is a permanent cost rather than a momentary one. Its own
       weight, not its own ink — `--overlay-ink` is what makes daylight invert
       it, and a literal here is the bar staying a black plate under text that
       has gone dark. */
    background: rgb(var(--overlay-ink) / 0.94);
    z-index: 3;
  }

  .bar-controls,
  .bar-state {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6ch;
  }

  .bar button {
    min-height: var(--touch);
  }

  .bar button.on {
    background: var(--phosphor);
    color: var(--screen);
    border-color: var(--phosphor);
    text-shadow: none;
  }

  .label {
    font-family: var(--label-font);
    font-size: var(--label-size);
    letter-spacing: var(--label-tracking);
    color: var(--phosphor-dim);
  }

  /**
   * R-43's alert, on the map and above everything except the panel.
   *
   * §9 keeps boundary warnings outside the game aesthetic so they cannot be
   * mistaken for game content, and what carries that is **colour and typeface**
   * — the alarm colour appears nowhere else in the app and case lettering is the
   * machine speaking. Being on the map is a separate question, and the answer is
   * where a player running at night is already looking.
   */
  .alert {
    position: absolute;
    top: calc(0.4ch + var(--safe-top));
    left: calc(0.4ch + var(--safe-left));
    right: calc(0.4ch + var(--safe-right));
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 1ch;
    padding: 0.2ch 0.6ch;
    font-family: var(--case-font);
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--alarm);
    background: var(--overlay);
    border: 1px solid var(--alarm);
    text-shadow: none;
    pointer-events: none;
    z-index: 1;
  }

  .alert.outside {
    color: var(--screen);
    background: var(--alarm);
  }

  /* **Not phosphor.** The approach edge used to be #ffb000, which is the colour
     of every piece of game content on the screen — exactly what §9 rules out
     when it puts R-43 outside the game aesthetic. Both edges are the alarm
     colour now, and they are told apart by width and by a dashed versus solid
     stroke rather than by hue, so the distinction survives a colour-blind
     player and an amber tube at night. */
  .edge.approaching {
    border: 6px dashed var(--alarm);
  }
  .edge.outside {
    border: 12px solid var(--alarm);
  }
  .hint {
    color: var(--phosphor-dim);
  }
  /* Big enough to hit while moving, and `touch-action: none` so holding it does
     not scroll the page out from under the gesture on a phone. */
  .hold {
    padding: 1ch;
    min-width: 24ch;
    min-height: calc(var(--touch) * 1.4);
    touch-action: none;
    user-select: none;
  }
  /* Drawn in terminal.css like every other control; what is left here is where
     it sits. `accent-color` used to be the whole of its styling and does
     nothing now — `appearance: none` takes the widget apart before it gets a
     say. */
  progress {
    display: block;
    width: 24ch;
    margin-top: 0.5lh;
  }
</style>

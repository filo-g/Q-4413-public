<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type {
    Audience,
    CommsReach,
    GameState,
    MasterMarker,
    ViewMode,
  } from '@q4413/shared';

  import {
    addPlayer,
    addTeam,
    clearMarker,
    fetchInvites,
    movePlayerToTeam,
    logout,
    MarkerRejected,
    pairDevice,
    placeMarker,
    setCommsReach,
    recordRadioContact,
    removePlayer,
    removeTeam,
    renameTeam,
    resetGame,
    revivePlayer,
    RosterRejected,
    setCutSwitch,
    setDisabledZones,
    setPoiVisibility,
    setGeoProfile,
    setGameState,
    setViewMode,
    type Invite,
  } from '../../api.ts';
  import { MARKER_MAX, replayAllowed } from '@q4413/core';
  import { claimsFocus } from '../../chrome/claimsFocus.ts';
  import { draggable } from '../../chrome/draggable.ts';
  import { display } from '../../display.svelte.ts';
  import PoiCard from '../../chrome/PoiCard.svelte';
  import Select from '../../chrome/Select.svelte';
  import { download } from '../../download.ts';
  import { slug, stamp, trackFileName } from '../../export.ts';
  import { recorder } from '../../recorder.svelte.ts';
  import { replay } from '../../replay.svelte.ts';

  import {
    eventDetail,
    formatAge,
    formatClock,
    formatCoords,
    formatDuration,
    formatUncertainty,
    placeName,
  } from '../../format.ts';
  import { game } from '../../game.svelte.ts';
  import Qsa from '../../chrome/Qsa.svelte';
  import { stateMark } from '../../glyphs.ts';
  import { t } from '../../i18n.ts';
  import { keyLabel, matchBinding, type Binding } from '../../keys.ts';
  import GameMap from '../../map/GameMap.svelte';
  import { dotsOf, frameOf, zonesOutOfPlay } from '../../map/frame.ts';

  /**
   * Master view over a projected payload. OPERATIONAL by default (R-22).
   *
   * Everything mode-gated reads `game.viewMode` and never `payload.viewMode`: the
   * first is the mode in force now, the second is the mode the snapshot was built
   * in, and R-25's revert happens between them without a message arriving.
   */
  const VIEW_MODES: ViewMode[] = ['OPERATIONAL', 'AUTHORITATIVE'];
  /**
   * The bundled geometries (§11). Listed here rather than fetched: they ship in
   * the Worker bundle, so the set cannot change without a deploy that also
   * rebuilds this.
   */
  const GEO_PROFILES = ['madrid', 'barcelona', 'sevilla'] as const;
  const STATES: GameState[] = ['PREPARATION', 'IN_PROGRESS', 'PAUSED', 'FINISHED'];

  /**
   * The name of a geo profile, for the one place that has to print the *current*
   * one rather than offer the two we ship.
   *
   * `payload.geoProfile` is `string | undefined` and stays that way on purpose:
   * the server seeds it from a constant and a game created before that constant
   * existed has none, so the type is telling the truth. Falling back to the id
   * rather than to a dash means a profile the locale has not been taught still
   * says which one it is.
   */
  const profileName = (id: string | undefined): string =>
    (id ? (t.geo.profiles as Record<string, string | undefined>)[id] : undefined) ?? id ?? '—';

  /**
   * Replay is a clock, not a mode (R-53), and these two lines are the whole of
   * that claim in the panel: **one** payload and **one** clock, either live or
   * as of the cursor, and everything below reads them without knowing which.
   * The map, the roster, the marker list and the log are the same code in both.
   *
   * `game.viewMode` deliberately stays out of it. R-25's revert runs on real
   * time whatever the cursor is doing — a replay that could hold AUTHORITATIVE
   * open would be a way around the requirement rather than a feature.
   */
  /**
   * Which overlay panel is open, or none.
   *
   * Grouped by what the master is doing rather than by which requirement
   * introduced each section: `TEAM` is everything about people — the roster,
   * teams, the unpaired tray and the invite links — and `GAME` is everything
   * about the game itself. A panel per section would put fifteen buttons on a
   * bar that has to be usable one-handed, at night, with the other hand holding
   * a radio.
   *
   * One at a time, and that is the point: the map is underneath, and two panels
   * open at once is the scrolling document this replaced.
   */
  type Panel = 'TEAM' | 'GAME' | 'MARKS';

  /**
   * The log and the replay are on the bar and are **not** panels.
   *
   * A panel takes the stage and closes the one before it, which is right for a
   * place you go to do one thing and come back from. These two are the
   * opposite: they are what you watch *while* doing something else, and a
   * record you have to close to see the thing it is a record of is a record you
   * stop opening. So they are docks in their own row of the deck — full width,
   * a few lines tall, the map shortened above them rather than covered — and
   * they are independent of whichever panel is open.
   *
   * **REPETICIÓN moved here from the stage (R-62)**, and the requirement is
   * about the map rather than about tidiness: a replay whose controls cover the
   * map is one the master scrubs blind. Everything a replay changes is on the
   * ground, so the cursor has to be somewhere the ground is still visible from.
   */
  type Dock = 'LOG' | 'REPLAY';
  type BarId = Panel | Dock;

  /** The two that dock rather than take the stage. */
  const DOCKS: readonly BarId[] = ['LOG', 'REPLAY'];
  const isDock = (id: BarId): id is Dock => DOCKS.includes(id);

  /**
   * The bar, with its keys. Digits in bar order, so the strip reads the way a
   * function-key row does and the number on screen is the number to press.
   */
  /**
   * The bar, grouped by what the master is doing and numbered in reading order.
   *
   * `who` is the people and the game they are in; `record` is what has already
   * happened; `where` is the ground. Grouping is not decoration — a row of
   * eight equally spaced buttons is a row you read left to right every time,
   * and a row in three blocks is one you aim at.
   */
  type Group = 'who' | 'record' | 'where';

  const PANELS: Array<{ id: BarId; key: string; group: Group }> = [
    { id: 'TEAM', key: '1', group: 'who' },
    { id: 'GAME', key: '2', group: 'who' },
    { id: 'LOG', key: '3', group: 'record' },
    { id: 'MARKS', key: '4', group: 'where' },
    // Last, and with the last number, because it is the one control that is not
    // always there: R-57 keeps it out of OPERATIONAL, so any earlier number
    // would leave a hole in the strip — `1 2 3 5` reads as a key that stopped
    // working rather than as a control that is absent.
    //
    // Filed under `where` even though it docks like the log, and the two facts
    // are answers to different questions. It **docks** because its subject is
    // the map and a control over the map is a control you cannot aim (R-62). It
    // is filed under `where` because R-53 is explicit that replay is **a clock,
    // not a mode**: it is this map with its `serverNow` moved, not a second
    // record of what happened, and every derivation it drives is the one
    // already on screen.
    { id: 'REPLAY', key: '5', group: 'where' },
  ];

  const panelsIn = (group: Group): Array<{ id: BarId; key: string; group: Group }> =>
    PANELS.filter((entry) => entry.group === group && (entry.id !== 'REPLAY' || replayable));

  /** The marker window and the two view modes, keyed by their own initials. */
  const MARKER_KEY = 'm';
  /**
   * R-68c on this view. The master gets the key and not the floating button: a
   * control drawn over the map is furniture for a phone held in one hand, and
   * this bar already has room and a legend.
   */
  const FULLSCREEN_KEY = 'f';
  const MODE_KEYS: Record<ViewMode, string> = { OPERATIONAL: 'o', AUTHORITATIVE: 'a' };

  const PANEL_LABEL: Record<BarId, string> = {
    TEAM: t.panels.team,
    GAME: t.panels.game,
    MARKS: t.panels.marks,
    LOG: t.panels.log,
    REPLAY: t.panels.replay,
  };

  let open = $state<Panel | null>(null);

  /**
   * Which dock is up, independently of `open`.
   *
   * **One at a time**, which the log alone never had to decide. Two docks are
   * two rows of the deck, and the map — the interface, not a picture of one —
   * gets what is left. The replay's own controls are a reason to be reading the
   * log and vice versa, but not at the same moment, and the bar makes swapping
   * one keystroke.
   */
  let dock = $state<Dock | null>(null);

  const live = $derived(game.payload);
  const payload = $derived(replay.payloadFor(live) ?? live);
  const now = $derived(replay.active ? replay.cursor : game.serverNow);

  /**
   * Which dot is selected, and therefore whose card is open.
   *
   * The map is the interface, so a person's detail has to be reachable **from
   * the person** — the roster table was the only way to read a battery or record
   * a radio contact, and it is now one of two. The selection is a key rather
   * than a record: the payload is replaced on every snapshot, so holding the
   * object would freeze the card at the moment it was opened.
   */
  let selected = $state<string | null>(null);

  const selectedPlayer = $derived(payload?.players.find((p) => p.id === selected));

  /**
   * Which point is open, if any. A separate slot from `selected`: a dot is a
   * person and a diamond is a place, and the two cards answer different
   * questions — so opening one must not close the other.
   */
  let selectedPoi = $state<string | null>(null);

  /**
   * Where the camera has been asked to go, or nothing.
   *
   * A **new object per press**, never a mutation: asking twice for the same
   * player is a real request — you panned away and want to go back — and object
   * identity is what makes the second one arrive. `null` between presses would
   * work too and buys nothing; leaving the last target in place costs a stale
   * pair that nothing reads.
   */
  let focus = $state<{ lon: number; lat: number } | undefined>(undefined);

  /**
   * Take me to them, from the roster.
   *
   * It selects as well as centres, because the two are one intention: a name
   * picked out of a list is a person you are about to look at, and arriving at
   * an unlit dot in a venue full of dots is arriving nowhere in particular.
   */
  function locate(player: { id: string; position?: { lon: number; lat: number } }): void {
    if (!player.position) return;
    selected = player.id;
    focus = { lon: player.position.lon, lat: player.position.lat };
  }

  /**
   * The same gesture as the roster's reticle, aimed at a place instead of a
   * person: put the camera on it and open its card.
   *
   * This button used to pre-fill the marker form's coordinates from the point,
   * which answered a question nobody was asking at the time — the master is
   * looking down a list of 34 names for one they are about to say on the radio,
   * and what they need is *where is it*. The form still gets a coordinate from
   * the map, through `TOMAR DEL MAPA`, which is the control that exists for it.
   */
  function locatePoi(poi: { id: string; lon: number; lat: number }): void {
    selectedPoi = poi.id;
    focus = { lon: poi.lon, lat: poi.lat };
    // The panel is the rail and the map is beside it, but on a phone the rail
    // *is* the screen — so looking at the map from behind a sheet covering it
    // is not looking at anything. Same contract as the player's own
    // show-me-on-the-map.
    open = null;
  }

  /** The same, for a marker, which has coordinates and no record to select. */
  /**
   * Take the camera to a sector (R-71), which is the other half of the lookup.
   *
   * The highlight answers *which ground is this row* while the master is
   * looking at the map; this answers it when the sector is off screen, which
   * with two towns and 2,85 km between their centres is most of the time at any
   * useful zoom. The centre of the bounding box of its zones, not a centroid —
   * the camera is being aimed, not measured.
   */
  /** The centre of the bounding box of some zones, or nothing if none are drawn. */
  function centreOfZones(zoneIds: readonly string[]): { lon: number; lat: number } | undefined {
    const wanted = new Set(zoneIds);
    const ring = (payload?.zones ?? [])
      .filter((zone) => wanted.has(zone.id))
      .flatMap((zone) => zone.geometry.coordinates[0] ?? []);
    if (ring.length === 0) return undefined;
    const lons = ring.map(([lon]) => lon!);
    const lats = ring.map(([, lat]) => lat!);
    return {
      lon: (Math.min(...lons) + Math.max(...lons)) / 2,
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    };
  }

  function locateSector(sectorId: string): void {
    const centre = centreOfZones(sectors.find((s) => s.id === sectorId)?.zoneIds ?? []);
    if (!centre) return;
    // Chosen, not pointed at: this survives the sheet closing behind it.
    pinnedPlace = true;
    highlightSector = sectorId;
    highlightZone = null;
    focus = centre;
    // On a phone the rail is the screen, so looking at the map from behind a
    // sheet covering it is not looking at anything. Same as locatePoi().
    open = null;
  }

  function locateZone(zoneId: string): void {
    const centre = centreOfZones([zoneId]);
    if (!centre) return;
    pinnedPlace = true;
    highlightZone = zoneId;
    focus = centre;
    open = null;
  }

  function locatePoint(lat: number, lon: number): void {
    focus = { lon, lat };
    open = null;
  }

  const selectedPoiRecord = $derived(payload?.pois.find((poi) => poi.id === selectedPoi));

  /** A point that has left the projection must not leave a card describing it. */
  $effect(() => {
    if (selectedPoi && !selectedPoiRecord) selectedPoi = null;
  });

  /**
   * A tray device can be selected too — it is a dot on the map like any other,
   * and "which phone is that" is a master's question during pairing.
   */
  const selectedDevice = $derived(payload?.tray?.find((entry) => entry.deviceId === selected));

  /** A selection whose dot has gone must not leave a card describing nobody. */
  $effect(() => {
    if (selected && !selectedPlayer && !selectedDevice) selected = null;
  });

  const pairTargets = $state<Record<string, string>>({});
  /**
   * The invite links, fetched when asked for and not before.
   *
   * They used to load at mount and sit in a table on every master screen. An
   * invite path is a credential — it is what turns a browser into a named player
   * — and it is needed twice a game, when somebody's phone is in the master's
   * hand. Behind a button it is one tap away and off the screen the rest of the
   * time, which is the right trade for something that is read out loud.
   */
  let invites = $state<Invite[]>([]);
  let showInvites = $state(false);
  let copied = $state<string | null>(null);
  let busy = $state(false);

  /**
   * Roster editing (R-07). Gated on game state, never on view mode: AUTHORITATIVE
   * differs from OPERATIONAL on exactly one axis (R-22), and hiding setup behind a
   * mode that exists to spoil the game would be the wrong door.
   */
  let newCallsign = $state('');
  let newFullName = $state('');
  /** Absent means "the first team", which is what the server does with no teamId. */
  let newTeamId = $state('');

  /**
   * Keeps the team select showing a team.
   *
   * `''` is what the API takes to mean "the first team", and it is also a value
   * no `<option>` carries — so the control rendered blank, which says nothing
   * about where the player is about to be put. Pinning it to a real id makes
   * the screen state what the server was going to do anyway.
   *
   * It also repairs a stale selection: deleting the chosen team would otherwise
   * leave the same blank control, and the next submission would land somewhere
   * the master did not pick.
   */
  $effect(() => {
    const teams = payload?.teams ?? [];
    const first = teams[0];
    if (!first) return;
    const current = untrack(() => newTeamId);
    if (!teams.some((team) => team.id === current)) newTeamId = first.id;
  });
  let newTeamName = $state('');
  let rosterError = $state<string | null>(null);
  let lastInvite = $state<string | null>(null);
  const configurable = $derived(payload?.game.state !== 'IN_PROGRESS');

  /**
   * Whether setup is what the master is doing, which is a narrower question than
   * whether the server would accept an edit.
   *
   * `configurable` is the server's rule and stays on every control's `disabled`.
   * This one decides what is on screen at all: adding a player, renaming a team
   * and handing out invite links are things that happen before a game and
   * between halves, and a FINISHED game is neither. Outside these two states the
   * forms are not disabled, they are gone — the roster is a list to read while
   * the game runs, and a form nobody is going to fill in is just a taller list.
   */
  const setupPhase = $derived(
    payload?.game.state === 'PREPARATION' || payload?.game.state === 'PAUSED',
  );

  /**
   * The roster, grouped by team.
   *
   * A team column repeated down forty rows says the same word forty times; a
   * heading says it once and the indent carries it. Teams with nobody in them
   * are left out — the teams list below is where a team's existence is managed,
   * and an empty heading here would be a row about nothing.
   *
   * The trailing group catches a player whose `teamId` matches no team. It
   * should never happen, and if it does the player still has to be visible:
   * dropping them silently would hide somebody who is on the ground.
   */
  const teamGroups = $derived.by(() => {
    if (!payload) return [];
    const groups = payload.teams
      .map((team) => ({
        id: team.id,
        name: team.name,
        players: payload.players.filter((p) => p.teamId === team.id),
      }))
      .filter((group) => group.players.length > 0);
    const known = new Set(payload.teams.map((team) => team.id));
    const orphans = payload.players.filter((p) => !p.teamId || !known.has(p.teamId));
    if (orphans.length > 0) groups.push({ id: '', name: t.teams.none, players: orphans });
    return groups;
  });

  /** The server names the reason; this turns it into Spanish, or says so plainly. */
  function rosterMessage(reason: string): string {
    const messages: Record<string, string> = t.roster.errors;
    return messages[reason] ?? t.roster.errors.UNKNOWN;
  }

  async function addToRoster(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    rosterError = null;
    busy = true;
    try {
      const created = await addPlayer(newCallsign, newFullName, newTeamId || undefined);
      lastInvite = typeof created.path === 'string' ? created.path : null;
      newCallsign = '';
      newFullName = '';
    } catch (error) {
      rosterError = error instanceof RosterRejected ? error.reason : 'UNKNOWN';
      if (!(error instanceof RosterRejected)) console.error(error);
    } finally {
      busy = false;
    }
  }

  /** One wrapper for every roster call, so the error handling exists once. */
  async function rosterAction(action: () => Promise<unknown>): Promise<void> {
    rosterError = null;
    busy = true;
    try {
      await action();
    } catch (error) {
      rosterError = error instanceof RosterRejected ? error.reason : 'UNKNOWN';
      if (!(error instanceof RosterRejected)) console.error(error);
    } finally {
      busy = false;
    }
  }

  function wipeGame(): void {
    const name = payload?.game.name ?? '';
    // Typing the name back, not an OK button: this is the one control with no
    // undo, and `match` is what makes the accept refuse until it is typed.
    request({
      title: t.reset.title,
      lines: [t.reset.prompt, t.reset.hint],
      accept: t.reset.button,
      danger: true,
      input: { label: t.game.name, value: '', match: name },
      run: async (typed) => {
        await rosterAction(async () => {
          const archive = await resetGame(typed);
          // Straight to disk before anything is confirmed as lost: the reset
          // deletes the storage this came from, so it is the only copy. It uses
          // R-65's saver rather than its own — the second copy of that anchor
          // dance was where this one still revoked the object URL in the same
          // task, which Safari answers by cancelling the download.
          download(
            new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }),
            `q4413-${slug(name)}-${stamp(Date.now())}.json`,
          );
          await game.reload();
        });
      },
    });
  }

  async function createTeam(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await rosterAction(async () => {
      await addTeam(newTeamName);
      newTeamName = '';
    });
  }

  function rename(teamId: string, current: string): void {
    request({
      title: t.teams.rename,
      lines: [t.teams.renamePrompt],
      accept: t.teams.rename,
      input: { label: t.teams.name, value: current },
      run: async (name) => {
        if (!name || name === current) return;
        await rosterAction(() => renameTeam(teamId, name));
      },
    });
  }

  function dropTeam(teamId: string, name: string): void {
    request({
      title: t.teams.remove,
      lines: [`${t.teams.confirm} ${name}`],
      accept: t.teams.remove,
      danger: true,
      run: async () => {
        await rosterAction(() => removeTeam(teamId));
      },
    });
  }

  function dropFromRoster(playerId: string, callsign: string): void {
    // Blocking, because it revokes an invite link that has already been handed to
    // somebody and there is no undo that gives it back.
    request({
      title: t.roster.remove,
      lines: [`${t.roster.confirm} ${callsign}`],
      accept: t.roster.remove,
      danger: true,
      run: () => dropFromRosterNow(playerId),
    });
  }

  async function dropFromRosterNow(playerId: string): Promise<void> {
    rosterError = null;
    busy = true;
    try {
      await removePlayer(playerId);
      if (lastInvite) lastInvite = null;
    } catch (error) {
      rosterError = error instanceof RosterRejected ? error.reason : 'UNKNOWN';
      if (!(error instanceof RosterRejected)) console.error(error);
    } finally {
      busy = false;
    }
  }

  /**
   * R-57 and R-25 meeting. The window in hand was fetched under a permission, so
   * when that permission goes — the mode lapses, or is put back to OPERATIVA by
   * hand — the replay has to go with it, or the panel would keep rendering full
   * detail from a buffer the server would no longer serve. Closing it is the
   * whole of the fix: the next frame reads the live payload, which has already
   * been reprojected.
   *
   * `replayable` rather than `authoritative`, since R-57b: in a finished game
   * the permission does not depend on the mode, so neither may this. Reading the
   * mode here would close a debrief the server is still answering, on a
   * transition that changed nothing about it.
   */
  $effect(() => {
    // The active flag is read through untrack, or this effect depends on state
    // it writes and schedules itself a second time on every close. `replayable`
    // is the only trigger that should reach it, and it is the only dependency.
    if (!replayable && untrack(() => replay.active)) replay.close();
  });

  /**
   * The replay dock goes with the permission, for the same reason its button is
   * only on the bar under one: leaving it open would leave a master staring at
   * controls the server has stopped answering.
   */
  $effect(() => {
    if (!replayable && untrack(() => dock) === 'REPLAY') dock = null;
  });

  /**
   * R-64. The selected player's route, and it is computed here rather than in
   * the map for the reason the milestone records as its risk: a route exists
   * only during a replay, so it is the first thing that does — and `GameMap`
   * must not learn that a replay is running. It is handed over as frame
   * furniture, like the drop points beside it, and `routeFor()` answers `[]`
   * live so there is no condition on this line either.
   */
  const route = $derived(replay.routeFor(selected, payload?.config.linkThresholdMs ?? 0));

  /**
   * R-65's first file: the window already in memory, written to disk.
   *
   * No request — the whole window was fetched when the replay opened, so this
   * costs nothing and works with the link down, exactly as scrubbing does.
   */
  function exportTrack(): void {
    const window = replay.window;
    if (!window || !live) return;
    download(
      new Blob([JSON.stringify(window)], { type: 'application/json' }),
      trackFileName(live.game, window.from),
    );
  }

  /**
   * R-65b: starting a recording starts the replay.
   *
   * A recording that begins on a paused cursor is a still photograph taken with
   * a video camera. The master has just pressed the one button whose entire
   * purpose is to produce something to show somebody, so "what is on screen
   * now" is not what they asked for — and they cannot press PAUSA's mark
   * afterwards to fix it, because R-65 hides the dock for the duration.
   *
   * **After the picker, not before.** `getDisplayMedia` puts a dialog in front
   * of the master for as long as they take to choose a tab, and a cursor moving
   * behind it is a cursor spending the opening of the recording on a permission
   * prompt.
   *
   * Only if a recording actually started: cancelling the picker arrives here as
   * `recording === false`, and a cancelled recording that left the replay
   * playing would be the button doing half of something it did not do.
   *
   * Nothing to guard at the end of the window — `#tick()` reaches `to`, finds
   * the game finished and pauses again on the next tick, which is the same
   * frame the recording was going to get anyway.
   */
  async function startRecording(game: { name?: string; id?: string }): Promise<void> {
    await recorder.start(game);
    if (recorder.recording && replay.active && !replay.playing) replay.play();
  }

  const projectedFrame = $derived(payload ? frameOf(payload, now, route) : null);
  const dots = $derived(payload ? dotsOf(payload, now, payload.tray ?? []) : []);

  /**
   * Points the master has hidden, and it is **a display filter and nothing
   * else**.
   *
   * A venue carries tens of points, which is the right number for the ground
   * and too many for a map somebody is reading at a glance on a walkie.
   * Hiding one takes it off **every** map, this master's included, and it stays
   * off across a reload (R-61).
   *
   * It used to be a `$state` array here and nowhere else, and the docblock this
   * replaces argued for that: R-16 to R-18 decide which points a player may see,
   * and a control on a reading table that changed it would be a master editing
   * the game. What that reasoning missed is that hiding a point on one screen
   * is not neutral either — a second master saw a different venue, and a refresh
   * silently undid the decision. R-61 makes it the server's, which is what makes
   * it the same for everyone and auditable afterwards.
   *
   * The list comes back only in a master's payload. A player is told what they
   * can see, never what is being kept from them: sending this to one would be a
   * list of the places they are not being shown, which is more than the
   * unfiltered list ever was.
   */
  const hiddenPois = $derived(payload?.hiddenPois ?? []);

  const isHidden = (id: string): boolean => hiddenPois.includes(id);

  async function toggleHidden(id: string): Promise<void> {
    await guarded(() => setPoiVisibility(id, !isHidden(id)));
  }

  /**
   * The frame as drawn, which is the projected one minus what this master has
   * put away. Every consumer takes this: a point hidden from the map and still
   * on the schematic beside it would read as two maps disagreeing.
   */
  const frame = $derived.by(() => {
    if (!projectedFrame) return projectedFrame;
    /**
     * Both subtractions happen here and neither happens on the server.
     *
     * `project()` hands a master every point and every zone, plus the two
     * decisions in force — R-61's hidden list and R-71's closed set — because a
     * replay has to be able to put back what is closed *now* in order to show
     * what was open *then*. So the panel renders the consequence, and the same
     * frame feeds the map and the schematic: a point off one and on the other
     * would read as two maps disagreeing.
     */
    const closedZones = new Set(disabledZones);
    const pois = projectedFrame.pois.filter(
      (poi) => !isHidden(poi.id) && !(poi.zone !== undefined && closedZones.has(poi.zone)),
    );
    const dropped = zonesOfShutDistricts;
    const zones =
      dropped.size > 0
        ? projectedFrame.zones.filter((zone) => !dropped.has(zone.id))
        : projectedFrame.zones;
    return { ...projectedFrame, pois, zones };
  });
  // Still subtracted here, and it has to be: `project()` hands a master **every**
  // point, hidden ones included, because the list in the panel is the only place
  // one can be found again and turned back on. What changed is where the set
  // comes from — the payload rather than this browser.

  /** Which point the master is pointing at in the table, highlighted on the schematic. */
  let highlightPoi = $state<string | null>(null);

  /**
   * R-71's list, and the lookup that makes it usable.
   *
   * A dozen sectors, and the map has no names on it — §14.3 leaves it one
   * symbol layer and that one draws the basemap's streets, not the game. A
   * master who has never walked the ground cannot tell one dashed outline from
   * another, which makes closing one a guess. So pointing at a row lights its ground, exactly as pointing at a
   * point lights the point.
   *
   * Two things feed it, because a master asks the question in both directions:
   * *which ground is this row?* while deciding what to close, and *where is
   * this player?* while reading the roster. The second is why `highlightSector`
   * takes a sector id rather than the hovered row's index.
   */
  let highlightSector = $state<string | null>(null);

  /**
   * One zone of one sector, for the rows nested under it.
   *
   * Separate from `highlightSector` rather than folded into it: a sector may be
   * ten zones, and "which of these is the car park" is a different question
   * from "which ground is this sector". Pointing at the sector lights all ten;
   * pointing at a zone lights that one.
   */
  let highlightZone = $state<string | null>(null);

  /**
   * Whether the lit ground was **chosen** rather than merely pointed at.
   *
   * The two are different claims and only one of them should survive the panel
   * closing. Hovering a row is a preview: it belongs to the pointer, and the
   * pointer is about to be somewhere else. Tapping one is a selection — on a
   * phone it also closes the sheet, because the rail *is* the screen there, and
   * the highlight is most of what the tap was for.
   *
   * Written down because the DOM cannot be asked. `mouseleave` never fires on an
   * element that is unmounted while the pointer is over it, so closing MAPA with
   * a row under the cursor left its ground lit on the map with nothing left on
   * screen to explain why, until somebody reopened the panel and hovered
   * something else.
   */
  let pinnedPlace = $state(false);

  const sectors = $derived(payload?.sectors ?? []);
  const districts = $derived(payload?.districts ?? []);
  const disabledZones = $derived(payload?.disabledZones ?? []);

  /** Closed means the **zone** is closed (R-71). A sector is closed when all of its are. */
  const isClosed = (id: string): boolean => disabledZones.includes(id);

  /**
   * The zones of the sector being pointed at. Empty when nothing is, which is
   * the normal case and costs one empty `Set` per frame in the map.
   */
  const highlightZoneIds = $derived(
    highlightZone !== null
      ? [highlightZone]
      : (sectors.find((sector) => sector.id === highlightSector)?.zoneIds ?? []),
  );

  /** Every zone by id, for the rows under a sector and for aiming the camera. */
  const zonesById = $derived(new Map((payload?.zones ?? []).map((zone) => [zone.id, zone] as const)));

  /**
   * The zones of the closed sectors, which a master's payload still carries
   * (R-71) so this list has ground to point at. Drawn out of play rather than
   * drawn: see `closedZoneIds` on `GameMap`.
   */
  const closedZoneIds = $derived(disabledZones);

  /**
   * A district with every sector closed is not drawn at all (R-71).
   *
   * A closed *sector* stays on the master's map, dim, because the row naming it
   * has to have ground to point at. A closed **town** does not: thirteen dim
   * outlines around somewhere nobody is playing is the map describing what is
   * not happening, at the scale where it costs the most — the two towns are
   * 2,85 km apart, so the district that is still open is the smaller half of
   * the frame and the empty one crowds it.
   *
   * The whole district is one press to reopen, so nothing is lost by its rows
   * having nothing to light — except while the master is actually pointing at
   * one, which is the exception below. That keeps the list an index rather than
   * a list of names that do nothing.
   */
  const zonesOfShutDistricts = $derived(
    zonesOutOfPlay(districts, sectors, disabledZones, highlightZoneIds),
  );

  /**
   * Which sector a player is standing in, for the roster's own highlight.
   *
   * Through the zone rather than from the player, because `ProjectedPlayer`
   * carries a `zoneId` and nothing above it — §4 scopes by zone and the sector
   * is a grouping of zones, so the panel is the right place to walk the one
   * step up rather than a second field on the wire.
   */
  const sectorOfZone = $derived(
    new Map(sectors.flatMap((sector) => sector.zoneIds.map((id) => [id, sector.id] as const))),
  );

  /**
   * Pointing at a row, which is a preview and never a selection.
   *
   * One helper rather than four pairs of inline handlers, because the thing that
   * has to be true of all of them is the same: a preview un-pins whatever a tap
   * pinned, so the last deliberate choice does not outlive somebody running the
   * mouse down the list on the way to something else.
   */
  function pointAt(level: 'sector' | 'zone', id: string | null): void {
    pinnedPlace = false;
    if (level === 'sector') highlightSector = id;
    else highlightZone = id;
  }

  /**
   * Closing MAPA takes the preview off the map with it (R-71).
   *
   * `mouseleave` never fires on an element unmounted under the pointer, so
   * without this a row hovered at the moment the panel closed left its ground
   * lit with nothing on screen to say why. An effect rather than a line in each
   * close path, because there are five of them — the × , Escape, the bar's own
   * button, switching to another panel, and `locateSector()` itself.
   *
   * That last one is why the pin exists: on a phone the rail is the screen, so
   * tapping a row closes the sheet, and clearing the highlight there would undo
   * the tap. A chosen place survives; a pointed-at one does not.
   */
  $effect(() => {
    if (open === 'MARKS' || pinnedPlace) return;
    untrack(() => {
      highlightSector = null;
      highlightZone = null;
    });
  });

  /**
   * The whole set, every time (R-71), and **one function for all three levels**.
   *
   * A zone's eye passes one id, a sector's passes its zones, a district's passes
   * every zone under it — so sector and district are group controls and nothing
   * more. Neither word reaches the server, and there is nothing here that can
   * disagree with itself about what is closed: this says what the answer is
   * rather than how it changed.
   *
   * `shut` is passed in rather than recomputed, because the caller already knows
   * it and the two must not be able to differ — a sector whose row says CERRADO
   * and whose eye reopens nothing is a control that lies.
   */
  async function toggleZones(zoneIds: readonly string[], shut: boolean): Promise<void> {
    const wanted = shut
      ? disabledZones.filter((id) => !zoneIds.includes(id))
      : [...new Set([...disabledZones, ...zoneIds])];
    await guarded(() => setDisabledZones(wanted));
  }

  /** A point that has just been hidden must not leave its card standing over the map. */
  $effect(() => {
    if (selectedPoi && isHidden(selectedPoi)) selectedPoi = null;
  });

  onMount(() => {
    // The clock is a module singleton, so it outlives this component: a master
    // who logs out mid-replay would otherwise leave an interval advancing a
    // cursor nothing is drawing.
    return () => replay.close();
  });

  async function guarded(action: () => Promise<void>): Promise<void> {
    busy = true;
    try {
      await action();
    } catch (error) {
      console.error(error);
    } finally {
      busy = false;
    }
  }

  /**
   * R-24's blocking confirmation, and it is a real `<dialog>` rather than the
   * browser `confirm()` it replaces. Three reasons, in order: `confirm()` cannot
   * say four things legibly, some mobile browsers let a site suppress it
   * permanently, and R-24 is a briefing — what the master is about to see and what
   * they owe the players because of it — which is a paragraph, not a one-liner.
   *
   * Modal on purpose. `showModal()` traps focus and makes the rest of the panel
   * inert, so opening AUTHORITATIVE cannot happen while the master is looking at
   * something else.
   */
  let confirmDialog = $state<HTMLDialogElement | null>(null);

  /**
   * Whether the briefing is up, tracked here as well as on the element.
   *
   * `::backdrop` is painted by the top layer and **no ancestor can clip it** —
   * the same fact that took the `<select>` popup apart — so the dim it draws
   * covered the case as well as the glass, which made the machine part of the
   * dialog. The backdrop is transparent now and the dim is an ordinary element
   * inside the deck, where the tube's `overflow: hidden` reaches it. This is
   * what says when to draw it.
   *
   * `showModal()` stays: focus trapping, inertness and Escape are the reasons
   * R-24 is a real dialog, and none of them are about where the dim is painted.
   */
  let confirming = $state(false);

  /**
   * Every other confirmation in the panel, as one dialog.
   *
   * There were six native `confirm()` and `prompt()` calls left, and the
   * docblock above already says what is wrong with them: they cannot say two
   * things legibly, and **some mobile browsers let a site suppress them
   * permanently**. That last one is not cosmetic. A suppressed `confirm()`
   * returns `false` for ever, so every destructive control in this panel
   * silently stops working — and a suppressed `prompt()` returns `null`, which
   * the reset path reads as "cancelled". Nothing on screen says why.
   *
   * One shape covers all six because they are all the same question with
   * different stakes: a title, some lines, and either a plain accept, a word
   * that has to be typed back, or a value to edit.
   */
  interface Ask {
    title: string;
    lines: string[];
    accept: string;
    /** Red and heavier. R-43 owns the alarm colour on a *map*; this is a sheet. */
    danger?: boolean;
    /** A field. `match` refuses the accept until it is typed back exactly. */
    input?: { label: string; value: string; match?: string };
    run: (typed: string) => void | Promise<void>;
  }

  let ask = $state<Ask | null>(null);
  let askDialog = $state<HTMLDialogElement | null>(null);
  let askTyped = $state('');

  const askReady = $derived(
    !ask?.input?.match || askTyped.trim() === ask.input.match,
  );

  function request(next: Ask): void {
    ask = next;
    askTyped = next.input?.value ?? '';
    askDialog?.showModal();
  }

  async function acceptAsk(): Promise<void> {
    const current = ask;
    if (!current || !askReady) return;
    const typed = askTyped.trim();
    askDialog?.close();
    await current.run(typed);
  }

  async function switchMode(mode: ViewMode): Promise<void> {
    if (mode === 'AUTHORITATIVE') {
      confirming = true;
      confirmDialog?.showModal();
      return;
    }
    manualDowngrade = true;
    await guarded(() => setViewMode(mode));
  }

  /**
   * R-32. Confirmed, because it is not reversible in the other direction by
   * anyone: only a master can undo an elimination, and only a master can undo
   * this undoing.
   */
  function bringBack(playerId: string, callsign: string): void {
    request({
      title: t.players.revive,
      lines: [`${t.players.reviveConfirm} ${callsign}`],
      accept: t.players.revive,
      run: async () => {
        await guarded(() => revivePlayer(playerId));
      },
    });
  }

  async function acceptAuthoritative(): Promise<void> {
    // Only ever from an open dialog. Cheap, and it says out loud what the CSS is
    // responsible for: the one way to reach this is to have read the briefing.
    if (!confirmDialog?.open) return;
    confirmDialog.close();
    await guarded(() => setViewMode('AUTHORITATIVE'));
  }

  /**
   * R-25 as the master sees it coming. The deadline is a timestamp in the payload,
   * so this counts down without the server sending anything — and reaches zero on
   * screen at the moment `game.viewMode` stops answering AUTHORITATIVE.
   */
  const revertSeconds = $derived(game.authoritativeRemainingSeconds);
  const authoritative = $derived(game.viewMode === 'AUTHORITATIVE');

  /**
   * Whether the replay may be opened at all (R-57, R-57b).
   *
   * Not `authoritative`, and the difference is the whole of R-57b: a finished
   * game offers the debrief in either mode. The rule is `replayAllowed()` in
   * core rather than a comparison here, because the server applies the same one
   * to `GET /api/track` — two copies of it would be two things to keep in step,
   * and the one that drifts leaves a control the server answers with 403.
   *
   * The **live** state, never the replayed payload's: the cursor moves
   * `serverNow` and nothing else, but reading the game out of the frame on
   * screen is how a gate ends up asking the replay for permission to be a
   * replay.
   */
  const replayable = $derived(replayAllowed(game.viewMode, live?.game.state));

  /**
   * Turn the tube green while R-24's mode is open (`:root[data-view-mode]` in
   * `terminal.css`, which carries the reasoning and the palette).
   *
   * On the root rather than on this component, so the case and the effect layer
   * turn with the panels; `display.svelte.ts` owns `data-contrast` the same way.
   * It is not put there because `display` has no business knowing about view
   * modes — that would make every panel that opens depend on R-24.
   *
   * The teardown is the part that matters. `authoritative` going false covers a
   * revert (R-25) and a manual drop, but not a logout or a route change, which
   * destroy this view while the mode is still open — and a green screen left
   * behind on the login console would claim a mode nobody holds.
   */
  $effect(() => {
    const root = document.documentElement;
    if (authoritative) root.dataset['viewMode'] = 'AUTHORITATIVE';
    else delete root.dataset['viewMode'];
    return () => delete root.dataset['viewMode'];
  });

  /**
   * Who reported a radio contact, as a name rather than as a key.
   *
   * `reportedBy` is a `playerId` or the `'MASTER'` sentinel (R-14), and the card
   * printed it raw — so a contact reported by a player credited a database id,
   * on the one line whose whole job is to say who to believe.
   *
   * The id is still the fallback, and it is reachable rather than defensive:
   * `roster.ts` leaves radio-contact records naming a removed player alone, so
   * the lookup legitimately misses for anyone taken off the roster since. An id
   * is worse than a callsign and better than a blank.
   */
  function reporterName(reportedBy: string): string {
    if (reportedBy === 'MASTER') return t.radio.byMaster;
    const player = payload?.players.find((candidate) => candidate.id === reportedBy);
    return player?.callsign ?? reportedBy;
  }

  /**
   * Say that the revert happened, rather than leaving the master to wonder why the
   * drop-point column emptied. It is exactly the kind of thing that reads as a bug
   * and is not one, and the log entry that records it (`AUTHORITATIVE_REVERTED`)
   * is itself AUTHORITATIVE-only, so it cannot be the one that explains it.
   *
   * Latched on the transition and cleared on the next open. `manualDowngrade`
   * exists because pressing OPERATIVA is the same transition from here, and
   * announcing inactivity to a master who just switched deliberately would be a
   * lie about their own action.
   */
  let revertedNotice = $state(false);
  let wasAuthoritative = false;
  let manualDowngrade = false;

  $effect(() => {
    if (authoritative) {
      wasAuthoritative = true;
      revertedNotice = false;
      return;
    }
    if (!wasAuthoritative) return;
    wasAuthoritative = false;
    revertedNotice = !manualDowngrade;
    manualDowngrade = false;
  });

  /**
   * The one marker (R-19..R-21). One slot, so this panel is a single form and a
   * single clear button — there is nothing to list.
   *
   * Placing is allowed in every game state, unlike the roster and the geometry:
   * a marker is what a master says in the middle of play, and in PREPARATION it
   * is how audience filtering gets checked against a real phone before anybody
   * leaves.
   */
  /** 0 is the sentinel for "no expiry" in the select; the API takes null (R-21c). */
  const TTL_OPTIONS = [60_000, 300_000, 900_000, 3_600_000, 0] as const;
  /** The locale keys the durations above are written under, read once. */
  const ttlLabels: Record<string, string> = t.marker.ttls;

  /**
   * The dropdowns' contents, as data.
   *
   * `Select` takes a list rather than markup because it has to know how many
   * rows there are and which one is current — a component that rendered a slot
   * could not put the keyboard on the right row, and the keyboard is most of
   * what a `<select>` was giving us.
   */
  const teamOptions = $derived(
    (payload?.teams ?? []).map((team) => ({ value: team.id, label: team.name })),
  );
  const playerOptions = $derived(
    (payload?.players ?? []).map((player) => ({ value: player.id, label: player.callsign })),
  );
  const audienceOptions = $derived([
    { value: 'all', label: t.marker.everyone },
    ...(payload?.teams ?? []).map((team) => ({
      value: `team:${team.id}`,
      label: `${t.marker.team} ${team.name}`,
    })),
    ...(payload?.players ?? []).map((player) => ({
      value: `player:${player.id}`,
      label: `${t.marker.player} ${player.callsign}`,
    })),
  ]);
  const ttlOptions = TTL_OPTIONS.map((ttl) => ({
    value: String(ttl),
    label: ttlLabels[String(ttl)] ?? String(ttl),
  }));

  let markerLabel = $state('');
  let markerLat = $state('');
  let markerLon = $state('');
  /** Encoded flat so one <select> can carry all three audience kinds. */
  let markerAudience = $state('all');
  let markerTtl = $state(String(300_000));
  let markerError = $state<string | null>(null);

  function markerMessage(reason: string): string {
    const messages: Record<string, string> = t.marker.errors;
    return messages[reason] ?? t.marker.errors.UNKNOWN;
  }

  function audienceFrom(value: string): Audience {
    if (value.startsWith('team:')) return { kind: 'team', teamId: value.slice(5) };
    if (value.startsWith('player:')) return { kind: 'player', playerId: value.slice(7) };
    return { kind: 'all' };
  }

  /**
   * The coordinate tool, and whether it is armed.
   *
   * It used to be always on: `onPick` was handed to the map unconditionally, so
   * every tap on open ground overwrote the marker's coordinates and the
   * master's map wore a crosshair for the whole game. That is a mode nobody
   * chose to be in — and an invisible one, since the only thing that said so
   * was the cursor.
   *
   * Armed, it is a round trip that starts and ends in the same place: press the
   * button in the marker form, the panel gets out of the way, the map takes one
   * tap, and the panel comes back with the numbers in it. The map is the
   * interface, so the tool that reads a coordinate off it has to *be* on it.
   */
  let picking = $state(false);

  /** Whether the floating marker window is up. Not a panel: it sits over the map. */
  let placingMarker = $state(false);

  /**
   * Opening the window arms the map.
   *
   * Reaching for "place a marker" is reaching for somewhere to put it: the
   * coordinates are the first two fields and the map is the only sane way to
   * fill them. Opening unarmed meant a second press before anything could
   * happen, every time, to reach the state everybody wanted — and the cost of
   * being wrong is nothing, since one tap disarms and the button toggles.
   */
  function openMarkerForm(): void {
    placingMarker = true;
    picking = true;
    // The panel covers the stage, and the window is about the ground under it.
    open = null;
  }

  function closeMarkerForm(): void {
    placingMarker = false;
    picking = false;
  }

  function armPicking(): void {
    picking = true;
    // The window floats, so arming no longer has to dismantle the layout — but a
    // panel left open would still be covering the map the tool is aimed at.
    placingMarker = true;
    open = null;
  }

  /** From a tap on the map or the scatter, faster than typing five decimals. */
  function pickPoint(lon: number, lat: number): void {
    markerLat = lat.toFixed(5);
    markerLon = lon.toFixed(5);
    // One tap, one coordinate. Staying armed would make the next tap — on a
    // player, on a point, anywhere — silently overwrite it.
    picking = false;
  }

  function cancelPicking(): void {
    picking = false;
  }

  /**
   * A panel toggled from the bar or from its key, and focus follows it.
   *
   * Opening a surface without moving focus into it is what makes a keyboard
   * interface unusable: the panel appears, `Tab` continues from the bar button
   * behind it, and the first control inside is a dozen presses away. Closing
   * hands focus back, or the next `Tab` starts from the top of the document.
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

  /**
   * The docks, with the same focus contract and their own memory of where focus
   * came from — sharing `returnFocusTo` with the panels would mean opening one
   * over the other loses the first's answer, and the pair are deliberately
   * independent.
   */
  let dockBox = $state<HTMLElement | null>(null);
  let returnFocusFromDock: HTMLElement | null = null;

  function toggleDock(id: Dock): void {
    if (dock === id) {
      dock = null;
      returnFocusFromDock?.focus();
      returnFocusFromDock = null;
      return;
    }
    // Swapping one dock for the other keeps the first answer: focus came from
    // outside both, and it is where Escape should still land.
    if (dock === null) {
      const active = document.activeElement;
      returnFocusFromDock = active instanceof HTMLElement ? active : null;
    }
    dock = id;
  }

  /** One entry point for the bar and for the keys, so the two cannot diverge. */
  function toggleBar(id: BarId): void {
    if (isDock(id)) toggleDock(id);
    else togglePanel(id);
  }

  const barOn = (id: BarId): boolean => (isDock(id) ? dock === id : open === id);

  $effect(() => {
    if (dock) dockBox?.focus();
  });

  /**
   * How many lines the dock renders.
   *
   * The live tail is capped at 500 (`#log()` keeps that, and `track_log` is the
   * uncapped archive R-56 replays from), and a four-hour game overruns it. This
   * is a window on the end of that tail rather than all of it: 200 lines is
   * more than the dock can show at any height it is allowed to be, and it keeps
   * a long session from re-rendering five hundred nodes on every snapshot.
   */
  const LOG_LINES = 200;

  let logLines = $state<HTMLElement | null>(null);
  /** Whether the master is reading the newest line, or has scrolled back. */
  let atTail = true;

  function noteTailPosition(): void {
    const box = logLines;
    if (!box) return;
    // A couple of lines of slack: a scroll that lands a pixel short of the
    // bottom is still somebody watching the tail.
    atTail = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  }

  /**
   * Follow the newest line, **unless the master has scrolled back**.
   *
   * A console that always jumps to the bottom is a console you cannot read
   * history in: the snapshot arrives every few seconds and yanks the line you
   * were on off the screen. So the tail is followed only while it is already
   * what is being watched, which is the rule every terminal pager uses.
   */
  $effect(() => {
    // Depend on the events themselves, so this runs when a line arrives rather
    // than on any other state the dock happens to read.
    void payload?.events?.length;
    void dock;
    if (dock !== 'LOG' || !atTail) return;
    const box = logLines;
    if (box) box.scrollTop = box.scrollHeight;
  });

  /**
   * The glass steps back while a panel is up. §9's effect layer covers
   * everything — the vignette is darkest at the screen's edge, which is exactly
   * where this rail lives — and §9 already says which side wins when the effect
   * costs legibility.
   */
  $effect(() => {
    if (!open) return;
    return display.openedReader();
  });

  /**
   * Escape, in the order things are stacked.
   *
   * One key, one step out — never everything at once. A master who armed the
   * tool inside the marker window and presses Escape means "not that", not
   * "close everything I have open". The dialog is absent from the ladder
   * because a modal `<dialog>` answers Escape itself.
   */
  function escape(): void {
    // First rung, and the only one that is not about something on screen: while
    // recording, the controls are hidden (R-65), so this is the master's way
    // back to them. Above `picking` because a recording is the outer state —
    // everything else on this ladder is inside it.
    if (recorder.recording) {
      recorder.stop();
      return;
    }
    if (picking) {
      cancelPicking();
      return;
    }
    if (selectedPoi) {
      selectedPoi = null;
      return;
    }
    if (selected) {
      selected = null;
      return;
    }
    if (placingMarker) {
      closeMarkerForm();
      return;
    }
    if (open) {
      togglePanel(open);
      return;
    }
    // Last, and after the panels, because a dock is the surface a master leaves
    // open on purpose: Escape closes what you opened to do something, and a
    // dock is what you were watching while you did it.
    if (dock) toggleDock(dock);
  }

  /**
   * The bindings in force at the moment a key is pressed.
   *
   * A **function**, not a `$derived`, and the listener is `<svelte:window>`
   * rather than an `$effect` that registers one by hand. Both were the second
   * of those and both were wrong in the same way: an effect that only reads its
   * state inside a callback has no dependencies to re-run on, so the array it
   * closed over was whatever the first render produced — and every cleanup and
   * re-registration in between was a chance for the listener to end up
   * unregistered with nothing to put it back. The symptom was the keyboard
   * going dead after the first panel opened, Escape included.
   *
   * Computed per keystroke there is nothing to keep in step: `when` reads the
   * mode as it is now, which is what R-57 needs — the replay key must not exist
   * in `OPERATIONAL`, where its presence is the leak exactly as R-32's button
   * is. `<svelte:window>` binds the listener to the component's lifetime, which
   * is the one lifetime that cannot be got wrong.
   */
  function bindingsNow(): Binding[] {
    return [
      { key: 'Escape', run: escape },
      ...PANELS.map((entry) => ({
        key: entry.key,
        when: entry.id !== 'REPLAY' || replayable,
        run: () => toggleBar(entry.id),
      })),
      {
        key: MARKER_KEY,
        run: () => (placingMarker ? closeMarkerForm() : openMarkerForm()),
      },
      // A keystroke is a user gesture, which is the whole reason this can be a
      // key at all: `requestFullscreen()` refuses without one, and that is also
      // why nothing restores it after a reload.
      {
        key: FULLSCREEN_KEY,
        when: display.canFullscreen,
        run: () => void display.toggleFullscreen(),
      },
      ...VIEW_MODES.map((mode) => ({
        key: MODE_KEYS[mode],
        when: !busy && game.viewMode !== mode,
        run: () => void switchMode(mode),
      })),
    ];
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    const binding = matchBinding(event, bindingsNow());
    if (!binding) return;
    event.preventDefault();
    // One action that throws must not read as a broken keyboard. It cannot take
    // the listener with it — `<svelte:window>` owns that — but it can leave the
    // master pressing keys at a screen that has stopped answering.
    try {
      binding.run();
    } catch (error) {
      console.error('[keys]', error);
    }
  }

  async function place(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    markerError = null;
    busy = true;
    try {
      await placeMarker({
        label: markerLabel,
        // Number('') is 0, which is a real coordinate in the Gulf of Guinea, so
        // an empty field has to become NaN and be refused rather than placed.
        lat: markerLat.trim() === '' ? Number.NaN : Number(markerLat),
        lon: markerLon.trim() === '' ? Number.NaN : Number(markerLon),
        audience: audienceFrom(markerAudience),
        // 0 in the select means no expiry, and the API wants null for that: absent
        // would take the default TTL instead (R-21c).
        ttlMs: Number(markerTtl) === 0 ? null : Number(markerTtl),
      });
      markerLabel = '';
    } catch (error) {
      markerError = error instanceof MarkerRejected ? error.reason : 'UNKNOWN';
      if (!(error instanceof MarkerRejected)) console.error(error);
    } finally {
      busy = false;
    }
  }

  async function dropMarker(id?: string): Promise<void> {
    markerError = null;
    busy = true;
    try {
      await clearMarker(id);
    } catch (error) {
      markerError = error instanceof MarkerRejected ? error.reason : 'UNKNOWN';
      if (!(error instanceof MarkerRejected)) console.error(error);
    } finally {
      busy = false;
    }
  }

  /**
   * Read through game.markers so expiry is derived here as well as on the server
   * (R-21c): a marker leaves the panel at its TTL rather than when the next
   * snapshot happens to arrive. The countdown needs no tick either — a TTL is a
   * timestamp (R-15).
   */
  const markers = $derived(game.markersAt(payload, now));
  const markerSlotsLeft = $derived(MARKER_MAX - markers.length);

  /** The countdown, or nothing at all for a marker with no TTL. */
  function remaining(marker: MasterMarker): string {
    const seconds = game.markerRemainingSeconds(marker, now);
    return seconds === undefined
      ? t.marker.indefinite
      : `${t.marker.expiresIn} ${formatDuration(seconds)}`;
  }

  /** Who a marker is addressed to, in words the master will recognise. */
  function audienceLabel(audience: Audience): string {
    if (audience.kind === 'all') return t.marker.everyone;
    if (audience.kind === 'team') {
      const team = payload?.teams.find((candidate) => candidate.id === audience.teamId);
      return `${t.marker.team} ${team?.name ?? audience.teamId}`;
    }
    const player = payload?.players.find((candidate) => candidate.id === audience.playerId);
    return `${t.marker.player} ${player?.callsign ?? audience.playerId}`;
  }

  /**
   * R-21d on R-72's ladder. Blocking **on the way up**, like AUTHORITATIVE's
   * confirmation and for a related reason: it changes who can see whom, and
   * nothing on a player's screen announces it beyond a line of text and a bar
   * on a meter.
   *
   * Narrowing needs no briefing — it takes visibility away, and the cost of
   * this setting is entirely in granting it — so 5 → 4 goes straight through
   * while 3 → 4 and 4 → 5 both stop and ask. The confirmation names the level
   * being asked for rather than the setting, because with three points "enable
   * extended comms" no longer says what is about to happen.
   */
  /** The locale keys are strings; the level is a number. One cast, in one place. */
  const commsLevel = (reach: CommsReach): string =>
    (t.comms.levels as Record<string, string>)[String(reach)] ?? '';

  const commsShort = (reach: CommsReach): string =>
    (t.comms.short as Record<string, string>)[String(reach)] ?? '';

  async function setReach(reach: CommsReach): Promise<void> {
    if (reach === game.commsReach) return;
    if (reach < game.commsReach) {
      await guarded(() => setCommsReach(reach));
      return;
    }
    request({
      title: t.comms.title,
      lines: [commsLevel(reach), t.comms.warning],
      accept: t.comms.enable,
      run: async () => {
        await guarded(() => setCommsReach(reach));
      },
    });
  }

  async function revealInvites(): Promise<void> {
    showInvites = true;
    try {
      invites = await fetchInvites();
    } catch (error) {
      console.error(error);
    }
  }

  /** Closing the panel puts the links away again rather than leaving them open. */
  $effect(() => {
    if (open !== 'TEAM') showInvites = false;
  });

  async function copyInvite(invite: Invite): Promise<void> {
    const link = `${location.origin}${invite.path}`;
    try {
      await navigator.clipboard.writeText(link);
      copied = invite.playerId;
    } catch {
      // Clipboard needs a secure context; the link is on screen either way.
      copied = null;
    }
  }

</script>

<!-- The keyboard lives for exactly as long as this component does, which is the
     one lifetime that cannot be got wrong. It was an `$effect` registering a
     listener by hand, and the cleanup that went with it was one more way for
     the keyboard to end up unregistered with nothing to put it back. -->
<svelte:window onkeydown={onWindowKeydown} />

{#if payload}
  <!--
    The deck. One map, one bar, and one panel at a time on top of it.

    Every section below is a `{#snippet}` rather than markup in place, which is
    what makes the grouping a composition instead of a rewrite: the roster table,
    the tray and the marker form are the same markup they were as a scrolling
    document, rendered into whichever panel they belong to.
  -->
{#snippet resetSection()}
    <section>
      <h2>{t.reset.title}</h2>
      <!--
        Behind R-32's gate, like REVIVIR and the replay control.
        Not for the same reason, though, and the difference is worth keeping
        straight: those two are hidden in OPERATIVA because **their presence
        leaks** — a revive button beside a callsign announces who is out. This
        one leaks nothing. It is gated because it is the only action in the
        panel with no undo at all, and a master reading the map should not be
        able to reach it without first confirming R-24.
      -->
      {#if authoritative}
        <div class="row">
          <button type="button" class="danger" disabled={busy || !configurable} onclick={wipeGame}>
            {t.reset.button}
          </button>
        </div>
        <p class="hint">{configurable ? t.reset.hint : t.reset.lockedHint}</p>
      {:else}
        <p class="hint">{t.reset.modeHint}</p>
      {/if}
    </section>
{/snippet}

{#snippet gameStateSection()}
    <section>
      <h2>{t.panels.game}</h2>
      <!--
        One grid for the whole panel: label, reading, controls, in three columns
        that line up down every row. It was four sections in four shapes — a row
        of buttons here, a bare `LABEL: VALUE` span there, a reading sitting
        inside a row of buttons so it read as a disabled one — and none of them
        aligned with each other, so the panel had to be read rather than
        scanned.

        **Two of the controls reported the action instead of the state**, which
        is the fault the case's switches were fixed for: a control whose legend
        is what would happen if you pressed it has to be read twice, once for
        the word and once to decide whether it names what you have or what you
        would get. The reading column says the state and nothing else; the
        buttons are what you press. The one that is the state now carries
        `aria-pressed` and lights inverse video (§9.4), so which state the game
        is in stops being encoded as *the button you cannot press*.
      -->
      <dl class="settings">
        <dt>{t.game.state}</dt>
        <dd><span class="reading">{t.game.states[payload.game.state]}</span></dd>
        <dd class="acts">
          {#each STATES as state (state)}
            <button
              type="button"
              class:on={payload.game.state === state}
              aria-pressed={payload.game.state === state}
              disabled={busy || payload.game.state === state}
              onclick={() => guarded(() => setGameState(state))}
            >
              {t.game.states[state]}
            </button>
          {/each}
        </dd>

        <dt>{t.game.cut}</dt>
        <dd><span class="reading">{payload.game.cutSwitch ? t.game.cutOn : t.game.cutOff}</span></dd>
        <dd class="acts">
          <!-- A fixed legend and a pressed state, not a label that flips to the
               opposite word. Same rule as the bezel. -->
          <button
            type="button"
            class:on={payload.game.cutSwitch}
            aria-pressed={payload.game.cutSwitch}
            disabled={busy}
            onclick={() => guarded(() => setCutSwitch(!payload.game.cutSwitch))}
          >
            {t.game.cut}
          </button>
        </dd>

        <dt>{t.comms.title}</dt>
        <dd>
          <span class="reading">QSA {game.commsReach}</span>
          <!-- The short form, not the sentence. The sentence is under the
               buttons with the rest of the note, where its length costs
               nothing; here it sat in an `auto` grid column and moved the
               controls beside it every time the level changed. -->
          <span class="aside reach">{commsShort(game.commsReach)}</span>
        </dd>
        <dd class="acts">
          <!-- Three buttons rather than a switch (R-72). A three-point setting
               drawn as a toggle would have to hide one of its states behind the
               order they are pressed in, and this one decides who can see
               whom. -->
          {#each [3, 4, 5] as const as reach (reach)}
            <button
              type="button"
              class:on={game.commsReach === reach}
              aria-pressed={game.commsReach === reach}
              disabled={busy || game.commsReach === reach}
              onclick={() => setReach(reach)}
            >
              QSA {reach}
            </button>
          {/each}
          <!-- Inside the control's own cell, not under the list.
               Four settings with their four explanations stacked at the bottom
               is a legend, and a legend has to be matched back to its row by
               reading both — which is work the panel can do by putting each
               sentence where its button is. Inside the cell rather than in a row
               of its own so it is closer to its control than the next setting
               is: the gap between settings is 0,7lh and a note a full gap below
               its button belongs to neither. -->
          <p class="note">{commsLevel(game.commsReach)}</p>
          <p class="note">{t.comms.hint}</p>
          {#if game.commsReach > 3}
            <p class="note warning">{t.comms.warning}</p>
          {/if}
        </dd>

        <dt>{t.geo.label}</dt>
        <dd>
          <span class="reading">{profileName(payload.geoProfile)}</span>
          <span class="aside">{payload.zones.length} {t.geo.zones}</span>
        </dd>
        <dd class="acts">
          {#each GEO_PROFILES as profile (profile)}
            <button
              type="button"
              class:on={payload.geoProfile === profile}
              aria-pressed={payload.geoProfile === profile}
              disabled={busy || payload.geoProfile === profile || payload.game.state === 'IN_PROGRESS'}
              onclick={() => guarded(() => setGeoProfile(profile))}
            >
              {t.geo.profiles[profile]}
            </button>
          {/each}
          <p class="note">
            {payload.game.state === 'IN_PROGRESS' ? t.geo.lockedHint : t.geo.hint}
          </p>
        </dd>
      </dl>
    </section>
{/snippet}

{#snippet playersSection()}
    <section>
      <!--
        The roster, and deliberately not a table.

        A table gives every column the same weight, and these do not have it: a
        callsign and whether somebody is still on the air are read at a glance
        every few minutes, and a coordinate pair is read once, about one person,
        when the master has already decided to look. So the row carries the
        first kind and the map's card carries the second — clicking a name
        selects the dot, which is the same selection tapping the map makes and
        opens the same card. One place where a person's detail lives, reachable
        from either end.

        What is left per row is the callsign, §9.7's state mark, the age of the
        fix and whether it is live, with the battery as a quiet trailing label.
        No position, no device, no radio column, no drop point, no revive — all
        of them are in the card, and the ones that are AUTHORITATIVE-only are
        gated there by the payload rather than by a second decision here.
      -->
      {#each teamGroups as group (group.id)}
        <div class="group">
          <h3>{group.name}</h3>
          <ul class="roster">
            {#each group.players as player (player.id)}
              {@const state = game.linkState(player, now)}
              {@const mark = stateMark(player, state)}
              {@const sectorId = player.position?.zoneId
                ? sectorOfZone.get(player.position.zoneId)
                : undefined}
              <!--
                Pointing at a row lights the ground that player is standing on
                (R-71). The map has no names, so "where is bravo" is otherwise a
                coordinate pair the master has to place from memory — and on
                ground they have never walked, memory is exactly what a master
                directing somebody through it does not have.

                Highlight only, never selection: hovering must not open a card,
                which is the same line `highlightPoi` draws against
                `selectedPoi`.
              -->
              <li
                class:on={selected === player.id}
                onmouseenter={() => pointAt('sector', sectorId ?? null)}
                onmouseleave={() => pointAt('sector', null)}
                onfocusin={() => pointAt('sector', sectorId ?? null)}
                onfocusout={() => pointAt('sector', null)}
              >
                <!--
                  The row is the button. R-14's radio contact, R-32's revive and
                  every coordinate moved to the card, so what a row does now is
                  point at somebody — and a row with a hit area smaller than the
                  row is a row that misses on a phone.
                -->
                <button type="button" class="pick" onclick={() => (selected = player.id)}>
                  <!-- Empty: the shape is drawn from `data-mark`. `stateMark()`
                     returning nothing is a real answer (R-40, no fix yet), and
                     an empty cell holds the column rather than inventing a
                     glyph for it. -->
                <span class="mark {mark?.brightness ?? 'dim'}" data-mark={mark?.shape}></span>
                  <span class="callsign">{player.callsign}</span>
                  {#if player.battery !== undefined}
                    <span class="batt">{player.battery}{t.units.percent}</span>
                  {/if}
                  <span class="meta">
                    {#if player.position}
                      <!-- The sector, ahead of the age, because with two towns
                           in play *where* is read before *how fresh*. Absent for
                           a player in no zone at all, which is a real answer
                           (R-40, and R-71's closed ground) rather than a gap. -->
                      {#if sectorId}
                        {sectors.find((candidate) => candidate.id === sectorId)?.name} ·
                      {/if}
                      {player.position.source === 'LIVE' ? t.card.live : t.card.lastKnown}
                      · {formatAge(player.position.ts, now)}
                      <!-- R-12's circle only grows once the feed has stopped, so
                           its radius is only worth the width once it has. -->
                      {#if state === 'NO_LINK'}
                        · {formatUncertainty(game.uncertaintyMetres(player, now))}
                      {/if}
                    {:else}
                      {t.players.noPosition}
                    {/if}
                  </span>
                </button>
                <!-- Only where there is somewhere to go. A player with no fix
                     has nothing to centre on, and a button that can only fail
                     is worse than no button on the row that explains why. -->
                {#if player.position}
                  <button
                    type="button"
                    class="locate"
                    title={t.players.centre}
                    aria-label={`${t.players.centre} ${player.callsign}`}
                    onclick={() => locate(player)}
                  >
                    <!-- Drawn, not lettered. §9.7's `◎` would be the obvious
                         mark and is spoken for — it means STATIONARY on every
                         dot in the app, and a control wearing it would be the
                         one glyph on screen that says two things. -->
                    <span class="reticle" aria-hidden="true"></span>
                  </button>
                {/if}
                {#if setupPhase}
                  <button
                    type="button"
                    class="drop"
                    disabled={busy || !configurable}
                    title={t.roster.remove}
                    aria-label={`${t.roster.remove} ${player.callsign}`}
                    onclick={() => dropFromRoster(player.id, player.callsign)}
                  >—</button>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/each}

      {#if setupPhase}
        <form onsubmit={addToRoster} class="stack">
          <label>
            {t.players.callsign}
            <input bind:value={newCallsign} required disabled={busy || !configurable} />
          </label>
          <label>
            {t.roster.fullName}
            <input bind:value={newFullName} required disabled={busy || !configurable} />
          </label>
          <label>
            {t.teams.label}
            <Select bind:value={newTeamId} options={teamOptions} disabled={busy || !configurable} />
          </label>
          <button type="submit" disabled={busy || !configurable}>{t.roster.add}</button>
        </form>
        <p class="hint">{configurable ? t.roster.hint : t.roster.lockedHint}</p>
        {#if lastInvite}
          <p class="hint">{t.roster.invite}: <span class="link">{lastInvite}</span></p>
        {/if}
      {/if}
      {#if rosterError}
        <p class="warning">{rosterMessage(rosterError)}</p>
      {/if}
    </section>
{/snippet}

{#snippet teamsSection()}
  <!--
    Only while setup is what the master is doing. Once the game is running the
    teams are readable off the roster's own headings, and a second list of the
    same names with buttons that the server will refuse is worse than no list.
  -->
  {#if setupPhase}
    <section>
      <h2>{t.teams.title}</h2>
      <!-- A list, like the roster above it. The table this replaced had three
           columns and two full-width buttons in the last one, which is what put
           a sideways scrollbar on a rail during PREPARATION. -->
      <ul class="teams">
        {#each payload.teams as team (team.id)}
          {@const members = payload.players.filter((p) => p.teamId === team.id).length}
          <li>
            <span class="name">{team.name}</span>
            <!-- A number on its own says nothing about what it counts, and this
                 one was wearing `.batt` to get its styling — the battery class,
                 on a headcount, in a file where three bugs have already come
                 from a class name claimed twice. The label is the fix and the
                 class is the other half of it. -->
            <span class="count">
              {members}<span class="count-label">{t.teams.members}</span>
            </span>
            <button type="button" disabled={busy || !configurable} onclick={() => rename(team.id, team.name)}>
              {t.teams.rename}
            </button>
            <!-- A team with players in it cannot go, and neither can the last
                 one: without a team there is nobody to add anybody to. -->
            <button
              type="button"
              disabled={busy || !configurable || members > 0 || payload.teams.length === 1}
              onclick={() => dropTeam(team.id, team.name)}
            >
              {t.teams.remove}
            </button>
          </li>
        {/each}
      </ul>
      <form onsubmit={createTeam} class="stack">
        <label>
          {t.teams.name}
          <input bind:value={newTeamName} required disabled={busy || !configurable} />
        </label>
        <button type="submit" disabled={busy || !configurable}>{t.teams.add}</button>
      </form>
      <p class="hint">{configurable ? t.teams.hint : t.roster.lockedHint}</p>
    </section>
  {/if}
{/snippet}

{#snippet traySection()}
    <section>
      <h2>{t.tray.title}</h2>
      {#if !payload.tray || payload.tray.length === 0}
        <p>{t.tray.empty}</p>
      {:else}
        <!--
          A list on the roster's terms, and for the same reason: six columns do
          not fit a rail, and five of them are read once while pairing. The
          coordinates are gone from here — an unpaired phone is a dot on the map
          like any other, and clicking it opens the card that has them.
        -->
        <ul class="roster">
          {#each payload.tray as entry (entry.deviceId)}
            <li class:on={selected === entry.deviceId}>
              <button type="button" class="pick" onclick={() => (selected = entry.deviceId)}>
                <!-- The mark slot is deliberately empty. §9.7's four glyphs are
                     claims about a *player's* position state, and an unpaired
                     phone has none derived for it — ◎ here would say "detenido"
                     about a device nobody has decided anything about. The column
                     stays so the callsigns above and the device ids here line
                     up on the same left edge. -->
                <span class="mark"></span>
                <span class="callsign">{entry.deviceId}</span>
                {#if entry.battery !== undefined}
                  <span class="batt">{entry.battery}{t.units.percent}</span>
                {/if}
                <span class="meta">
                  {formatAge(entry.lastSeen, now)} · {entry.pings} {t.tray.pings}
                </span>
              </button>
            </li>
            <li class="pair">
              <!-- Not bound: an unset entry is `undefined`, which matches no
                   option and would draw a blank control. The fallback is the
                   same one the pair call makes, so what is on screen is what
                   the button would do. -->
              <Select
                value={pairTargets[entry.deviceId] ?? payload.players[0]?.id ?? ''}
                options={playerOptions}
                onchange={(next) => (pairTargets[entry.deviceId] = next)}
              />
              <button
                type="button"
                disabled={busy}
                onclick={() =>
                  guarded(() =>
                    pairDevice(entry.deviceId, pairTargets[entry.deviceId] ?? payload.players[0]?.id ?? ''),
                  )}
              >
                {t.tray.pair}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
{/snippet}

{#snippet invitesSection()}
    <section>
      <h2>{t.invites.title}</h2>
      <!--
        An invite path is a credential. It is wanted twice a game, with the
        player's phone in the master's hand, and it was on screen permanently —
        so it is behind a press, and fetched when the press happens rather than
        held from mount.
      -->
      <p class="hint">{t.invites.hint}</p>
      {#if !showInvites}
        <button type="button" onclick={revealInvites}>{t.invites.reveal}</button>
      {:else}
        <!-- A list rather than a table: a path is longer than this rail is wide,
             and a table would answer that with a sideways scrollbar. -->
        <ul class="invites">
          {#each invites as invite (invite.playerId)}
            <li>
              <div class="row">
                <strong>{invite.callsign}</strong>
                <button type="button" onclick={() => copyInvite(invite)}>
                  {copied === invite.playerId ? t.invites.copied : t.invites.copy}
                </button>
              </div>
              <p class="link">{invite.path}</p>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
{/snippet}

<!--
  The log, printed rather than tabulated.

  A table draws the columns; a console suggests them, and the difference is what
  the surface claims to be. `systemctl status` is the reference and it is the
  right one: fixed-width fields separated by spacing, oldest at the top, newest
  at the bottom where a tail puts it, and nothing that looks like a grid you
  could sort. The screen font is monospace, so a width in `ch` lines the fields
  up exactly — which is the whole trick, and the reason this cannot be done with
  a proportional face.

  Newest last, unlike the panel this replaces. A log that grows upwards is a
  feed; one that grows downwards is a record of a session, and the scroll
  follows it — see `stickToTail()` for the one thing that must not do.
-->
{#snippet eventsSection()}
    {#if payload.events && payload.events.length > 0}
      <div class="log-lines" bind:this={logLines} onscroll={noteTailPosition}>
        <!-- Deliberately unkeyed, and it is the one each block here that is.
             A key has to be an identity, and an append-only log has none to
             offer: `ts`+`kind`+`target` is content, and content collides —
             `#revertLapsedViewModes()` logs one AUTHORITATIVE_REVERTED per
             lapsed session at a single `now`, so two masters idling out
             together produce two rows identical in all three. Svelte answers
             a duplicate key with `each_key_duplicate`, which is a thrown
             error and takes the whole panel down. Nothing is gained by
             keying anyway: the list is a fresh slice, so one new event shifts
             every row and no identity survives the render. -->
        {#each payload.events.slice(-LOG_LINES) as event}
          <p class="log-line">
            <span class="log-age">{formatAge(event.ts, now)}</span>
            <span class="log-kind">{event.kind}</span>
            <span class="log-detail"
              >{eventDetail(event)}</span
            >
          </p>
        {/each}
      </div>
    {:else}
      <p class="log-empty">{t.events.empty}</p>
    {/if}
{/snippet}

    <!-- R-53..R-57, docked rather than staged (R-62): the map is what a replay
         moves, so the controls sit in a row under it instead of over it.

         Under AUTHORITATIVE, or in a finished game under either mode (R-57b).
         R-26 and R-57 make full detail the only replay there is, and R-57's gate
         on the control's *presence* is the argument R-32 makes about REVIVIR —
         offering a replay beside a roster the mode is withholding from announces
         that there is something to withhold. R-57b is that argument running out:
         a finished game has no roster left to protect. The guard is kept here as
         well as on the bar, because the dock can also be reached by a key. -->
{#snippet replaySection()}
    {#if replayable}
      <section class="replay">
        {#if !replay.active}
          <div class="row">
            <button
              type="button"
              disabled={busy || replay.loading}
              onclick={() => live && void replay.open(live.game, game.serverNow)}
            >
              {replay.loading ? t.replay.loading : t.replay.open}
            </button>
            <span class="hint">{t.replay.hint}</span>
          </div>
          {#if replay.error}
            <p class="warning">{t.replay.errors[replay.error]}</p>
          {/if}
        {:else}
          <p class="warning">{t.replay.banner}</p>
          <!--
            The transport, as marks rather than words (R-62).

            A row that read PAUSA · VELOCIDAD: 8X · VOLVER A DIRECTO · CURSOR ·
            POSICIONES was most of a line of prose for three controls, and every
            line this dock takes is map — which is the thing the replay exists to
            move and the reason R-62 docked it instead of staging it.

            **Drawn, not lettered.** VT323 has no `▶`, no `⏸` and no `⏩`: §9.7's
            four state marks were already lost to exactly that, and a tofu box on
            the button that starts the replay is worse than the word it replaced.
            Same mechanism as the map's camera toggle — a box and a `clip-path`.

            The speed keeps its number beside the mark, because that is the one
            of the three whose *state* is the thing you need: a mark alone would
            say "speed" and leave 1x and 8x looking identical. Play and pause
            need no number — the mark is the state — and they carry their words
            in `aria-label` and `title`, which is where a control this size puts
            them.

            `CURSOR` is gone rather than shortened. It printed an age against
            live — `1h` — which in a debrief opened days later is both useless
            and nearly constant across the whole bar; R-66 put the instant on the
            stage above, in wall-clock, where the master is already looking.
          -->
          <div class="row">
            <button
              type="button"
              class="transport"
              aria-label={replay.playing ? t.replay.pause : t.replay.play}
              title={replay.playing ? t.replay.pause : t.replay.play}
              onclick={() => (replay.playing ? replay.pause() : replay.play())}
            >
              <i class="icon" data-icon={replay.playing ? 'pause' : 'play'}></i>
            </button>
            <button
              type="button"
              class="transport"
              aria-label={t.replay.speed}
              title={t.replay.speed}
              onclick={() => replay.cycleSpeed()}
            >
              <i class="icon" data-icon="speed"></i>{replay.speed}x
            </button>
            <button type="button" onclick={() => replay.close()}>{t.replay.backToLive}</button>
            <span class="hint">{t.replay.samples}: {replay.samples}</span>
          </div>
          <!-- The range is the window's own timestamps rather than a thousand
               steps across it (R-62). The fixed count was fine over M8's hour and
               is 21,6 s per step over a six-hour game, which is coarser than the
               samples underneath; a one-second step follows the window instead.
               The value still reads as an age beside it, so the master converts
               nothing. Seeking pauses: a cursor that runs away under the thumb
               cannot be aimed. -->
          <input
            type="range"
            min={replay.from}
            max={replay.to}
            step="1000"
            value={replay.cursor}
            oninput={(event) => replay.seek(Number(event.currentTarget.value))}
          />
          <!-- R-65. Two files, and they are not the same kind of thing: one is
               the data already in this tab, the other is a capture of the screen
               the master is looking at. The hint under the first is where it
               belongs — §10 is about what the file contains, and a warning in a
               document nobody has open is not a warning. -->
          <!-- Each file's warning **beside** its button rather than under the
               pair of them. R-65 and §10 are why the text is there at all — a
               file of real positions and named drop points says so where it is
               pressed, not in a document nobody has open — and putting the line
               on the button's own row is what stops that costing three lines of
               dock. It wraps under the button on a narrow screen, which is the
               one place the pair cannot share a line. -->
          <div class="row">
            <button type="button" onclick={exportTrack}>{t.replay.exportJson}</button>
            <span class="hint">{t.replay.exportJsonHint}</span>
          </div>
          {#if recorder.supported}
            <div class="row">
              <button
                type="button"
                onclick={() =>
                  recorder.recording ? recorder.stop() : live && void startRecording(live.game)}
              >
                {recorder.recording ? t.replay.recordStop : t.replay.record}
              </button>
              {#if !recorder.recording}
                <span class="hint">{t.replay.recordHint}</span>
              {/if}
            </div>
          {/if}
          {#if recorder.error}
            <p class="warning">{t.replay.recordErrors[recorder.error]}</p>
          {/if}
        {/if}
      </section>
    {/if}
{/snippet}
{#snippet markersSection()}
    <section>
      <h2>{t.marker.title}</h2>
      {#if markers.length === 0}
        <p>{t.marker.none}</p>
      {:else}
        <!-- A list, not a table, for the same reason the roster beside it is
             one: this panel is a rail now and five `nowrap` columns are wider
             than any rail worth having. Two lines per entry — the name and what
             it is, then where and how long — with the controls in a column of
             their own down the right. -->
        <ul class="places">
          <!-- Soonest expiry first, indefinite last (activeMarkers): what is
               about to vanish is what a master needs to see first. -->
          {#each markers as entry (entry.id)}
            <li>
              <button
                type="button"
                class="place"
                aria-label={`${t.pois.locate} ${entry.label}`}
                onclick={() => locatePoint(entry.lat, entry.lon)}
              >
                <span class="row">
                  <span class="place-name">{entry.label}</span>
                  <span class="grow"></span>
                  <span class="quiet">{remaining(entry)}</span>
                </span>
                <span class="place-meta">
                  {audienceLabel(entry.audience)} · {formatCoords(entry.lat, entry.lon)}
                </span>
              </button>
              <button
                type="button"
                class="reveal"
                disabled={busy}
                aria-label={`${t.marker.clear} ${entry.label}`}
                title={t.marker.clear}
                onclick={() => dropMarker(entry.id)}>×</button>
            </li>
          {/each}
        </ul>
        <div class="row">
          <span>{markers.length} {t.marker.slots}</span>
          <button type="button" disabled={busy} onclick={() => dropMarker()}>
            {t.marker.clearAll}
          </button>
        </div>
      {/if}

      <!-- Placing one happens in a floating window over the map, not here: the
           panel covers the stage, and a marker is a place. See `markerForm`. -->
      <div class="row">
        <button type="button" onclick={openMarkerForm}>{t.marker.open}</button>
      </div>
      <p class="hint">{t.marker.hint}</p>
      <p class="hint">{t.marker.pickHint}</p>
    </section>
{/snippet}

<!--
  Placing a marker, as a window over the map.

  It was a form inside the MARCAS panel, and the panel covers the stage — so
  the one thing a master needs while deciding where a marker goes was the one
  thing they could not see. The coordinate tool made that concrete: arming it
  had to close the panel, the tap landed, and the panel came back. Three state
  changes to read one number off a map that was there the whole time.

  As a window none of that exists. The map never leaves, arming is a button
  press with no consequence for the layout, and the coordinates appear in a
  field the master is already looking at. Draggable, because it is over the
  ground it is about.
-->
{#snippet markerForm()}
  <aside class="card marker-card" use:claimsFocus>
    <div class="card-head" use:draggable>
      <strong>{t.marker.place}</strong>
      <button
        type="button"
        class="close"
        aria-label={t.card.close}
        title={t.card.close}
        onclick={closeMarkerForm}>×</button>
    </div>
    <div class="card-body">
      <form onsubmit={place} class="stack">
        <label>
          {t.marker.label}
          <input bind:value={markerLabel} maxlength="48" required />
        </label>
        <div class="pair">
          <label>
            {t.marker.lat}
            <input bind:value={markerLat} inputmode="decimal" required />
          </label>
          <label>
            {t.marker.lon}
            <input bind:value={markerLon} inputmode="decimal" required />
          </label>
        </div>
        <!-- The armed state lives on this button, in inverse video (§9.4), and
             that is the whole announcement: the window is up whenever the tool
             is, so a banner across the map would be a second copy of a fact
             already on screen, printed over the thing being read. Typed
             coordinates still work — this is the faster of two routes to the
             same two fields, not a replacement for either. -->
        <button
          type="button"
          class:on={picking}
          aria-pressed={picking}
          onclick={() => (picking ? cancelPicking() : armPicking())}
        >
          {picking ? t.marker.armCancel : t.marker.arm}
        </button>
        <label>
          {t.marker.audience}
          <Select bind:value={markerAudience} options={audienceOptions} />
        </label>
        <label>
          {t.marker.ttl}
          <Select bind:value={markerTtl} options={ttlOptions} />
        </label>
        <!-- The sixth is refused rather than replacing anything (R-20b), so the
             button says so before the server has to. -->
        <button type="submit" disabled={busy || markerSlotsLeft <= 0}>{t.marker.place}</button>
      </form>
      {#if markerError}
        <p class="warning">{markerMessage(markerError)}</p>
      {:else if markerSlotsLeft <= 0}
        <p class="warning">{t.marker.limit}</p>
      {/if}
    </div>
  </aside>
{/snippet}

<!--
  The visibility mark, and the one icon in this file that is **not** drawn in
  CSS.

  The others are, and the reason recorded for that is an argument against
  *characters* rather than against vectors: the screen face is a bitmap revival,
  a glyph it lacks is a tofu box, and §9.7's four state marks were lost to
  exactly that. The one argument against SVG in the app is about the bezel's
  screws — "an asset to cache and a request to make" — and that is about a
  **file**. Inline, it is neither.

  A ring, a triangle and a reticle are shapes `border-radius` and a couple of
  gradients make exactly. A vesica is not: two corners each asking for all of an
  edge's height make the radii sum to twice that edge, and CSS answers an
  over-subscribed edge by shrinking *every* radius on the box by the same
  factor — so the points round off and a rounded rectangle comes back. Three
  attempts went into that before the shape was the thing at fault rather than
  the arithmetic.

  Two quadratics meeting at (2,12) and (22,12) are the points, said once.
-->
{#snippet eye(shut: boolean)}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M2 12 Q12 -1 22 12 Q12 25 2 12 Z"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
    />
    {#if shut}
      <path d="M4.5 4.5 L19.5 19.5" stroke="currentColor" stroke-width="2.5" />
    {:else}
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
    {/if}
  </svg>
{/snippet}

{#snippet sectorsSection()}
    <section>
      <h2>{t.sectors.title}</h2>
      <!--
        R-71's control, three levels deep because the geometry is (R-70) — but
        one switch: the eye on a zone closes that zone, the eye on a sector
        closes all of its zones, and the button on a district closes every zone
        under it. Nothing reconciles anything, because there is only ever one
        set of closed zones.

        Ordered by the geometry rather than alphabetically: the file's order is
        the order somebody walked the ground in, and a list sorted by name puts
        the road between two barrios it does not touch.
      -->
      {#if sectors.length === 0}
        <p>{t.sectors.empty}</p>
      {:else}
        {#each districts as district (district.id)}
          {@const districtZones = district.sectorIds.flatMap(
            (id) => sectors.find((sector) => sector.id === id)?.zoneIds ?? [],
          )}
          {@const districtShut = districtZones.length > 0 && districtZones.every(isClosed)}
          <div class="district">
            <div class="district-head">
              <span class="label">{district.name}</span>
              <button
                type="button"
                class="district-toggle"
                disabled={busy}
                aria-pressed={districtShut}
                onclick={() => toggleZones(districtZones, districtShut)}
              >
                {districtShut ? t.sectors.openAll : t.sectors.closeAll}
              </button>
            </div>
            <ul class="places">
              <!-- Pointing at a row lights its ground on the map. Mouse and
                   keyboard both: `focusin` is the keyboard's `mouseenter`, and
                   without it the index is unusable without a pointer. -->
              {#each district.sectorIds as sectorId (sectorId)}
                {@const sector = sectors.find((candidate) => candidate.id === sectorId)}
                {#if sector}
                  {@const sectorShut = sector.zoneIds.every(isClosed)}
                  <li
                    class:dimmed={sectorShut}
                    onmouseenter={() => pointAt('sector', sector.id)}
                    onmouseleave={() => pointAt('sector', null)}
                    onfocusin={() => pointAt('sector', sector.id)}
                    onfocusout={() => pointAt('sector', null)}
                  >
                    <!-- The row is the button, and what it does is take you
                         there — the same contract as a point's row. The eye
                         beside it is the only thing that changes the game. -->
                    <button
                      type="button"
                      class="place"
                      aria-label={`${t.sectors.locate} ${sector.name}`}
                      onclick={() => locateSector(sector.id)}
                    >
                      <span class="row">
                        <span class="place-name">{sector.name}</span>
                      </span>
                      <span class="place-meta">
                        {sector.zoneIds.length}
                        {t.sectors.zones}{sectorShut ? ` · ${t.sectors.closed}` : ''}
                      </span>
                    </button>
                    <!-- Before the nested list and not after it, or the grid
                         puts this on a row of its own under the zones: the
                         `.places` row is `1fr auto`, and a child spanning both
                         columns starts a new one for everything after it. -->
                    <button
                      type="button"
                      class="reveal"
                      class:shut={sectorShut}
                      disabled={busy}
                      aria-pressed={sectorShut}
                      aria-label={`${sectorShut ? t.sectors.open : t.sectors.close} ${sector.name}`}
                      onclick={() => toggleZones(sector.zoneIds, sectorShut)}
                    >
                      {@render eye(sectorShut)}
                    </button>
                    <!--
                      The zones, under the sector that holds them.

                      Only where there is more than one. A sector that is not
                      subdivided is a single leaf zone carrying the sector's own
                      name (R-70), so listing it would be a row repeating the
                      row above it — and the eye on the sector already closes
                      that one zone.
                    -->
                    {#if sector.zoneIds.length > 1}
                      <ul class="zones">
                        {#each sector.zoneIds as zoneId (zoneId)}
                          {@const zone = zonesById.get(zoneId)}
                          {#if zone}
                            <li
                              class:dimmed={isClosed(zone.id)}
                              onmouseenter={() => pointAt('zone', zone.id)}
                              onmouseleave={() => pointAt('zone', null)}
                              onfocusin={() => pointAt('zone', zone.id)}
                              onfocusout={() => pointAt('zone', null)}
                            >
                              <button
                                type="button"
                                class="zone"
                                aria-label={`${t.sectors.locate} ${zone.name}`}
                                onclick={() => locateZone(zone.id)}
                              >
                                {zone.name}
                              </button>
                              <button
                                type="button"
                                class="reveal small"
                                class:shut={isClosed(zone.id)}
                                disabled={busy}
                                aria-pressed={isClosed(zone.id)}
                                aria-label={`${isClosed(zone.id) ? t.sectors.open : t.sectors.close} ${zone.name}`}
                                onclick={() => toggleZones([zone.id], isClosed(zone.id))}
                              >
                                {@render eye(isClosed(zone.id))}
                              </button>
                            </li>
                          {/if}
                        {/each}
                      </ul>
                    {/if}
                  </li>
                {/if}
              {/each}
            </ul>
          </div>
        {/each}
        <p class="note">{t.sectors.hint}</p>
      {/if}
    </section>
{/snippet}

{#snippet poisSection()}
    <section>
      <h2>{t.pois.title}</h2>
      <!-- §4 gives the master every POI in both view modes, and until now they
           reached the screen as unlabelled dots on the scatter. A master directs
           players by name on the radio — "ve a Cangrezana" — so the names are the
           useful part, and 34 of them cannot be labels on a 320 px drawing. -->
      {#if payload.pois.length === 0}
        <p>{t.pois.empty}</p>
      {:else}
        <ul class="places">
          <!-- In the file's own order, which is by zone with entrances first: it
               is how somebody looks for a place they are about to name.

               Pointing at a row lights the point on the map. The names are not
               on the drawing and cannot be (§14.3), so the list is the index
               and the highlight is the lookup. Mouse and keyboard both, because
               `focusin` is the keyboard's `mouseenter`. -->
          {#each payload.pois as poi (poi.id)}
            <li
              class:dimmed={isHidden(poi.id)}
              onmouseenter={() => (highlightPoi = poi.id)}
              onmouseleave={() => (highlightPoi = null)}
              onfocusin={() => (highlightPoi = poi.id)}
              onfocusout={() => (highlightPoi = null)}
            >
              <!-- The row is the button, and what it does is take you there. A
                   diamond beside it would be a second target for one request;
                   the shape stays on the map, where §14.3 leaves it as the only
                   thing a point has to be recognised by. -->
              <button
                type="button"
                class="place"
                aria-label={`${t.pois.locate} ${poi.name}`}
                onclick={() => locatePoi(poi)}
              >
                <span class="row">
                  <span class="place-name">{poi.name}</span>
                </span>
                <span class="place-meta">
                  {t.pois.category[poi.category]} · {formatCoords(poi.lat, poi.lon)}
                </span>
              </button>
              <!--
                An eye, and the state is the icon rather than the word.

                The label used to read `OCULTAR` on a visible point and
                `MOSTRAR` on a hidden one, which names **the action** — so the
                control said the opposite of the state it was reporting and had
                to be read a row at a time to find out which points were hidden.
                An open eye and a slashed one are the state itself, in the same
                place on every row, so it is scanned rather than read.

                `aria-pressed` carries the same fact for anybody not looking at
                it, and the word survives as the accessible name.
              -->
              <button
                type="button"
                class="reveal"
                class:shut={isHidden(poi.id)}
                disabled={busy}
                aria-pressed={isHidden(poi.id)}
                aria-label={`${isHidden(poi.id) ? t.pois.show : t.pois.hide} ${poi.name}`}
                title={isHidden(poi.id) ? t.pois.show : t.pois.hide}
                onclick={() => void toggleHidden(poi.id)}
              >
                {@render eye(isHidden(poi.id))}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="hint">{t.pois.masterHint}</p>
    </section>
{/snippet}

  <div class="deck">
    <!--
      The stage is the map's row, and the panel is absolutely placed **inside
      it** rather than over the whole deck. Anchored to the deck it ran the full
      height, so a long panel's last rows ended up underneath the bar and could
      not be reached — the bar is drawn on top and the panel's own scroll had
      already ended.
    -->
    <div class="stage">
      <!--
        The corner the machine talks about itself from, and the only two things
        on this screen that are not game content: R-65's pilot and R-66's clock.
        Both are **in the recording on purpose**, which is why they are here
        rather than on the bar — the stage is what the capture keeps.

        R-66's clock reads `now`, and that is the whole of it: `now` is the
        cursor in a replay and the server's clock live, decided once at the top
        of this file, so the reading follows the panel without asking what the
        panel is doing. A clock with a mode of its own would be the second code
        path R-53 exists to prevent, spelled in four digits.

        The pilot is **the one place outside R-43 that uses the alarm colour on
        a map**, and the argument for it is narrow rather than a widening. R-43's
        warning is rendered by `PlayerView` and reaches no master screen ever, so
        the two cannot appear together and the colour is still telling exactly
        one thing apart on any screen it is on. It is also absent except while
        recording, which is the rest of why it does not compete: the clock beside
        it is phosphor, so red still means one thing here and it is not "time".
      -->
      <div class="hud">
        {#if recorder.recording}
          <p class="rec" aria-live="polite"><span class="rec-dot"></span>{t.replay.rec}</p>
        {/if}
        <p class="clock">[{formatClock(now)}]</p>
      </div>
      <!-- R-49: north up, no rotation, no pitch, in both view modes. The map is
           pickable because placing a marker by clicking real ground beats typing
           coordinates, and under the tool below it is the only way to do it. -->
      <GameMap
        {frame}
        {dots}
        basemap={payload.basemap}
        config={payload.config}
        viewer="MASTER"
        {authoritative}
        onPick={picking ? pickPoint : undefined}
        onSelect={(key) => (selected = key)}
        selected={selected ?? undefined}
        onPoi={(id) => (selectedPoi = id)}
        selectedPoi={selectedPoi ?? undefined}
        highlightPoi={highlightPoi ?? undefined}
        {highlightZoneIds}
        {closedZoneIds}
        {focus}
      />

      <!--
        The armed tool announces itself on the window's own button, and nowhere
        else. It had a banner across the top of the map — which was right while
        the form lived in a panel and there was nothing else on screen to put
        the mode on, and is a strip of covered map now that the window is always
        up whenever the tool is armed. Arming forces it open and closing it
        disarms, so the two cannot come apart.
      -->
      {#if placingMarker}
        {@render markerForm()}
      {/if}

      <!--
        What a point is, opened from the point. The master has no position of
        their own, so there is no distance to give — `PoiCard` leaves the line
        out rather than printing a dash, because a blank distance reads as a
        reading and there is none.
      -->
      {#if selectedPoiRecord}
        <PoiCard
          poi={selectedPoiRecord}
          zones={payload.zones}
          sectors={payload.sectors}
          anchor="top-right"
          onclose={() => (selectedPoi = null)}
        />
      {/if}

      <!--
        The floating card. Everything about one person that used to need a table
        column, plus the one control that belongs beside a name rather than in a
        list: R-14 and R-29's radio contact.

        Gated exactly as the roster is, and by the same values — `eliminated` is
        simply not on the record outside AUTHORITATIVE (R-22, R-31), so there is
        no second decision here to get wrong.
      -->
      {#if selectedPlayer}
        <aside class="card" use:claimsFocus>
          <!-- The title bar is the grip. Six players on a venue map means cards
               land on top of the person they describe; moving one is faster than
               closing it, panning, and opening it again. -->
          <div class="card-head" use:draggable>
            <strong>{selectedPlayer.callsign}</strong>
            <button
              type="button"
              class="close"
              aria-label={t.card.close}
              title={t.card.close}
              onclick={() => (selected = null)}>×</button>
          </div>
          <div class="card-body">
            {#if selectedPlayer.fullName}<p>{selectedPlayer.fullName}</p>{/if}
            {#if selectedPlayer.position}
              {@const state = game.linkState(selectedPlayer, now)}
              <p>
                <span class="q">{t.q.qth}</span>
                {formatCoords(selectedPlayer.position.lat, selectedPlayer.position.lon)}
              </p>
              <p>
                {state ? t.state[state] : '—'}
                · {formatUncertainty(game.uncertaintyMetres(selectedPlayer, now))}
                · {formatAge(selectedPlayer.position.ts, now)}
              </p>
              <p class="hint">
                {t.card.source}:
                {selectedPlayer.position.source === 'LIVE' ? t.card.live : t.card.lastKnown}
                · {t.players.place}: {placeName(
                  payload.zones,
                  payload.sectors,
                  selectedPlayer.position.zoneId,
                )}
              </p>
            {:else}
              <p>{t.players.noPosition}</p>
            {/if}
            {#if selectedPlayer.battery !== undefined}
              <p class="hint"><span class="q">{t.q.qrp}</span> {selectedPlayer.battery}%</p>
            {/if}
            {#if selectedPlayer.deviceId}
              <!-- `t.players.device`, not a word of its own. The card said
                   "EQUIPO" for the phone and the team select says "EQUIPO" for
                   the team, one line apart — two different things wearing one
                   word, in the one place a master checks which phone is on
                   which person. -->
              <p class="hint"><span class="q">{t.players.device}</span> {selectedPlayer.deviceId}</p>
            {/if}
            {#if selectedPlayer.radioContact}
              <p class="hint">
                <span class="q">{t.q.qsl}</span>
                {formatAge(selectedPlayer.radioContact.ts, now)}
                · {t.radio.by}
                {reporterName(selectedPlayer.radioContact.reportedBy)}
              </p>
            {/if}
            {#if selectedPlayer.eliminated}
              <p>
                <strong>{t.players.eliminated}</strong>
                · {formatAge(selectedPlayer.eliminated.ts, now)}
              </p>
              <p class="hint">
                {t.players.dropPoint}:
                {selectedPlayer.eliminated.dropPoint
                  ? formatCoords(
                      selectedPlayer.eliminated.dropPoint.lat,
                      selectedPlayer.eliminated.dropPoint.lon,
                    )
                  : t.players.noDropPoint}
              </p>
            {/if}
            <!-- Moving somebody between teams, which left the roster with the
                 team column: grouping made the column redundant and this is the
                 one thing it also did. Setup only, like every other roster
                 edit. -->
            {#if setupPhase}
              <label class="move">
                <span class="q">{t.players.team}</span>
                <Select
                  value={selectedPlayer.teamId ?? ''}
                  options={teamOptions}
                  disabled={busy || !configurable}
                  onchange={(next) => rosterAction(() => movePlayerToTeam(selectedPlayer.id, next))}
                />
              </label>
            {/if}
            <div class="row">
              <!-- R-13's hint as a tooltip rather than a paragraph: it explains
                   the button beside it, is read once, and a card is small. -->
              <!-- `QSL`, like the button on the player's own roster. The card
                   already prints `QSL 45s · por DIRECCION` two lines above, so
                   the long form was the same fact said twice in one card, in
                   two registers, and the long one was the wider of the two in
                   the narrowest surface in the app. -->
              <button
                type="button"
                class="q"
                disabled={busy}
                aria-label={t.radio.record}
                title={`${t.radio.record} — ${t.radio.hint}`}
                onclick={() => guarded(() => recordRadioContact(selectedPlayer.id))}
              >
                {t.q.qsl}
              </button>
              <!-- R-32, and the same gate the column has: the control's presence
                   is the leak, so it exists only where elimination does. -->
              {#if authoritative && selectedPlayer.eliminated}
                <!-- Through `bringBack()`, which confirms first (R-32). The card
                     is the only door to this now that the roster has no revive
                     column, so the confirmation has to be on this one. -->
                <button
                  type="button"
                  disabled={busy}
                  onclick={() => bringBack(selectedPlayer.id, selectedPlayer.callsign)}
                >
                  {t.players.revive}
                </button>
              {/if}
            </div>
          </div>
        </aside>
      {:else if selectedDevice}
        <aside class="card" use:claimsFocus>
          <div class="card-head" use:draggable>
            <strong>{selectedDevice.deviceId}</strong>
            <button
              type="button"
              class="close"
              aria-label={t.card.close}
              title={t.card.close}
              onclick={() => (selected = null)}>×</button>
          </div>
          <div class="card-body">
            <p>
              <span class="q">{t.q.qth}</span>
              {formatCoords(selectedDevice.lat, selectedDevice.lon)}
            </p>
            <p class="hint">{formatAge(selectedDevice.lastSeen, now)} · {selectedDevice.pings}</p>
          </div>
        </aside>
      {/if}

    <!--
      One panel at a time, and grouped by what the master is doing rather than by
      which requirement introduced it: everything about people in one, everything
      about the game in another. A panel per section would be fifteen buttons on
      a bar that has to be usable one-handed.
    -->
    {#if open}
      <!--
        PERSONAL is a rail down the left; every other panel takes the stage.

        The difference is what the panel is *for*. The roster is read **against
        the map** — a name here selects a dot there, and a master watching one
        team move needs both at once. The rest are places you go to do one thing
        and come back: set the state, place a marker, read the log. Those earn
        the whole stage; the roster would lose its own purpose with it.
      -->
      <!-- `tabindex="-1"` so focus can be put here when it opens: not reachable
           by Tab, reachable by script, which is what a container that has just
           appeared needs. -->
      <aside
        class="panel"
        class:rail={open === 'TEAM' || open === 'MARKS'}
        tabindex="-1"
        bind:this={panelBox}
      >
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
          {#if open === 'TEAM'}
            {@render playersSection()}
            {@render teamsSection()}
            {@render traySection()}
            {@render invitesSection()}
          {:else if open === 'GAME'}
            {@render gameStateSection()}
            {@render resetSection()}
          {:else if open === 'MARKS'}
            <!--
              A rail, like PERSONAL, and the schematic is gone with the two
              columns it needed.

              It was a 320 px drawing beside two tables, in a panel covering the
              whole stage — a second, smaller, unlabelled copy of the map it was
              covering. As a rail the list sits **beside** the real map instead,
              and pointing at a row lights that point on it, which is the lookup
              the scatter was there to provide.

              What the scatter also was is a keyboard route to picking a
              coordinate: its plot was a real button. That route is the marker
              form's own LAT and LNG fields, which is where a keyboard was
              always going to be faster than aiming at a drawing.
            -->
            {@render markersSection()}
            {@render poisSection()}
            <!-- Under the points, not over them. A master reaches for a point
                 every few minutes and for a sector a handful of times in a
                 game, and the panel's order is how often a thing is wanted. -->
            {@render sectorsSection()}
          {/if}
        </div>
      </aside>
    {/if}
    </div>

    <!--
      REGISTRO, docked rather than staged.

      Its own row of the deck, which is the difference that matters: the map is
      **shortened** above it instead of covered, so the log can be left open for
      a whole session with the ground still on screen. An overlay would have
      given the same picture and taken the map's bottom edge with it — and the
      map is the interface here, not a picture of one.

      `resize` is MapLibre's problem and already solved: the container changes
      height, the observer in `GameMap` catches it, and the camera keeps its
      centre. That is the same observer the webfont swap needed.
    -->
    {#if dock}
      <aside class="dock" class:fitted={dock === 'REPLAY'} tabindex="-1" bind:this={dockBox}>
        <div class="panel-head">
          <h2>{PANEL_LABEL[dock]}</h2>
          <button
            type="button"
            class="close"
            aria-label={t.panels.close}
            title={t.panels.close}
            onclick={() => dock && toggleDock(dock)}>×</button>
        </div>
        {#if dock === 'LOG'}
          {@render eventsSection()}
        {:else}
          {@render replaySection()}
        {/if}
      </aside>
    {/if}

    <!--
      The only permanently visible chrome. Controls on the left, state on the
      right, and R-25's countdown among the labels rather than in a panel — the
      mode ending mid-read is the requirement working, and a master who cannot
      see it coming reads it as the panel breaking.
    -->
    <div class="bar">
      <!--
        Q code, above the controls rather than beside them.

        On one line the readings competed with eight buttons for the same strip
        and lost — squeezed to the right edge and read as a tail of the row. A
        line of their own, quieter than the controls and taller than nothing, is
        what a status line is: R-29 runs this game on walkies, three letters read
        at a glance where a Spanish word does not, and a label per value stops a
        row of bare words reading as one. QSA is a 1-to-5 scale on a real set.
      -->
      <div class="bar-state">
        <span class="reading">
          <span class="q">{t.q.qrv}</span>
          <span class="label">{t.game.states[payload.game.state]}</span>
        </span>
        <!-- The same reading the player's panel prints, and deliberately not a
             connection indicator. It printed 5 for an open socket and 1 for a
             closed one, which is a fact about a WebSocket: true, checkable, and
             nothing a master would ever act on. On R-21d's ladder it says how
             much of the game is reaching a screen — 0 nothing, 3 your sector,
             5 your team anywhere — which is a setting this panel owns and has
             to be able to see the effect of. -->
        <span class="reading">
          <span class="q">{t.q.qsa}</span>
          <Qsa level={game.signal} label="{t.q.qsa} {game.signal}/5" />
        </span>
        {#if authoritative}
          <span class="warning">{t.view.warning}</span>
          {#if revertSeconds !== undefined}
            <span class="label">{t.view.revertsIn} {formatDuration(revertSeconds)}</span>
          {/if}
        {:else if revertedNotice}
          <span class="warning">{t.view.reverted}</span>
        {/if}

        <!-- The machine's own marking, at the far end of the line and pushed
             there rather than ordered there: R-24's warning and its countdown
             appear and disappear in this row, and a version that moves when
             they do is the one thing on the bar that has no business moving.
             It is the same string the boot prints, so the terminal cannot give
             two answers about what it is running. -->
        <span class="version">{t.boot.version}</span>
      </div>

      <div class="bar-controls">
        {#snippet panelButton(entry: { id: BarId; key: string })}
          <button type="button" class:on={barOn(entry.id)} onclick={() => toggleBar(entry.id)}>
            <kbd>{keyLabel(entry.key)}</kbd>
            {PANEL_LABEL[entry.id]}
          </button>
        {/snippet}

        <!-- Who is out there, and what state the game they are in is in. -->
        <div class="block">
          {#each panelsIn('who') as entry (entry.id)}{@render panelButton(entry)}{/each}
        </div>

        <!-- What has already happened. -->
        <div class="block">
          {#each panelsIn('record') as entry (entry.id)}{@render panelButton(entry)}{/each}
        </div>

        <!-- The ground, and the clock over it. The marker window belongs here
             rather than among the panels: what it opens is a window over the
             map, and R-20b's marker is the one master action that is entirely
             about a place. R-57's replay is absent outside AUTHORITATIVE and
             its key with it — the control's presence is the leak, exactly as it
             is for R-32's revive. -->
        <div class="block">
          {#each panelsIn('where') as entry (entry.id)}{@render panelButton(entry)}{/each}
          <!-- After the numbers, so the digits in this block still ascend and
               the letter is not in the middle of them. -->
          <button
            type="button"
            class:on={placingMarker}
            onclick={() => (placingMarker ? closeMarkerForm() : openMarkerForm())}
          >
            <kbd>{keyLabel(MARKER_KEY)}</kbd>
            {t.marker.open}
          </button>
          <!-- R-68c. In this block because what it changes is how much ground is
               on screen, which is the question the rest of this block answers —
               and `on` rather than a second label, since the state is what the
               press toggles. Absent where the browser refuses it outright. -->
          {#if display.canFullscreen}
            <button
              type="button"
              class:on={display.fullscreen}
              onclick={() => void display.toggleFullscreen()}
            >
              <kbd>{keyLabel(FULLSCREEN_KEY)}</kbd>
              {t.map.fullscreen}
            </button>
          {/if}
        </div>

        <!-- What the master is allowed to see (R-22). Its own block, because it
             is the only control here that changes the rules rather than the
             view. -->
        <div class="block">
          {#each VIEW_MODES as mode (mode)}
            <button
              type="button"
              class:mode-on={game.viewMode === mode}
              disabled={busy || game.viewMode === mode}
              onclick={() => switchMode(mode)}
            >
              <kbd>{keyLabel(MODE_KEYS[mode])}</kbd>
              {t.view[mode]}
            </button>
          {/each}
        </div>

        <!-- Alone at the far end, and with no key. It is the one control that
             ends the session, and a stray letter must not reach it. -->
        <div class="block away">
          <button
            type="button"
            onclick={() => guarded(async () => { await logout(); await game.reload(); })}
          >
            {t.session.logout}
          </button>
        </div>
      </div>
    </div>
    <!-- The dim that `::backdrop` is no longer allowed to draw. Inside the
         deck, so the tube clips it; `pointer-events: none` because the dialog
         above is already blocking everything underneath. -->
    {#if confirming || ask}
      <div class="briefing-dim" aria-hidden="true"></div>
    {/if}
  </div>

    <!-- R-24. Outside the section above so `showModal()` can make that section
         inert along with the rest of the panel.
         `onclose` rather than only the buttons: Escape closes a modal dialog
         without going through either of them. -->
    <!--
      Every confirmation that is not R-24's briefing. One element, because they
      are one question with different stakes — and because six native dialogs
      were six controls that stop working, silently, in a browser that has been
      told to suppress them.

      `danger` is red, and that does not contradict R-43. That requirement owns
      the only colour on a **map**, where the boundary warning has to be
      distinguishable from game content at a glance; this is a modal sheet the
      master opened, over an inert panel, and what it is saying is that the
      thing behind the button does not come back.
    -->
    <dialog
      bind:this={askDialog}
      class:danger={ask?.danger}
      onclose={() => (ask = null)}
    >
      {#if ask}
        <h2>{ask.title}</h2>
        {#each ask.lines as line}
          <p>{line}</p>
        {/each}
        {#if ask.input}
          <form class="stack" onsubmit={(event) => { event.preventDefault(); void acceptAsk(); }}>
            <label>
              {ask.input.label}
              <!-- `autofocus` is right here and almost nowhere else: the dialog
                   opened because the master asked a question, and the answer is
                   this field. -->
              <!-- svelte-ignore a11y_autofocus -->
              <input bind:value={askTyped} autofocus />
            </label>
          </form>
        {/if}
        <div class="row">
          <button type="button" disabled={busy || !askReady} onclick={() => void acceptAsk()}>
            {ask.accept}
          </button>
          <button type="button" onclick={() => askDialog?.close()}>
            {t.view.confirm.cancel}
          </button>
        </div>
      {/if}
    </dialog>

    <dialog bind:this={confirmDialog} onclose={() => (confirming = false)}>
      <h2>{t.view.confirm.title}</h2>
      <p>{t.view.confirm.body}</p>
      <p><strong>{t.view.confirm.duty}</strong></p>
      <p>{t.view.confirm.logged}</p>
      <p>{t.view.confirm.revert}</p>
      <div class="row">
        <button type="button" disabled={busy} onclick={() => acceptAuthoritative()}>
          {t.view.confirm.accept}
        </button>
        <button type="button" onclick={() => confirmDialog?.close()}>
          {t.view.confirm.cancel}
        </button>
      </div>
    </dialog>
{/if}


<style>
  /**
   * The deck. The map is the layer, not a section of one, so it is absolutely
   * placed and everything else floats over it — which is also why nothing here
   * scrolls except the inside of an open panel.
   */
  .deck {
    position: relative;
    height: 100%;
    display: grid;
    /* Map, then the log dock when it is open, then the bar. `auto` for the dock
       row so it is exactly nothing when it is not there — a row with a height
       and no content is a strip of dead screen, which is what the map already
       grew once by accident.

       `minmax(0, 1fr)` for the map, not `1fr`: a bare `1fr` is
       `minmax(auto, 1fr)`, whose automatic minimum is the row's min-content
       height. The map has a minimum, so the stage refuses to shrink and the
       rows below it push the bar off the deck. */
    grid-template-rows: minmax(0, 1fr) auto auto;
    overflow: hidden;
  }

  /**
   * The log dock: full width, a few lines tall, and **in the flow** rather than
   * over the map.
   *
   * `min(14lh, 32vh)` is the whole sizing rule. Lines rather than pixels because
   * what it holds is lines, and a ceiling because on a phone in landscape 14
   * lines is most of the screen — at which point it has stopped being a dock
   * and become the panel it replaced.
   *
   * **`vh` and not `%`, and `minmax(0, 1fr)` and not `1fr`.** Both are the same
   * mistake and between them they gave the dock the whole screen on the first
   * try, with the short content sitting at the top of it:
   *
   * - a percentage height resolves against the containing block, and the row
   *   this sits in is `auto`, which is to say indefinite. There is nothing for
   *   `40%` to be 40% of;
   * - `1fr` is `minmax(auto, 1fr)`, and that automatic minimum is min-content.
   *   The lines are the content, so the track grew to fit two hundred of them
   *   and the `overflow: auto` below never had anything to scroll.
   */
  .dock {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: min(14lh, 32vh);
    min-height: 0;
    background: var(--panel);
    border-top: 1px solid var(--phosphor-dim);
    z-index: 2;
  }

  /**
   * REPETICIÓN takes the height it needs and no more.
   *
   * The log's fixed height is right for a log: a tail is worth as many lines as
   * can be spared, and a box that grew with its content would move the map's
   * bottom edge every few seconds. A row of controls and a scrub bar is a fixed
   * amount of interface, and every line it takes past that is map — which is the
   * thing the replay exists to move and the reason R-62 docked it in the first
   * place.
   */
  .dock.fitted {
    height: auto;
  }

  .dock section {
    padding: 0.4lh 0.6ch;
    display: grid;
    gap: 0.6lh;
    align-content: start;
    min-width: 0;
  }

  /**
   * REPETICIÓN's own density, and it is the requirement rather than taste.
   *
   * R-62 docked these controls so **the map stays visible while the cursor
   * moves**, and the dock was taking two thirds of the screen to say six things.
   * Most of that was not the controls: paragraphs keep the user agent's `1em`
   * margins, and this grid already puts a gap between its rows, so every line of
   * warning cost three.
   *
   * The margins go and the gap halves. The log next door keeps both, because a
   * tail of lines is content and wants the air; this is a fixed amount of
   * interface with a map above it.
   */
  .dock section.replay {
    gap: 0.3lh;
  }

  .dock section.replay p {
    margin: 0;
  }

  /**
   * The transport buttons. Square already — every button in the app carries
   * R-9's `--touch` as a floor on both axes — so there is nothing to size here,
   * only a mark to centre and a number to sit beside it.
   */
  .transport {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.6ch;
  }

  /**
   * The marks, drawn rather than lettered, for the reason `glyphs.ts` records in
   * full: the app ships VT323 and VT323 has none of these characters, so a
   * lettered `▶` is whatever the operating system happens to supply — a
   * different advance on every machine, and a tofu box where there is no glyph
   * at all.
   *
   * `currentColor` throughout, so all three survive the inverse video a button
   * takes on hover and invert with the palette in daylight, with no second rule.
   * Same box and same technique as the map's camera toggle.
   *
   * The box itself is `.icon`, declared once further down for the eye and the
   * diamond — "one size for both marks, whether they are drawn in CSS or in
   * vectors" is already the rule, and these are two more of them.
   */
  .icon[data-icon='play']::before {
    content: '';
    position: absolute;
    inset: 0;
    background: currentColor;
    clip-path: polygon(14% 4%, 96% 50%, 14% 96%);
  }

  /* Two bars, as two background slices rather than two pseudo-elements: the
     shape is symmetrical and one gradient pair says so in one place. */
  .icon[data-icon='pause']::before {
    content: '';
    position: absolute;
    inset: 0;
    background:
      linear-gradient(currentColor, currentColor) 16% 50% / 26% 92% no-repeat,
      linear-gradient(currentColor, currentColor) 84% 50% / 26% 92% no-repeat;
  }

  /**
   * The double arrow. Two triangles, so two pseudo-elements — a `clip-path`
   * polygon is one closed path and cannot be in two places.
   */
  .icon[data-icon='speed']::before,
  .icon[data-icon='speed']::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 52%;
    background: currentColor;
    clip-path: polygon(0 8%, 100% 50%, 0 92%);
  }

  .icon[data-icon='speed']::before {
    left: 0;
  }

  .icon[data-icon='speed']::after {
    right: 0;
  }

  .dock:focus,
  .dock:focus-visible {
    outline: none;
  }

  /**
   * The lines, and the only scrolling surface outside a panel.
   *
   * `overflow-anchor: none` because the browser's own scroll anchoring fights
   * `stickToTail`: as rows are appended at the bottom it tries to keep the
   * visual position of what you were looking at, which is the same job done by
   * a different rule, and the two together leave the tail one line short.
   */
  .log-lines {
    overflow: auto;
    overflow-anchor: none;
    /* The other half of the row's `minmax(0, …)`: a grid item's own automatic
       minimum is min-content too, so without this the box is as tall as its
       lines however the track was sized. */
    min-height: 0;
    padding: 0.2lh 0.6ch;
  }

  /**
   * One event, one line, columns by width rather than by rule.
   *
   * `white-space: pre` on the row: a long detail runs off the right and is
   * scrolled to, which is what a console does. Wrapping it would push the next
   * event down a line and take the vertical rhythm — the thing that makes a log
   * scannable — with it.
   */
  .log-line {
    margin: 0;
    display: flex;
    gap: 1.5ch;
    white-space: pre;
    line-height: 1.15;
  }

  /**
   * Widths in `ch`, which line up exactly because the screen font is
   * monospace. This is the tabulation, and it is the only one there is.
   *
   * `min-width`, not `width`. A value longer than its column — a new event kind
   * past 26 characters, `AUTHORITATIVE_REVERTED` is 22 — pushes the rest of
   * *that* line right instead of overlapping the next field. One misaligned row
   * reads as a long name; overlapping text reads as a broken screen.
   *
   * The age needs 6: `59min` is the longest `formatAge` produces.
   */
  .log-age {
    flex: none;
    min-width: 6ch;
    text-align: right;
    color: var(--phosphor-dim);
  }

  .log-kind {
    flex: none;
    min-width: 26ch;
    color: var(--phosphor-bright);
  }

  .log-detail {
    color: var(--phosphor);
  }

  .log-empty {
    margin: 0;
    padding: 0.4lh 0.6ch;
    color: var(--phosphor-dim);
  }

  /**
   * One panel, over the map, nearly the whole tube. Editing a roster of six
   * with a keyboard on a phone is already the hardest thing this app asks of
   * anyone; making it share the screen with a map underneath would be worse
   * than the table it replaced.
   */
  /* The map's row. `min-height: 0` is what stops a grid row being sized by its
     content, which is how a full-height map pushes the bar off the bottom. */
  .stage {
    position: relative;
    min-height: 0;
  }

  /**
   * R-65. Everything that is furniture for running the game goes while the
   * screen is being recorded; everything that *is* the game stays, bezel and
   * scanlines included.
   *
   * `display: none` rather than opacity, because an invisible bar still takes
   * its row of the deck and the map would keep the shape of a control that is
   * not in the frame.
   */
  :global(html[data-recording]) .bar,
  :global(html[data-recording]) .dock,
  :global(html[data-recording]) .panel {
    display: none;
  }

  /**
   * The pilot and the clock share one row, and the row is what is positioned.
   *
   * Two absolutely placed corners would have to agree about a width that is not
   * fixed — REC is there or it is not — so the clock would step sideways when a
   * recording started. One flex row is also what keeps them on the same baseline
   * while they are lettered in two different faces.
   *
   * `--overlay` under both, and no bloom in either: this sits on the map, and
   * §9's `text-shadow` spreads a glyph into amber roads and zone dashes. It is
   * the same plate `.fault` and the scale take, for the same reason, and the
   * same cancel `GameMap` applies to the callsigns.
   *
   * **Above the map and under everything the master opens.** `1` puts it over
   * the canvas and the map's own chrome column, and beneath `.panel` and
   * `.card`, which are both `2`. It arrived at `4` from the pilot it replaced —
   * right for a light that only exists while a recording is running, and wrong
   * the moment the clock made this row permanent: PERSONAL is a rail down the
   * left edge and the clock was printing across the top of it.
   *
   * This is the same treatment the scale and the faults get, which is the
   * argument for it: stage furniture goes under a panel, because a panel is what
   * the master opened instead of looking at the stage. Nothing is lost while
   * recording either — R-65 hides the panel outright, so there is nothing there
   * to be under.
   */
  .hud {
    position: absolute;
    top: 0.6lh;
    left: 0.8ch;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 1.2ch;
    padding: 0.1lh 0.6ch;
    background: var(--overlay);
    text-shadow: none;
    pointer-events: none;
  }

  /**
   * The pilot. Case lettering and alarm red, which is §9's register for the
   * machine speaking from outside the fiction — the same one `.fault` and
   * `.scale` are in, and the reason it may hold the one colour is in the markup.
   */
  .rec {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.6ch;
    font-family: var(--case-font);
    font-size: 0.8rem;
    letter-spacing: 0.08em;
    color: var(--alarm);
  }

  /**
   * R-66. The screen face rather than the case face, and that is the split §9
   * makes: `--case-font` is lettering printed on the box — the pilot beside it,
   * the scale, a fault — and this is a **reading**, which is what the tube
   * draws. The same decision `--label-font` records for every `QTH` and `BAT`
   * in the app.
   *
   * Phosphor and not alarm, because it is the master's answer to "when is this",
   * which is a fact about the game and not a warning about the machine. The
   * brackets are in the markup rather than in `formatClock()`: they are how a
   * terminal prints a field, and the formatter is also what writes a filename.
   */
  .clock {
    margin: 0;
    font-size: 0.95rem;
    letter-spacing: 0.04em;
    color: var(--phosphor);
  }

  .rec-dot {
    width: 0.8ch;
    height: 0.8ch;
    border-radius: 50%;
    background: var(--alarm);
    /* The only thing on this screen that blinks, and it is not game content —
       §9 animates the flicker on an empty overlay and nothing else, for the
       compositing reason in CLAUDE.md. A 2 px dot is not that. */
    animation: rec-blink 1.4s steps(1, end) infinite;
  }

  @keyframes rec-blink {
    0%,
    60% {
      opacity: 1;
    }
    61%,
    100% {
      opacity: 0.15;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .rec-dot {
      animation: none;
    }
  }

  /**
   * Exactly the stage, never the deck. `inset: 0` on the stage is what keeps the
   * panel's own scroll ending where the bar begins — anchored to the deck, a
   * long panel's last rows sat under the bar with nothing left to scroll.
   */
  .panel {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-rows: auto 1fr;
    background: var(--panel);
    border-bottom: 1px solid var(--phosphor-dim);
    z-index: 2;
  }

  /**
   * PERSONAL, down the left edge, with the map still readable beside it.
   *
   * A width in `ch` rather than a percentage: what has to fit is a callsign, a
   * state mark and an age, and those are measured in characters. On a phone the
   * `min()` gives it the screen, which is the honest answer — there is no map
   * left to keep visible at that width.
   *
   * Sized for PREPARATION rather than for a running game: during setup this
   * panel also carries the forms, the team list and the pairing tray, and a
   * rail that only fits while the game is already going is a rail that scrolls
   * sideways on the one screen where the master is typing.
   *
   * The widest thing left in it is a team row — name, count, rename, delete —
   * at about 31 columns, now that the tables in here are lists and the forms
   * stack. This is that with room to breathe rather than the width those
   * tables needed.
   */
  .panel.rail {
    right: auto;
    width: min(44ch, 100%);
    border-right: 1px solid var(--phosphor-dim);
  }

  /* A grid item's floor is its min-content width, so one long word inside a
     section widens the whole column instead of wrapping. Scoped to the rail:
     the full-stage panels still carry tables, and those are meant to overflow
     into the body's scroll rather than be clipped by a section that cannot. */
  .panel.rail .panel-body,
  .panel.rail section {
    min-width: 0;
  }

  /* Focused by script when it opens, so `Tab` continues inside it rather than
     behind it — but a ring around a container nobody navigated to is a ring
     that reads as a fault. The controls inside keep theirs. */
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
    min-height: calc(var(--touch) * 0.7);
  }

  .panel-head button:hover:not(:disabled),
  .panel-head button:focus-visible {
    background: var(--screen);
    color: var(--phosphor);
  }

  /**
   * The places: markers and points, as two-line entries with their controls in
   * a column down the right — the same list the player's own points panel is,
   * because a rail is a rail.
   *
   * It was two tables of four and five `nowrap` columns inside a full-stage
   * panel with a 320 px schematic beside them. What replaced the schematic is
   * the map itself: the panel is a rail now, so the list is beside the drawing
   * rather than covering it.
   */
  .places {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    /* Wider than the gap inside an entry, so the meta line belongs to the name
       above it rather than to whichever neighbour the spacing picks. */
    gap: 0.9lh;
  }

  .places li {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: start;
  }

  .place {
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

  .place-meta {
    margin: 0;
    font-size: 0.82em;
    color: var(--phosphor-dim);
  }

  .place:hover:not(:disabled),
  .place:focus-visible {
    background: var(--phosphor);
    color: var(--screen);
    text-shadow: none;
  }

  /* Every child that names its own colour has to give it back, or the plate and
     the text resolve to the same value in high contrast, where `--phosphor`
     *is* `--phosphor-bright`. */
  .place:hover:not(:disabled) .place-name,
  .place:hover:not(:disabled) .place-meta,
  .place:hover:not(:disabled) .quiet,
  .place:focus-visible .place-name,
  .place:focus-visible .place-meta,
  .place:focus-visible .quiet {
    color: inherit;
  }

  /**
   * R-71's list, grouped by district.
   *
   * The gap between districts is wider than the gap between sectors inside one,
   * because that is the whole shape of the control: thirteen rows and a
   * fourteenth that is a different town, with a group button for each. Without
   * it the list reads as fourteen equal things and the group button looks like
   * it belongs to whichever row it is nearest.
   */
  .district + .district {
    margin-top: 1.2lh;
  }

  .district-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1ch;
    margin-bottom: 0.5lh;
    border-bottom: 1px solid var(--phosphor-deep);
    padding-bottom: 0.2lh;
  }

  .district-head .label {
    color: var(--phosphor-bright);
  }

  .district-toggle {
    min-height: var(--touch);
    padding: 0.1lh 0.8ch;
    background: transparent;
    border: 1px solid var(--phosphor-deep);
    color: var(--phosphor-dim);
  }

  .district-toggle:hover:not(:disabled),
  .district-toggle:focus-visible {
    background: var(--phosphor);
    color: var(--screen);
    text-shadow: none;
  }

  /**
   * A sector's zones, under it and indented to say so.
   *
   * Across both columns of the `.places` grid, because the row above has an eye
   * in the second one and these have no control of their own — the switch is the
   * sector (R-71). Indented by the width of that eye so the nesting is a shape
   * rather than a caption.
   */
  .zones {
    grid-column: 1 / -1;
    list-style: none;
    margin: 0.1lh 0 0 1.6ch;
    padding: 0;
    display: grid;
  }

  /* Its own eye in the second column, lining up under the sector's (R-71). */
  .zones li {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
  }

  .zone {
    min-height: var(--touch);
    width: 100%;
    padding: 0 0.6ch;
    border: 1px solid transparent;
    background: transparent;
    color: var(--phosphor-dim);
    text-align: left;
    text-transform: none;
    letter-spacing: normal;
    font-size: 0.82em;
  }

  .zone:hover:not(:disabled),
  .zone:focus-visible {
    background: var(--phosphor);
    color: var(--screen);
    text-shadow: none;
  }

  .places li.dimmed .zone {
    color: var(--phosphor-deep);
  }

  /**
   * A hidden point stays in the list, quieter.
   *
   * Removing it would be the obvious thing and the wrong one: this is the only
   * place a hidden point can be found again, and a list that drops what you hid
   * is a list you cannot undo from. §4 is not involved — the point is still
   * projected and still exists; it is this master's drawing it is off.
   *
   * R-71's closed sectors share the rule and the class, because they are the
   * same shape of decision: the list is where one is opened again, and its
   * ground stays on the master's map quieter still rather than leaving the row
   * naming somewhere that is nowhere on the screen.
   */
  .places li.dimmed .place-name,
  .places li.dimmed .place-meta {
    color: var(--phosphor-deep);
  }

  /**
   * PARTIDA's settings grid: **label, reading, controls**, three columns lining
   * up down every row.
   *
   * A `<dl>` because that is what this is — a term and what it currently is —
   * and the alignment is the point: the panel was four sections in four shapes
   * and a master coming to it mid-game had to read it rather than take it in.
   *
   * This block was deleted by accident in the commit that made MAPA a rail, and
   * what that looked like on screen is worth recording: the markup still says
   * `<dl>`, so the browser's own styling took over — term on its own line,
   * definition indented by the user-agent's 40 px, no columns at all. It reads
   * as a panel that was never laid out rather than as one whose stylesheet lost
   * a block, which is why it came back as "everything looks cramped".
   */
  .settings {
    display: grid;
    grid-template-columns: auto auto 1fr;
    align-items: baseline;
    /* Separates one setting from the next. It was 0,3lh, which was also the gap
       inside a row — and a panel where everything is equally spaced is a panel
       with no rows in it. */
    gap: 0.7lh 1.4ch;
    margin: 0;
  }

  .settings dt {
    font-family: var(--label-font);
    font-size: var(--label-size);
    letter-spacing: var(--label-tracking);
    color: var(--phosphor-dim);
  }

  .settings dd {
    margin: 0;
    min-width: 0;
    /* The reading and its aside are one line, or they are two readings. */
    white-space: nowrap;
  }

  /* The state itself, at the top of the palette: it is the reading, and the
     label and the buttons either side of it are not. */
  .settings .reading {
    color: var(--phosphor-bright);
  }

  /* A second fact about the same row — the sector count beside the profile —
     which is neither the reading nor a control, and carries the label's
     lettering so the row does not come out in three type sizes. */
  .settings .aside {
    font-family: var(--label-font);
    font-size: var(--label-size);
    letter-spacing: var(--label-tracking);
    color: var(--phosphor-dim);
    margin-left: 1ch;
  }

  /**
   * The one aside with a width of its own (R-72).
   *
   * `.settings` is `auto auto 1fr`, so the middle column is as wide as the
   * widest reading down it — and this aside changes length with the level, which
   * moved the controls column sideways every time a master pressed a button.
   * The panel reflowing as a consequence of its own control is the kind of thing
   * that reads as a rendering fault.
   *
   * In `ch` because §9's grid is a character cell, and sized on the longest of
   * the three (`EQUIPO EN TODAS PARTES`, 22) with a column to spare. A fourth
   * level would need this number moved, which is the trade for a column that
   * does not move.
   */
  .settings .aside.reach {
    display: inline-block;
    inline-size: 23ch;
  }

  .settings .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6ch;
    white-space: normal;
  }

  /**
   * A setting's explanation, in its own control's cell.
   *
   * `flex-basis: 100%` puts it on its own line inside the cell rather than in a
   * grid row of its own, which is the whole point: a row would sit a full
   * `0,7lh` below the button — the same distance the next setting is — and a
   * line halfway between two settings belongs to neither. The same failure the
   * player's points list had with its type caption, fixed the same way.
   *
   * `.settings dd` is `nowrap`, because a reading and its aside are one line or
   * they are two readings. A sentence is neither, so it takes it back.
   */
  .settings .note {
    flex: 0 0 100%;
    margin: 0.15lh 0 0;
    white-space: normal;
    font-size: 0.86em;
    color: var(--phosphor-dim);
  }

  /**
   * R-21d's warning keeps §9.4's inverse video and gives back the dim.
   *
   * `.warning` is a plate — `background: var(--phosphor); color: var(--screen)`
   * — and `.settings .note` outranks its colour at one class more, so without
   * this the text resolves to `--phosphor-dim` on a `--phosphor` plate and the
   * loudest thing in the panel becomes the one nobody can read. Same trap the
   * selected roster row already documents.
   */
  .settings .note.warning {
    color: var(--screen);
  }

  /**
   * Narrow: **the term and its reading keep a line, the controls take the
   * next**, and the space between one setting and the next stays bigger than
   * the space inside one.
   *
   * One column for all three is the obvious collapse and the wrong one: a
   * label, a reading and a row of buttons stacked at the same spacing is four
   * settings' worth of alternating lines with nothing saying where one ends. A
   * term and what it currently is belong on one line — that is what a
   * definition list is — and only the controls need their own.
   */
  @media (max-width: 900px) {
    .settings {
      grid-template-columns: auto 1fr;
      gap: 0 1.4ch;
    }
    .settings .acts {
      grid-column: 1 / -1;
      margin: 0.25lh 0 1lh;
    }
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6ch;
  }

  /**
   * The visibility control, and the whole point of it is the **column**: the
   * same mark in the same place on every row, so hidden and visible separate at
   * a glance instead of one word at a time.
   *
   * Brightness is the second channel (§9.7) and it runs the same way here as
   * everywhere else: what is on is brighter than what is off. A shut eye is at
   * `--phosphor-deep`, which is also where the row's own text goes, so the two
   * signals agree rather than competing.
   */
  .reveal {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: var(--touch);
    color: var(--phosphor);
    border-color: var(--phosphor-dim);
  }

  /**
   * A zone's own eye, quieter than the sector's above it.
   *
   * Still the full touch target — §9's grid is not a reason to make a control
   * on a phone harder to hit — but a hairline border and the dim phosphor, so
   * the column reads as ten subordinate switches under one rather than eleven
   * equal ones.
   */
  .reveal.small {
    color: var(--phosphor-dim);
    border-color: transparent;
  }

  .reveal.shut {
    color: var(--phosphor-deep);
    border-color: var(--phosphor-deep);
  }

  .reveal:hover:not(:disabled),
  .reveal:focus-visible {
    color: var(--screen);
  }

  /**
   * One size for both marks, whether they are drawn in CSS (the diamond) or in
   * vectors (the eye). `overflow: visible` because the eye's curve control
   * points sit outside its own viewBox — that is what gives the lens its
   * height, and clipping them would flatten it back.
   */
  .icon {
    position: relative;
    display: block;
    width: 1.1rem;
    height: 1.1rem;
    flex: none;
    overflow: visible;
  }

  /**
   * Sticky against `.panel-body`, which is the scrollport — the one in this
   * view that scrolls. `align-self: start` is load-bearing: a grid item
   * stretches to its row's height by default, and an item as tall as the row
   * has nowhere to stick to.
   */
  /**
   * A team's headcount and the word for what it counts. Case lettering on the
   * label, the way every other reading on this screen is labelled, and dimmer
   * than the number — §9.7's brightness channel: the count is the reading.
   */
  .count {
    /* One flex item, not two. The row's own gap is 0.6ch and it separates the
       name from the count from the buttons; a label a whole gap away from its
       number belongs to whichever neighbour the spacing says it does, which is
       the failure the bezel's lamps and the player's point types both had. */
    display: inline-flex;
    align-items: baseline;
    gap: 0.4ch;
    font-variant-numeric: tabular-nums;
  }

  .count-label {
    font-family: var(--label-font);
    font-size: var(--label-size);
    letter-spacing: var(--label-tracking);
    color: var(--phosphor-dim);
  }

  .sticky {
    position: sticky;
    top: 0;
    align-self: start;
  }

  /* The one scrolling surface in the view, and it is inside a panel the master
     opened on purpose. */
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

  /**
   * The roster. One block per team, the name said once at the top instead of
   * repeated down a column.
   */
  .group h3 {
    margin: 0 0 0.2lh;
    font-family: var(--label-font);
    font-size: calc(var(--label-size) * 1.1);
    letter-spacing: var(--label-tracking);
    color: var(--phosphor-dim);
    border-bottom: 1px solid var(--phosphor-deep);
  }

  .roster {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .roster li {
    display: flex;
    align-items: stretch;
    gap: 0.4ch;
  }

  /**
   * The row is the button, and it carries no border of its own: a list of
   * forty bordered boxes is a table again. Selection is inverse video (§9.4),
   * which is how this interface emphasises game content everywhere else.
   */
  .pick {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: baseline;
    gap: 0 0.8ch;
    padding: 0.15lh 0.6ch;
    border: 1px solid transparent;
    border-radius: 0;
    min-height: var(--touch);
    text-align: left;
    text-transform: none;
    letter-spacing: normal;
  }

  .pick:hover:not(:disabled),
  .pick:focus-visible,
  .roster li.on .pick {
    background: var(--phosphor);
    color: var(--screen);
    text-shadow: none;
  }

  /**
   * Inverse video sets `color` on the row, and every child that names its own
   * colour defeats it. They all have to hand it back — for the selected row and
   * for the hovered one alike, which is the half that was missing.
   *
   * It was invisible in the normal palette and **literally invisible** in high
   * contrast, where `--phosphor` is defined *as* `--phosphor-bright`: the plate
   * and the callsign on it resolved to the same value, so the one word the row
   * exists to show was the one word that disappeared. Same shape as the
   * dropdown's tick — a second reading in brightness is no reading at all on a
   * background that is itself made of brightness.
   */
  .pick:hover:not(:disabled) .mark,
  .pick:hover:not(:disabled) .callsign,
  .pick:hover:not(:disabled) .batt,
  .pick:hover:not(:disabled) .meta,
  .pick:focus-visible .mark,
  .pick:focus-visible .callsign,
  .pick:focus-visible .batt,
  .pick:focus-visible .meta,
  .roster li.on .mark,
  .roster li.on .callsign,
  .roster li.on .batt,
  .roster li.on .meta {
    color: inherit;
  }

  /* The mark itself is drawn in terminal.css, because the player's HUD draws
     the same one and a mark that is two shapes in two places is two machines. */
  .callsign {
    letter-spacing: 0.08em;
    color: var(--phosphor-bright);
  }

  /* Both quiet, and for opposite reasons: the battery is rarely the answer to
     anything, and the link line is read as a shape rather than as words. */
  .batt,
  .meta {
    font-family: var(--label-font);
    font-size: var(--label-size);
    letter-spacing: var(--label-tracking);
    color: var(--phosphor-dim);
  }
  /* Spans the two columns after the mark, and may not widen them: a long
     reading — `ULTIMA CONOCIDA · 25min · ±2,1km` — is the widest thing in the
     rail, and a grid item's floor is its min-content width unless told
     otherwise. */
  .meta {
    grid-column: 2 / -1;
    min-width: 0;
  }
  /**
   * The reticle: a ring with a cross through it, drawn from a border and two
   * pseudo-elements. Drawn rather than set as a character for the same reason
   * the map's diamond and the dropdown's caret are — the screen face is a
   * bitmap revival and a missing glyph is a tofu box, which is a worse mark
   * than no mark.
   */
  .locate {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: var(--touch);
    color: var(--phosphor-dim);
    border-color: var(--phosphor-deep);
  }

  .locate:hover:not(:disabled),
  .locate:focus-visible {
    color: var(--screen);
  }

  .reticle {
    position: relative;
    width: 0.8rem;
    height: 0.8rem;
    border: 1px solid currentColor;
    border-radius: 50%;
  }

  /* The cross-hairs, run past the ring on both axes so it reads as a sight
     rather than as a circle with a dot in it — which is §9.7's STATIONARY. */
  .reticle::before,
  .reticle::after {
    content: '';
    position: absolute;
    background: currentColor;
  }
  .reticle::before {
    left: 50%;
    top: -0.25rem;
    bottom: -0.25rem;
    width: 1px;
    margin-left: -0.5px;
  }
  .reticle::after {
    top: 50%;
    left: -0.25rem;
    right: -0.25rem;
    height: 1px;
    margin-top: -0.5px;
  }

  /* Setup only, and deliberately not the widest thing in the row. */
  .drop {
    min-width: var(--touch);
    color: var(--phosphor-dim);
    border-color: var(--phosphor-deep);
  }

  .move {
    display: flex;
    align-items: center;
    gap: 0.8ch;
  }

  /* The pairing controls belong to the row above them, so they are indented
     under it rather than sitting on the list's own left edge. */
  .roster li.pair {
    gap: 0.6ch;
    padding: 0 0.6ch 0.4lh 2.4ch;
  }
  /* `:global`, because the dropdown is a component now and its root carries its
     own scope class rather than this file's. */
  .roster li.pair :global(.select) {
    flex: 1;
    min-width: 0;
  }

  /**
   * Setup forms inside a rail. The caption goes above its field rather than
   * beside it, and the field takes the width it is given instead of the twenty
   * characters a browser gives an unsized `<input>` — side by side, three of
   * those never fit and the panel grew a horizontal scrollbar.
   */
  .stack {
    display: grid;
  }
  /**
   * A label and its field on one line, the label left and the field right — and
   * **every label in one form sharing a column**, which is the part that makes
   * it read as a form rather than as three unrelated rows.
   *
   * That is why the grid is on the form and not on the label. A grid per label
   * puts the field wherever that label's own word ends, so `INDICATIVO`,
   * `NOMBRE` and `EQUIPO` each start their field at a different place and the
   * column of rules comes back ragged — which looks like the stacked version's
   * problem solved and is the same problem turned sideways. `display: contents`
   * dissolves the label's box so its word and its field become items of this
   * grid, and the first column is then as wide as the widest label in the form.
   *
   * The nesting is untouched, so the label still owns its control: that
   * association is DOM, not layout.
   */
  .stack {
    grid-template-columns: auto 1fr;
    align-items: baseline;
    justify-items: stretch;
    gap: 0.4lh 1.2ch;
  }

  .stack > label {
    display: contents;
  }

  /* Anything that is not a label-and-field pair spans both columns: a submit
     button, the armed-picker toggle, the latitude/longitude pair. Left where
     the labels are rather than stretched, because a button as wide as a form is
     a bar. */
  .stack > :not(label) {
    grid-column: 1 / -1;
    justify-self: start;
  }

  /* The submit is the form's action, and it goes to the right — under the
     fields rather than under the labels, which is where a form ends and where a
     thumb already is. The armed-picker toggle stays left: it acts on a field
     above it, not on the form. */
  .stack > button[type='submit'] {
    justify-self: end;
  }

  .stack input {
    width: 100%;
  }

  /* Back to stacked where the screen cannot hold both: a field a master types
     coordinates into is worth more width than the word beside it. */
  @media (max-width: 600px) {
    .stack {
      grid-template-columns: 1fr;
      gap: 0.4lh 0;
    }
    .stack > label {
      display: grid;
      gap: 0.1lh;
    }
  }

  .teams {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .teams li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6ch;
    padding: 0.15lh 0;
  }
  /* The name takes what is left, so the two buttons keep their own width and
     drop to a second line rather than pushing the row past the rail. */
  .teams .name {
    flex: 1;
    min-width: 8ch;
  }

  .invites {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.6lh;
  }
  .invites .link {
    margin: 0;
    color: var(--phosphor-dim);
  }

  /**
   * The marker window. Bottom left — the corner the people card vacated when it
   * moved right, and the one furthest from the point card at the top right.
   * They are all draggable, so this decides where they start rather than where
   * they stay.
   */
  .marker-card {
    right: auto;
    left: 0.4ch;
    width: min(40ch, calc(100% - 1ch));
  }

  /**
   * Latitude and longitude side by side, and each with its label inline.
   *
   * It is a `.stack` child rather than a label, so it spans both of the form's
   * columns and its own two pairs do not inherit that grid — they are laid out
   * here instead. `auto 1fr` twice, per half.
   */
  .marker-card .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6ch;
    width: 100%;
  }

  .marker-card .pair label {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: baseline;
    gap: 0 0.8ch;
  }

  /* Armed, in inverse video like every other on-state in the app (§9.4). */
  .marker-card button.on {
    background: var(--phosphor);
    color: var(--screen);
    border-color: var(--phosphor);
    text-shadow: none;
  }

  /**
   * The card. Bottom right, because the left edge is PERSONAL's: a rail and a
   * card in the same corner means the list you clicked a name in covers the card
   * that name opened. Pinned to a corner rather than to the dot, which would
   * jump around the screen every time the position updated — and draggable from
   * there, so a card over somebody's head is a problem the master can solve.
   *
   * It is `pointer-events: auto` explicitly — everything else floating over the
   * map is inert, and this one has the radio-contact button in it.
   */
  /* `min(…, …)`, because 44ch is 440 px and a phone is 390: a cap that is
     wider than the tube is not a cap, and a card that starts 0,4ch from the
     right edge and runs 440 px wide leaves the screen on the other side. */
  .card {
    position: absolute;
    right: 0.4ch;
    bottom: 0.4ch;
    max-width: min(44ch, calc(100% - 0.8ch));
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

  .card-head strong {
    font-weight: normal;
    letter-spacing: 0.1em;
  }

  .card-head button {
    color: var(--screen);
    border-color: var(--screen);
    min-height: calc(var(--touch) * 0.7);
  }

  .card-head button:hover:not(:disabled),
  .card-head button:focus-visible {
    background: var(--screen);
    color: var(--phosphor);
  }

  .card-body {
    padding: 0.4ch 0.6ch;
    display: grid;
    gap: 0.2lh;
  }

  .card-body p {
    margin: 0;
  }

  /**
   * The bar: controls left, state right, and it is the only chrome that is
   * always on screen. It wraps rather than scrolls — a control that has scrolled
   * out of a bar is a control that is not there.
   */
  /**
   * Two lines: the readings, then the controls. They shared one and the
   * readings lost — squeezed against the right edge by eight buttons and read
   * as a tail of the row rather than as a status line.
   */
  .bar {
    display: grid;
    gap: 0.1lh;
    padding: 0.2ch 0.6ch 0.3ch;
    border-top: 1px solid var(--phosphor-deep);
    /* The bar keeps its own weight rather than the overlay token: it is the
       only chrome that is always on screen, so it is the only one where a map
       showing through is a permanent cost rather than a momentary one. */
    background: rgb(var(--overlay-ink) / 0.94);
    z-index: 3;
  }

  /**
   * The readings. Quiet on purpose — this is what the machine is doing, not
   * what the master is about to do — and spaced so `QRV EN CURSO` and
   * `QSA 5` read as two things rather than as one run of words.
   */
  .bar-state {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 3ch;
    opacity: 0.8;
  }

  /**
   * Smaller than the controls under them, and smaller than the body.
   *
   * These are the two readings that never change while a master works — the
   * game's state and the link's strength — so their job is to be *checkable*,
   * not read. The line is furniture at the bottom of a screen whose content is
   * a map, and furniture set at body size competes with it.
   *
   * Sized here rather than on `.bar-state`: R-24's warning and its countdown
   * share that row and neither is furniture. The warning is inverse video
   * because §9.4 makes that this interface's only emphasis, and shrinking it
   * would take the emphasis back off.
   *
   * `.q` carries its own `rem` size globally, so it needs its own step down —
   * a parent `font-size` does not reach a child sized in root units.
   */
  .reading {
    display: flex;
    align-items: baseline;
    gap: 0.8ch;
    font-size: 0.86rem;
  }

  .reading .q {
    font-size: 0.8rem;
  }

  /**
   * The firmware marking. Quieter than the readings beside it and a step
   * smaller again, because it is the only thing in the bar that never changes
   * and never will — it is fiction, fixed in `locales/es.json`, and nothing in
   * the game can move it.
   *
   * `margin-inline-start: auto` rather than a place in the order: the row wraps
   * and grows R-24's warning in the middle of itself, and furniture that shuffles
   * when an alarm arrives reads as part of the alarm.
   */
  .version {
    margin-inline-start: auto;
    font-size: 0.8rem;
    opacity: 0.65;
  }

  /**
   * The controls, in blocks. The gap *between* blocks is four times the gap
   * inside one, which is what turns a row you read left to right into a row you
   * aim at.
   */
  .bar-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3lh 3.2ch;
  }

  /**
   * `.block`, not `.group` — the roster's team blocks already had that name in
   * this same file, and a bar rule that turned every one of them into a flex
   * row rebuilt the personnel list sideways: headings beside their players,
   * rows wrapping into each other. Scoped styles are scoped to the component,
   * and this component is two screens' worth of markup.
   */
  .block {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.8ch;
  }

  /* The way out, pushed to the far end of whatever room is left. */
  .block.away {
    margin-left: auto;
  }

  /**
   * No border.
   *
   * A border on every one of these drew eight boxes and left the grouping to be
   * read through them; without it the words are the buttons and the spacing is
   * the only structure, which is how a function-key strip has always worked. The
   * hit area is unchanged — `--touch` is still the height, and the padding is
   * still there to be pressed.
   */
  .bar button {
    min-height: var(--touch);
    padding: 0 0.8ch;
    border: 1px solid transparent;
    background: transparent;
    color: var(--phosphor-dim);
  }

  .bar button:hover:not(:disabled),
  .bar button:focus-visible {
    background: transparent;
    color: var(--phosphor-bright);
  }

  /* Inverse video for the panel that is open and for the mode in force (§9.4).
     A pressed button on a monochrome machine is a lit one — and it is the only
     one here that draws a box, which is what makes "open" legible in a row that
     otherwise has no boxes at all. */
  .bar button.on,
  .bar button.mode-on:disabled {
    background: var(--phosphor);
    color: var(--screen);
    border-color: var(--phosphor);
    text-shadow: none;
  }

  .bar button:disabled:not(.mode-on) {
    color: var(--phosphor-deep);
  }

  .label {
    color: var(--phosphor);
    letter-spacing: 0.06em;
  }


  .row {
    display: flex;
    gap: 2ch;
    flex-wrap: wrap;
    align-items: center;
  }
  .hint {
    color: var(--phosphor-dim);
  }
  /* §9.4. Inverse video is how a monochrome machine emphasised, and it reads
     louder than red — which matters here because the alarm colour is reserved
     for R-43, the one thing on any screen that is not game content. */
  .warning {
    background: var(--phosphor);
    color: var(--screen);
    padding: 0 0.6ch;
    text-shadow: none;
  }
  .link {
    word-break: break-all;
    max-width: 44ch;
    white-space: normal;
  }
  input[type='range'] {
    width: 100%;
    max-width: 40rem;
  }
  /* R-24's briefing. Sized to be read rather than dismissed, and it inherits the
     panel's monospace so it does not look like a browser artefact.
     `display` belongs on [open] and nowhere else: a bare `dialog { display: grid }`
     overrides the `display: none` the browser gives a closed dialog, which paints
     the briefing over the panel permanently and — worse — leaves its accept button
     live without anyone having asked for the mode. R-24 stops being blocking. */
  dialog {
    max-width: min(60ch, calc(100% - 2ch));
    padding: 1ch;
    background: var(--screen);
    color: var(--phosphor);
    border: 2px solid var(--phosphor);
  }
  dialog[open] {
    display: grid;
    gap: 0.75rem;
  }
  /**
   * Transparent, and the dim is `.briefing-dim` instead. A backdrop belongs to
   * the top layer, which nothing can clip — so it covered the bezel as well as
   * the screen, and dimming the case makes the machine part of the dialog
   * rather than the thing the dialog is on.
   *
   * **The name is the whole of the second bug.** It was `.dim`, and §9.7's
   * brightness levels are class names — `bright`, `normal`, `dim` — so every
   * roster mark on a NO_LINK player carried `class="mark dim"` and took a
   * full-panel black overlay with `z-index: 4` along with it. ECO was the only
   * player in NO_LINK, so ECO was the only one that did it, which is why
   * deleting that player appeared to fix the panel. Third class collision in
   * this file: it is two screens of markup in one scope, and a name here is a
   * name for all of it.
   */
  dialog::backdrop {
    background: transparent;
  }

  /**
   * The destructive sheet, and the destructive button on it.
   *
   * Red, which is the one colour §9's palette holds back — and R-43 owns it on
   * the **map**, where the boundary warning has to be unmistakable against game
   * content. This is a modal over an inert panel that the master opened on
   * purpose, and what it is saying is the same kind of thing: this is not part
   * of the game you are running, and it does not come back.
   */
  dialog.danger {
    border-color: var(--alarm);
  }

  dialog.danger h2 {
    color: var(--alarm);
  }

  button.danger {
    color: var(--alarm);
    border-color: var(--alarm);
  }

  button.danger:hover:not(:disabled),
  button.danger:focus-visible {
    background: var(--alarm);
    color: var(--screen);
  }

  .briefing-dim {
    position: absolute;
    inset: 0;
    background: rgb(0 0 0 / 0.6);
    pointer-events: none;
    z-index: 4;
  }
</style>

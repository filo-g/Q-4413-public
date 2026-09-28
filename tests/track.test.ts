import { describe, expect, it } from 'vitest';

import {
  advanceCursor,
  earliestSampleTs,
  routeAt,
  REPLAY_DEFAULT_WINDOW_MS,
  REPLAY_SPEEDS,
  replayStartCursor,
  replayWindowFor,
  trackTrimRefusal,
  indexTrack,
  positionAt,
  replayAt,
  sampleOf,
  trackAttributes,
  TRACK_ATTRIBUTES,
  TRACK_ATTRIBUTE_VALUE_MAX,
} from '../packages/core/src/track.ts';
import type { GameEvent, Payload, Player, TrackSample } from '../packages/shared/types.ts';

/**
 * The track and replay (R-53..R-57). The security test is the first one: R-03's
 * attribute map can carry an FCM push token, and the whole of M8's hazard is a
 * writer that persists it.
 */

const player = (over: Partial<Player> = {}): Player => ({
  id: 'p-alfa',
  callsign: 'ALFA',
  fullName: 'A. Nonymous',
  teamId: 't1',
  sessionToken: 'tok',
  position: {
    lat: 36.66,
    lon: -4.48,
    accuracy: 10,
    ts: 1_000,
    state: 'MOVING',
    zoneId: 'z1',
  },
  battery: 74,
  ...over,
});

const sample = (over: Partial<TrackSample> = {}): TrackSample => ({
  ts: 1_000,
  playerId: 'p-alfa',
  lat: 36.66,
  lon: -4.48,
  accuracy: 10,
  state: 'MOVING',
  ...over,
});

/** A master payload, in the shape project() hands to a socket. */
const payload = (over: Partial<Payload> = {}): Payload => ({
  game: { id: 'g', name: 'G', state: 'IN_PROGRESS', cutSwitch: false, commsReach: 3 },
  serverNow: 10_000,
  config: {
    linkThresholdMs: 90_000,
    radioContactValidityMs: 900_000,
    authoritativeIdleRevertMs: 600_000,
    markerDefaultTtlMs: 900_000,
    detourFactor: 1.3,
    walkingSpeed: 1.4,
    bearingFreezeSpeed: 0.5,
    bearingSmoothing: 0.2,
    poiProximityRadius: 50,
  },
  basemap: { pmtilesUrl: '', styleUrl: '', bbox: [0, 0, 0, 0], maxZoom: 17 },
  players: [{ id: 'p-alfa', callsign: 'ALFA', fullName: 'A. Nonymous', teamId: 't1' }],
  teams: [{ id: 't1', name: 'ROJO', playerIds: ['p-alfa'] }],
  pois: [],
  zones: [],
  sectors: [],
  playArea: [],
  perimeter: { type: 'Polygon', coordinates: [] },
  ingestArea: { type: 'Polygon', coordinates: [] },
  markers: [],
  tray: [{ deviceId: 'dev-1', lat: 36.6, lon: -4.4, lastSeen: 9_000, firstSeen: 0, pings: 3 }],
  events: [],
  viewMode: 'AUTHORITATIVE',
  replayAvailable: true,
  ...over,
});

describe('trackAttributes — the M8 hazard', () => {
  /**
   * The one that matters. Traccar Client's status body is
   * `id=<device>&notificationToken=<FCM registration token>`; R-03 keeps every
   * unrecognised parameter, so a track writer that persisted the map wholesale
   * would write a live push credential into history that outlives the game.
   */
  it('drops a push token, and everything else not on the list', () => {
    const kept = trackAttributes({
      notificationToken: 'PLACEHOLDER-NOT-A-REAL-TOKEN',
      sessionid: 'abc',
      altitude: '31.4',
    });
    expect(kept).toEqual({ altitude: '31.4' });
    expect(Object.keys(kept!)).not.toContain('notificationToken');
  });

  it('keeps exactly the three the allowlist names', () => {
    expect(TRACK_ATTRIBUTES).toEqual(['altitude', 'hdop', 'charge']);
    expect(trackAttributes({ altitude: '1', hdop: '2', charge: 'true' })).toEqual({
      altitude: '1',
      hdop: '2',
      charge: 'true',
    });
  });

  it('truncates a kept value rather than refusing the sample', () => {
    const kept = trackAttributes({ altitude: 'x'.repeat(200) });
    expect(kept!['altitude']!.length).toBe(TRACK_ATTRIBUTE_VALUE_MAX);
  });

  it('is absent rather than empty when nothing survives', () => {
    expect(trackAttributes({ notificationToken: 'PLACEHOLDER' })).toBeUndefined();
    expect(trackAttributes(undefined)).toBeUndefined();
  });
});

describe('sampleOf', () => {
  it('records what the game believed, not what the ping said', () => {
    expect(sampleOf(player(), { altitude: '31.4', notificationToken: 'PLACEHOLDER' })).toEqual({
      ts: 1_000,
      playerId: 'p-alfa',
      lat: 36.66,
      lon: -4.48,
      accuracy: 10,
      state: 'MOVING',
      zoneId: 'z1',
      battery: 74,
      attributes: { altitude: '31.4' },
    });
  });

  it('has nothing to record for a player with no position', () => {
    const unlocated = player();
    delete unlocated.position;
    expect(sampleOf(unlocated)).toBeUndefined();
  });
});

describe('advanceCursor — R-54, R-54b', () => {
  it('runs at every speed the control offers', () => {
    expect(advanceCursor(1_000, 500, 1, 1_000_000)).toBe(1_500);
    expect(advanceCursor(1_000, 500, 2, 1_000_000)).toBe(2_000);
    expect(advanceCursor(1_000, 500, 4, 1_000_000)).toBe(3_000);
    expect(advanceCursor(1_000, 500, 8, 1_000_000)).toBe(5_000);
  });

  /**
   * The list and the arithmetic are the same requirement, so the speeds are read
   * from the constant rather than retyped: a fifth added without a thought about
   * what it means to advance by it would otherwise pass silently.
   */
  it('advances by exactly the speed, for every speed on the list', () => {
    expect(REPLAY_SPEEDS).toEqual([1, 2, 4, 8, 16]);
    for (const speed of REPLAY_SPEEDS) {
      expect(advanceCursor(0, 1_000, speed, 1_000_000)).toBe(1_000 * speed);
    }
  });

  /** The snap, not a clamp: it lands *on* live so the caller can see it did. */
  it('snaps to live on reaching it', () => {
    expect(advanceCursor(9_000, 5_000, 4, 10_000)).toBe(10_000);
    expect(advanceCursor(10_000, 1, 1, 10_000)).toBe(10_000);
  });
});

/**
 * R-62. The window is the game, and the cursor starts where the game's own state
 * says — which is the difference between watching a replay and reading a
 * debrief.
 */
describe('replayWindowFor / replayStartCursor — R-62', () => {
  const START = 1_760_000_000_000;
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const END = START + SIX_HOURS;
  const TWENTY_MIN = 20 * 60 * 1000;

  it('spans a finished game end to end', () => {
    expect(
      replayWindowFor({ state: 'FINISHED', startedAt: START, finishedAt: END }, END + 90_000),
    ).toEqual({ from: START, to: END });
  });

  it('runs a game still in progress up to now', () => {
    const now = START + 3 * 60 * 60 * 1000;
    expect(replayWindowFor({ state: 'IN_PROGRESS', startedAt: START }, now)).toEqual({
      from: START,
      to: now,
    });
  });

  /**
   * The one a local Worker found, with 37.923 samples in the table and zero in
   * the window the panel would have asked for. `#setState()` stamps `finishedAt`
   * on the way into FINISHED and never clears it — rightly, because when a game
   * ended is worth keeping — so a game finished once and reopened for the next
   * session carries an end that has already passed. Every sample since is after
   * it.
   */
  it('ignores a finishedAt the game has since been reopened past', () => {
    const now = END + 5 * 24 * 60 * 60 * 1000;
    for (const state of ['PREPARATION', 'IN_PROGRESS', 'PAUSED'] as const) {
      expect(
        replayWindowFor({ state, startedAt: START, finishedAt: END }, now),
      ).toEqual({ from: START, to: now });
    }
  });

  /** A game that never started still gets a replay: M8's hour is the floor. */
  it('falls back to the hour before now when the game has no start', () => {
    const now = START + 1_000;
    expect(replayWindowFor({}, now)).toEqual({ from: now - REPLAY_DEFAULT_WINDOW_MS, to: now });
  });

  /** Two timestamps that cannot both be true produce a usable bar, not an empty one. */
  it('falls back when the recorded start is after the recorded end', () => {
    expect(replayWindowFor({ state: 'FINISHED', startedAt: END, finishedAt: START }, END)).toEqual({
      from: START - REPLAY_DEFAULT_WINDOW_MS,
      to: START,
    });
  });

  it('opens a finished game at its beginning, whatever the offset', () => {
    const window = { from: START, to: END };
    expect(replayStartCursor(window, { state: 'FINISHED', finishedAt: END }, TWENTY_MIN)).toBe(START);
  });

  it('opens a running game twenty minutes back', () => {
    const now = START + SIX_HOURS;
    expect(replayStartCursor({ from: START, to: now }, { state: 'IN_PROGRESS' }, TWENTY_MIN)).toBe(
      now - TWENTY_MIN,
    );
  });

  /** A game ten minutes old has no twenty-minutes-ago to open on. */
  it('clamps into a window shorter than the offset', () => {
    const now = START + 10 * 60 * 1000;
    expect(replayStartCursor({ from: START, to: now }, { state: 'IN_PROGRESS' }, TWENTY_MIN)).toBe(
      START,
    );
  });

  /**
   * The track is kept 48 hours and a window is the whole game, so a debrief the
   * day after a long one asks for an hour that has already been swept. `from` is
   * the **asked** bound and the server echoes it back whether or not anything
   * was found in it, so opening there is an empty map for however long the gap
   * is — which reads as everybody having vanished rather than as a replay that
   * has not started yet.
   */
  it('never opens before the first sample there actually is', () => {
    const first = START + 2 * 60 * 60 * 1000;
    expect(
      replayStartCursor({ from: START, to: END }, { state: 'FINISHED' }, TWENTY_MIN, first),
    ).toBe(first);
    // And it does not drag a running game's cursor *forward* past its twenty
    // minutes just because the track starts early.
    expect(
      replayStartCursor({ from: START, to: END }, { state: 'IN_PROGRESS' }, TWENTY_MIN, START),
    ).toBe(END - TWENTY_MIN);
  });

  it('finds the earliest sample without trusting the wire order', () => {
    expect(
      earliestSampleTs([sample({ ts: 5_000 }), sample({ ts: 1_000 }), sample({ ts: 9_000 })]),
    ).toBe(1_000);
    expect(earliestSampleTs([])).toBeUndefined();
  });
});

describe('trackTrimRefusal — R-73', () => {
  const START = 1_760_000_000_000;
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const END = START + SIX_HOURS;

  it('allows a cut inside a finished game', () => {
    expect(
      trackTrimRefusal({ state: 'FINISHED', finishedAt: END }, START + 60_000, END + SIX_HOURS),
    ).toBeUndefined();
  });

  /**
   * Milder than the geometry controls' version of this refusal and for a
   * different reason: nothing here reaches §4, but a window whose start moves
   * under a running game is the replay and the panel disagreeing about what the
   * game is.
   */
  it('refuses while the game is in progress', () => {
    expect(trackTrimRefusal({ state: 'IN_PROGRESS' }, START, END)).toBe('IN_PROGRESS');
  });

  /** `from` is the new beginning, not a length. A cut past the end has no inside. */
  it('refuses a cut at or after the end of a finished game', () => {
    const now = END + SIX_HOURS;
    expect(trackTrimRefusal({ state: 'FINISHED', finishedAt: END }, END, now)).toBe('NOT_IN_RANGE');
    expect(trackTrimRefusal({ state: 'FINISHED', finishedAt: END }, END + 1, now)).toBe(
      'NOT_IN_RANGE',
    );
  });

  /**
   * The same reading `replayWindowFor()` makes. A game finished once and
   * reopened for the next session carries an end that has already passed, and
   * measuring against it would refuse every cut anybody could ask for.
   */
  it('measures against now, not a finishedAt the game was reopened past', () => {
    const now = END + 5 * 24 * 60 * 60 * 1000;
    for (const state of ['PREPARATION', 'PAUSED'] as const) {
      expect(trackTrimRefusal({ state, finishedAt: END }, END + 60_000, now)).toBeUndefined();
    }
  });

  it('refuses a timestamp that is not one', () => {
    expect(trackTrimRefusal({ state: 'FINISHED', finishedAt: END }, Number.NaN, END)).toBe(
      'NOT_IN_RANGE',
    );
  });
});

describe('positionAt — R-55', () => {
  const samples = [
    sample({ ts: 1_000, lat: 36.0, lon: -4.0, accuracy: 10 }),
    sample({ ts: 2_000, lat: 36.2, lon: -4.4, accuracy: 20 }),
  ];

  it('interpolates linearly between two samples of one feed', () => {
    const at = positionAt(samples, 1_500, 90_000)!;
    expect(at.lat).toBeCloseTo(36.1, 10);
    expect(at.lon).toBeCloseTo(-4.2, 10);
    expect(at.accuracy).toBeCloseTo(15, 10);
    expect(at.ts).toBe(1_500);
  });

  it('shows nothing before the player has reported', () => {
    expect(positionAt(samples, 500, 90_000)).toBeUndefined();
  });

  /**
   * The blackout. Past the link threshold the two fixes are not two points on a
   * walk, so holding the earlier one — timestamp and all — is what makes the
   * dot go NO_LINK under a growing circle exactly as it did live (R-12).
   */
  it('holds the earlier sample across a gap the feed could not have covered', () => {
    const gapped = [sample({ ts: 1_000, lat: 36.0 }), sample({ ts: 500_000, lat: 37.0 })];
    const at = positionAt(gapped, 200_000, 90_000)!;
    expect(at.lat).toBe(36.0);
    expect(at.ts).toBe(1_000);
  });

  it('holds the last sample past the end of the track', () => {
    const at = positionAt(samples, 9_000_000, 90_000)!;
    expect(at.ts).toBe(2_000);
    expect(at.lat).toBe(36.2);
  });

  it('carries bearing and battery from the earlier sample rather than ramping them', () => {
    const pair = [
      sample({ ts: 1_000, bearing: 350, battery: 80 }),
      sample({ ts: 2_000, bearing: 10, battery: 60 }),
    ];
    const at = positionAt(pair, 1_500, 90_000)!;
    expect(at.bearing).toBe(350);
    expect(at.battery).toBe(80);
  });
});

describe('replayAt — R-53, R-56, R-57', () => {
  const index = indexTrack({
    from: 0,
    to: 10_000,
    samples: [
      sample({ ts: 1_000, lat: 36.0 }),
      sample({ ts: 2_000, lat: 36.2 }),
      // Out of order on the wire; the index sorts it, or the player teleports.
      sample({ ts: 1_500, lat: 36.1 }),
    ],
    events: [],
  });

  /** R-53 in one line: the cursor becomes the clock every derivation reads. */
  it('sets serverNow to the cursor', () => {
    expect(replayAt(payload(), index, 1_500).serverNow).toBe(1_500);
  });

  it('places the player where the track says, not where they are now', () => {
    const at = replayAt(payload(), index, 1_750);
    expect(at.players[0]!.position!.lat).toBeCloseTo(36.15, 10);
  });

  it('sorts samples that arrived out of order', () => {
    const at = replayAt(payload(), index, 1_500);
    expect(at.players[0]!.position!.lat).toBeCloseTo(36.1, 10);
  });

  it('shows a player with no position before their first sample', () => {
    expect(replayAt(payload(), index, 100).players[0]!.position).toBeUndefined();
  });

  /** The tray has no history, so carrying it would draw a stray phone in the wrong decade. */
  it('drops the tray rather than drawing it where it is now', () => {
    expect(replayAt(payload(), index, 1_500).tray).toEqual([]);
  });

  it('keeps the roster, the config and the geometry from the live payload', () => {
    const live = payload();
    const at = replayAt(live, index, 1_500);
    expect(at.players[0]!.callsign).toBe('ALFA');
    expect(at.config).toBe(live.config);
    expect(at.perimeter).toBe(live.perimeter);
  });
});

describe('replayAt — the log replays too (R-56)', () => {
  const events: GameEvent[] = [
    {
      ts: 3_000,
      kind: 'MARKER_PLACED',
      target: 'marker-1',
      visibility: 'MASTER',
      data: { label: 'PUNTO', lat: 36.5, lon: -4.5, audience: { kind: 'all' } },
    },
    { ts: 6_000, kind: 'MARKER_EXPIRED', target: 'marker-1', visibility: 'MASTER' },
    {
      ts: 4_000,
      kind: 'ELIMINATION',
      target: 'p-alfa',
      visibility: 'MASTER_AUTHORITATIVE',
      data: { selfDeclared: true, dropPoint: { lat: 36.1, lon: -4.1 } },
    },
    { ts: 8_000, kind: 'ELIMINATION_REVERSED', target: 'p-alfa', visibility: 'MASTER_AUTHORITATIVE' },
    { ts: 5_000, kind: 'RADIO_CONTACT', actor: 'MASTER', target: 'p-alfa', visibility: 'MASTER' },
  ];
  const index = indexTrack({ from: 0, to: 10_000, samples: [], events });

  it('shows only the events that had happened', () => {
    expect(replayAt(payload(), index, 3_500).events!.map((event) => event.kind)).toEqual([
      'MARKER_PLACED',
    ]);
  });

  it('stands a marker up when it was placed and takes it down when it was cleared', () => {
    expect(replayAt(payload(), index, 2_000).markers).toEqual([]);
    expect(replayAt(payload(), index, 5_000).markers[0]!.label).toBe('PUNTO');
    expect(replayAt(payload(), index, 7_000).markers).toEqual([]);
  });

  /** R-21c, applied downstream by activeMarkers() against the cursor, not here. */
  it('lets a marker expire on its own TTL at the cursor', () => {
    const ttl: GameEvent[] = [
      {
        ts: 3_000,
        kind: 'MARKER_PLACED',
        target: 'marker-2',
        visibility: 'MASTER',
        data: { label: 'TTL', lat: 36.5, lon: -4.5, expiresAt: 4_000 },
      },
    ];
    const withTtl = indexTrack({ from: 0, to: 10_000, samples: [], events: ttl });
    expect(replayAt(payload(), withTtl, 3_500).markers).toHaveLength(1);
    expect(replayAt(payload(), withTtl, 4_500).markers).toEqual([]);
  });

  /** A marker placed before M8 carries no coordinates, so it is absent, not misplaced. */
  it('skips a marker the log has no coordinates for', () => {
    const legacy = indexTrack({
      from: 0,
      to: 10_000,
      samples: [],
      events: [
        { ts: 3_000, kind: 'MARKER_PLACED', target: 'old', visibility: 'MASTER', data: { label: 'X' } },
      ],
    });
    expect(replayAt(payload(), legacy, 4_000).markers).toEqual([]);
  });

  it('eliminates the player at the moment they declared, and not before', () => {
    expect(replayAt(payload(), index, 3_900).players[0]!.eliminated).toBeUndefined();
    expect(replayAt(payload(), index, 4_100).players[0]!.eliminated).toEqual({
      ts: 4_000,
      selfDeclared: true,
      dropPoint: { lat: 36.1, lon: -4.1 },
    });
  });

  it('reverses the elimination at the moment R-32 was used', () => {
    expect(replayAt(payload(), index, 8_100).players[0]!.eliminated).toBeUndefined();
  });

  /**
   * R-63. The last part of the world a replay still read from the present: a
   * point hidden at 21:14 used to be hidden from the replay's first frame,
   * because `hiddenPois` came off the live game rather than off the log.
   */
  it('hides a point from the moment it was hidden, and not before', () => {
    const toggles = indexTrack({
      from: 0,
      to: 10_000,
      samples: [],
      events: [
        { ts: 3_000, kind: 'POI_VISIBILITY', target: 'poi-1', visibility: 'MASTER', data: { hidden: true } },
        { ts: 7_000, kind: 'POI_VISIBILITY', target: 'poi-1', visibility: 'MASTER', data: { hidden: false } },
        { ts: 4_000, kind: 'POI_VISIBILITY', target: 'poi-2', visibility: 'MASTER', data: { hidden: true } },
      ],
    });
    const live = payload({ hiddenPois: ['poi-9'] });
    expect(replayAt(live, toggles, 2_000).hiddenPois).toEqual([]);
    expect(replayAt(live, toggles, 3_500).hiddenPois).toEqual(['poi-1']);
    expect(replayAt(live, toggles, 5_000).hiddenPois).toEqual(['poi-1', 'poi-2']);
    // Put back at 7.000: the live list never gets a say, in either direction.
    expect(replayAt(live, toggles, 8_000).hiddenPois).toEqual(['poi-2']);
  });

  /** R-29's freshness is derived against serverNow, which replay has moved. */
  it('does not show a radio check that has not happened yet', () => {
    expect(replayAt(payload(), index, 4_000).players[0]!.radioContact).toBeUndefined();
    expect(replayAt(payload(), index, 5_500).players[0]!.radioContact).toEqual({
      ts: 5_000,
      reportedBy: 'MASTER',
    });
  });
});

/**
 * R-64. The route is R-55's rule applied to a line that stays on screen: past
 * `linkThresholdMs` two samples are the last fix before a blackout and the first
 * after it, and a stroke joining them says *walked this way* for as long as the
 * route is up, where the dot's circle only said *unknown* for a moment.
 */
describe('routeAt — R-64', () => {
  const walk = [
    sample({ ts: 1_000, lat: 36.0, lon: -4.0 }),
    sample({ ts: 2_000, lat: 36.1, lon: -4.1 }),
    sample({ ts: 3_000, lat: 36.2, lon: -4.2 }),
  ];

  it('draws one segment through a feed that never stopped', () => {
    expect(routeAt(walk, 3_000, 90_000)).toEqual([
      [
        [-4.0, 36.0],
        [-4.1, 36.1],
        [-4.2, 36.2],
      ],
    ]);
  });

  it('stops at the cursor rather than drawing the whole track', () => {
    expect(routeAt(walk, 2_000, 90_000)).toEqual([
      [
        [-4.0, 36.0],
        [-4.1, 36.1],
      ],
    ]);
  });

  /**
   * The cursor landing exactly on a sample. That sample is already the last
   * point of the line, and `positionAt()` stamps the cursor on it — so a head
   * appended on `ts === cursor` alone would draw it twice.
   */
  it('adds no head when the cursor is on a sample', () => {
    expect(routeAt(walk, 2_000, 90_000)[0]).toHaveLength(2);
    expect(routeAt(walk, 3_000, 90_000)[0]).toHaveLength(3);
  });

  /** The head is the interpolated point, so the line ends at the dot. */
  it('ends at the interpolated position between two samples', () => {
    const segments = routeAt(walk, 2_500, 90_000);
    expect(segments).toHaveLength(1);
    const head = segments[0]!.at(-1)!;
    expect(head[1]).toBeCloseTo(36.15, 10);
    expect(head[0]).toBeCloseTo(-4.15, 10);
  });

  it('breaks the line across a gap longer than the link threshold', () => {
    const blackout = [
      sample({ ts: 1_000, lat: 36.0, lon: -4.0 }),
      sample({ ts: 2_000, lat: 36.1, lon: -4.1 }),
      sample({ ts: 400_000, lat: 37.0, lon: -5.0 }),
      sample({ ts: 401_000, lat: 37.1, lon: -5.1 }),
    ];
    expect(routeAt(blackout, 401_000, 90_000)).toEqual([
      [
        [-4.0, 36.0],
        [-4.1, 36.1],
      ],
      [
        [-5.0, 37.0],
        [-5.1, 37.1],
      ],
    ]);
  });

  /**
   * The cursor inside a blackout. `positionAt()` holds the earlier sample rather
   * than interpolating, so there is no head to add and the line stops where the
   * feed did — which is the blackout, drawn.
   */
  it('adds no head while the cursor sits in a gap it may not cross', () => {
    const blackout = [
      sample({ ts: 1_000, lat: 36.0, lon: -4.0 }),
      sample({ ts: 2_000, lat: 36.1, lon: -4.1 }),
      sample({ ts: 400_000, lat: 37.0, lon: -5.0 }),
    ];
    expect(routeAt(blackout, 200_000, 90_000)).toEqual([
      [
        [-4.0, 36.0],
        [-4.1, 36.1],
      ],
    ]);
  });

  /** One point is not a line, and the dot is already drawn at it. */
  it('draws nothing for a single sample, or for none', () => {
    expect(routeAt(walk, 1_000, 90_000)).toEqual([]);
    expect(routeAt(walk, 100, 90_000)).toEqual([]);
    expect(routeAt([], 5_000, 90_000)).toEqual([]);
  });
});

/**
 * R-71 inside R-56, and the invariant that had to be replaced rather than
 * documented.
 *
 * `replayAt()` used to take the geometry straight from the live payload, on the
 * argument that `POST /api/master/game/geo` is refused with a 409 while the game
 * is `IN_PROGRESS` — so zone rings cannot move inside a replay's window. R-71
 * made that argument expire: closing ground mid-game is the mechanic. The rings
 * still cannot move, but *which of them are in play* now can, and a debrief that
 * drew the current set over a twenty-minute-old game would be showing a map
 * nobody was looking at.
 *
 * `GEOMETRY_TOGGLED` carries the **whole open set** so that this is a lookup
 * rather than a fold: the last event at or before the cursor is the complete
 * answer, and a window that does not reach the start of the game is still exact.
 */
describe('replayAt — the geometry replays too (R-71, R-56)', () => {
  const square = (west: number, south: number, side = 0.01) => ({
    type: 'Polygon' as const,
    coordinates: [
      [
        [west, south],
        [west + side, south],
        [west + side, south + side],
        [west, south + side],
        [west, south],
      ],
    ],
  });

  /** Two zones side by side, so their union is one piece and each alone is one. */
  const live = () =>
    payload({
      zones: [
        { id: 'z-west', name: 'Oeste', geometry: square(0, 0), sector: 's-west' },
        { id: 'z-east', name: 'Este', geometry: square(0.01, 0), sector: 's-east' },
      ],
      sectors: [
        { id: 's-west', name: 'Oeste', district: 'd', zoneIds: ['z-west'] },
        { id: 's-east', name: 'Este', district: 'd', zoneIds: ['z-east'] },
      ],
      districts: [{ id: 'd', name: 'Distrito', sectorIds: ['s-west', 's-east'] }],
      pois: [
        { id: 'poi-west', name: 'Oeste', lat: 0.005, lon: 0.005, category: 'OTHER', zone: 'z-west' },
        { id: 'poi-east', name: 'Este', lat: 0.005, lon: 0.015, category: 'OTHER', zone: 'z-east' },
      ],
    });

  const toggled = (ts: number, active: string[]): GameEvent => ({
    ts,
    kind: 'GEOMETRY_TOGGLED',
    data: { active, closed: [], opened: [] },
    visibility: 'MASTER',
  });

  const index = () =>
    indexTrack({
      from: 0,
      to: 10_000,
      samples: [],
      events: [toggled(2_000, ['z-west', 'z-east']), toggled(5_000, ['z-west'])],
    });

  it('shows the ground that was open, not the ground that is', () => {
    const before = replayAt(live(), index(), 3_000);
    expect(before.zones.map((zone) => zone.id)).toEqual(['z-west', 'z-east']);

    const after = replayAt(live(), index(), 6_000);
    expect(after.zones.map((zone) => zone.id)).toEqual(['z-west']);
  });

  /**
   * The points go with their ground, and this is the half that needs
   * `project()` to hand a master **every** point rather than the ones in play:
   * `poi-east` is closed at the cursor the live payload was taken at, so if the
   * server had filtered it there would be nothing here to put back.
   */
  it('puts back a point whose ground was open at the cursor', () => {
    expect(replayAt(live(), index(), 3_000).pois.map((poi) => poi.id)).toEqual([
      'poi-west',
      'poi-east',
    ]);
    expect(replayAt(live(), index(), 6_000).pois.map((poi) => poi.id)).toEqual(['poi-west']);
  });

  /** And the boundary R-43 was warning about at the time, not the one now. */
  it('rebuilds the play boundary that was in force', () => {
    const wide = replayAt(live(), index(), 3_000).playArea;
    const narrow = replayAt(live(), index(), 6_000).playArea;
    expect(wide).toHaveLength(1);
    expect(narrow).toHaveLength(1);

    const width = (area: typeof wide) => {
      const ring = area[0]!.coordinates[0]!;
      const lons = ring.map((point) => point[0]!);
      return Math.max(...lons) - Math.min(...lons);
    };
    // Two squares wide against one: the boundary closed when the master did.
    expect(width(wide)).toBeCloseTo(0.02, 6);
    expect(width(narrow)).toBeCloseTo(0.01, 6);
  });

  /** A sector with nothing left open is gone, not an empty row on the map. */
  it('drops a sector whose last zone closed', () => {
    expect(replayAt(live(), index(), 6_000).sectors.map((sector) => sector.id)).toEqual(['s-west']);
  });

  /**
   * A window with no toggle in it leaves the live geometry alone, and that is
   * the honest answer rather than a guess: nothing in the window says otherwise.
   * `GET /api/track` prepends the last toggle from before the window precisely
   * so the only case that reaches here is a game where nothing was ever closed.
   */
  it('leaves the geometry alone when the window holds no toggle', () => {
    const quiet = indexTrack({
      from: 0,
      to: 10_000,
      samples: [],
      events: [],
    });
    expect(replayAt(live(), quiet, 6_000).zones.map((zone) => zone.id)).toEqual([
      'z-west',
      'z-east',
    ]);
  });

  /**
   * The cursor reads the **last** toggle before it and nothing earlier, which is
   * what makes a window that does not reach the start of the game exact. A fold
   * over deltas could not answer this without the whole log.
   */
  it('reads one event rather than folding a history', () => {
    const late = indexTrack({
      from: 0,
      to: 10_000,
      samples: [],
      events: [toggled(1_000, ['z-east'])],
    });
    expect(replayAt(live(), late, 9_000).zones.map((zone) => zone.id)).toEqual(['z-east']);
  });
});

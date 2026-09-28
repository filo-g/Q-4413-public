import type {
  Audience,
  CommsReach,
  GameState,
  MasterMarker,
  Payload,
  ViewMode,
} from '@q4413/shared';
import type { TrackWindow } from '@q4413/core';

/**
 * HTTP surface (§5). Everything that mutates state goes over HTTP so it stays
 * idempotent and auditable; the socket is read-only apart from presence.
 *
 * Master endpoints carry no session yet — auth is M2 (§6.4).
 */

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
}

/** 401 means no session, which is a state the UI renders rather than an error. */
export class Unauthorised extends Error {}

/**
 * 429 from the master login (M2b). Rendered, not logged: a master who mistyped
 * five times needs to be told to wait, or the screen looks broken at the venue.
 */
export class Throttled extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`throttled for ${retryAfterSeconds}s`);
  }
}

export async function fetchState(): Promise<Payload> {
  const response = await fetch('/api/state');
  if (response.status === 401) throw new Unauthorised();
  if (!response.ok) throw new Error(`/api/state: ${response.status}`);
  return (await response.json()) as Payload;
}

/**
 * The replay window (R-53..R-57). Master and `AUTHORITATIVE` only, which the
 * server enforces — a 403 here is R-25's revert having landed mid-replay, not a
 * bug, and the panel says so rather than logging it.
 *
 * Fetched **whole and scrubbed locally**, which is why one replay is one
 * request: `/api/track` is a read and does not stop R-25's clock, so polling it
 * per frame would both fail to hold the mode open and burn the free tier.
 */
export class ReplayForbidden extends Error {}

export async function fetchTrack(from: number, to: number): Promise<TrackWindow> {
  const response = await fetch(`/api/track?from=${Math.round(from)}&to=${Math.round(to)}`);
  if (response.status === 401) throw new Unauthorised();
  if (response.status === 403) throw new ReplayForbidden();
  if (!response.ok) throw new Error(`/api/track: ${response.status}`);
  return (await response.json()) as TrackWindow;
}

export interface Invite {
  playerId: string;
  callsign: string;
  fullName: string;
  path: string;
}

export async function fetchInvites(): Promise<Invite[]> {
  const response = await fetch('/api/master/invites');
  if (!response.ok) throw new Error(`/api/master/invites: ${response.status}`);
  return ((await response.json()) as { invites: Invite[] }).invites;
}

export async function loginMaster(password: string): Promise<void> {
  const response = await fetch('/api/session/master', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (response.status === 401) throw new Unauthorised();
  if (response.status === 429) {
    // Retry-After is seconds here, never the HTTP-date form: the Worker writes it.
    const seconds = Number(response.headers.get('retry-after'));
    throw new Throttled(Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60);
  }
  if (!response.ok) throw new Error(`/api/session/master: ${response.status}`);
}

export async function logout(): Promise<void> {
  await fetch('/api/session/logout', { method: 'POST' });
}

export const setViewMode = (mode: ViewMode): Promise<void> =>
  post('/api/master/view', { mode });

export const pairDevice = (deviceId: string, playerId: string): Promise<void> =>
  post('/api/master/devices/pair', { deviceId, playerId });

export const setGameState = (state: GameState): Promise<void> =>
  post('/api/master/game/state', { state });

export const setCutSwitch = (on: boolean): Promise<void> => post('/api/master/game/cut', { on });

/**
 * R-13, R-14. Records that someone spoke to a player by walkie. Available to
 * players as well as masters — the only state-changing call in the app that is.
 * Who reported it comes from the session, so there is nothing to pass but who it
 * was about.
 */
export const recordRadioContact = (playerId: string): Promise<void> =>
  post('/api/radio-contact', { playerId });

/**
 * R-30. Takes nothing: the player being declared is the session's own, and an id
 * here would be a way to eliminate somebody else.
 *
 * Nothing comes back but `ok` — the effects arrive in the next snapshot, through
 * `project()` like everything else. Refused with 409 outside a game in progress or
 * paused, which the button also hides for (M6).
 */
export const declareEliminated = (): Promise<void> => post('/api/me/eliminated', {});

/** R-32's reversal, master only. */
export const revivePlayer = (playerId: string): Promise<void> =>
  post(`/api/master/players/${encodeURIComponent(playerId)}/revive`, {});

/**
 * Swaps the live geometry (§11). Refused with 409 while the game is IN_PROGRESS,
 * because zones decide who sees whom and changing them mid-game does it silently.
 */
export const setGeoProfile = (profile: string): Promise<void> =>
  post('/api/master/game/geo', { profile });

/**
 * R-19, R-20b, R-21c. Up to five: placing a sixth is refused with
 * `MARKER_LIMIT` rather than pushing one off somebody's map, and the response
 * carries the marker that now exists so the panel can say what it did rather
 * than wait for the snapshot.
 *
 * Rejections are named the same way the roster's are, because the same things go
 * wrong at a venue: an audience nobody is in, a coordinate pair typed the wrong
 * way round.
 */
export interface MarkerRequest {
  label: string;
  lat: number;
  lon: number;
  audience: Audience;
  /** `null` is "no expiry" (R-21c); absent takes `markerDefaultTtlMs`. */
  ttlMs?: number | null;
}

export async function placeMarker(input: MarkerRequest): Promise<MasterMarker> {
  const response = await fetch('/api/master/marker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = (await response.json().catch(() => null)) as {
    marker?: MasterMarker;
    error?: { reason?: string };
  } | null;
  if (!response.ok || !payload?.marker) {
    throw new MarkerRejected(payload?.error?.reason ?? `HTTP_${response.status}`);
  }
  return payload.marker;
}

/** One marker by id, or every one of them when no id is given (§5). */
export async function clearMarker(id?: string): Promise<void> {
  const path = id === undefined ? '/api/master/marker' : `/api/master/marker/${id}`;
  const response = await fetch(path, { method: 'DELETE' });
  if (!response.ok) throw new MarkerRejected(`HTTP_${response.status}`);
}

/**
 * R-21d on QSA's scale (R-72). The only thing that lets team membership reach
 * the position axis (§4), so the panel treats a step up it as a decision rather
 * than a setting — and only a step **up**, because widening is what costs.
 */
export const setCommsReach = (reach: CommsReach): Promise<void> =>
  post('/api/master/comms', { reach });

/**
 * R-61. A point off every player's map, and off it after a reload.
 *
 * It was a `$state` array in this browser and nowhere else — so a second master
 * saw a different map from the first, and a refresh undid it. What makes it a
 * requirement rather than a preference is that it changes what the players are
 * looking at; what makes it safe is that the server logs every toggle.
 */
export const setPoiVisibility = (poiId: string, hidden: boolean): Promise<void> =>
  post('/api/master/pois/visibility', { poiId, hidden });

/**
 * R-71. Which zones are closed, as **the whole set** rather than one toggle.
 *
 * Idempotent by construction, so a double press or a retry cannot half-apply —
 * and closing a sector or a whole district is this call with a longer list,
 * which is why the server never has to learn what either word means. Allowed
 * during a game: the area shrinking around the players is the mechanic, not a
 * setting.
 */
export const setDisabledZones = (disabled: readonly string[]): Promise<void> =>
  post('/api/master/game/zones', { disabled });

/** What a refused marker says went wrong, so the panel can name it in Spanish. */
export class MarkerRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** What a failed roster call says went wrong, so the panel can name it (R-07). */
export class RosterRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function postRoster(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.status === 409) throw new RosterRejected('IN_PROGRESS');
  if (!response.ok) {
    const error = payload?.error as { reason?: string } | undefined;
    throw new RosterRejected(error?.reason ?? `HTTP_${response.status}`);
  }
  return payload ?? {};
}

/**
 * R-07. Returns the invite path, which is the whole of the new player's
 * authentication (§6.4) and is shown once rather than hunted for afterwards.
 */
export const addPlayer = (
  callsign: string,
  fullName: string,
  teamId?: string,
): Promise<{ path?: unknown }> =>
  postRoster('/api/master/players/add', {
    callsign,
    fullName,
    ...(teamId === undefined ? {} : { teamId }),
  });

export const removePlayer = (playerId: string): Promise<unknown> =>
  postRoster('/api/master/players/remove', { playerId });

/**
 * Teams (R-17, R-19). They scope which POIs and markers a player is addressed by
 * and grant no visibility at all — R-41 is explicit — so this is labelling, not a
 * second security axis.
 */
export const movePlayerToTeam = (playerId: string, teamId: string): Promise<unknown> =>
  postRoster('/api/master/players/team', { playerId, teamId });

export const addTeam = (name: string): Promise<unknown> =>
  postRoster('/api/master/teams/add', { name });

export const renameTeam = (teamId: string, name: string): Promise<unknown> =>
  postRoster('/api/master/teams/rename', { teamId, name });

export const removeTeam = (teamId: string): Promise<unknown> =>
  postRoster('/api/master/teams/remove', { teamId });

/**
 * Wipes the game and lets it seed fresh. Returns the previous state so the panel
 * can hand it to the master as a file — storage is what is being deleted, so there
 * is nowhere else for it to go.
 */
export async function resetGame(confirm: string): Promise<unknown> {
  const response = await fetch('/api/master/game/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm }),
  });
  if (response.status === 409) throw new RosterRejected('IN_PROGRESS');
  if (!response.ok) throw new RosterRejected(await response.text());
  return ((await response.json()) as { archive?: unknown }).archive;
}

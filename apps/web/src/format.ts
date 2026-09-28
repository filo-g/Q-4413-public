import { t } from './i18n.ts';

/**
 * Age is derived on the client from the ping timestamp (R-15). The server does
 * not tick to keep these fresh, and must not start.
 *
 * `now` must be `game.serverNow`, not `Date.now()`: the threshold these ages are
 * read against is 90 s, and a phone clock is not reliable at that resolution
 * (R-36).
 */
export function formatAge(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}${t.units.seconds}`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}${t.units.minutes}`;
  return `${Math.floor(seconds / 3600)}${t.units.hours}`;
}

/**
 * A remaining duration, not an age: used by the login lockout countdown, which
 * counts down rather than up.
 */
export function formatDuration(seconds: number): string {
  const left = Math.max(0, Math.ceil(seconds));
  if (left < 60) return `${left}${t.units.seconds}`;
  return `${Math.ceil(left / 60)}${t.units.minutes}`;
}

/**
 * R-45's rough time, and the rule is in the requirement: **"≈4 min", never
 * "4:12"**. The number is a straight-line distance inflated by a guess about
 * routes nobody has traced, measured from a position that carries its own error;
 * a colon and a seconds digit would claim a precision that does not exist.
 *
 * Under a minute reads as "<1 min" rather than counting seconds, for the same
 * reason — nobody walks accurately enough for 40 s to mean anything.
 *
 * Two departures from the requirement's own example, both deliberate. The mark
 * is `~` and not `≈`, because neither shipped font carries `≈` and a tofu box
 * in front of a number is worse than a rougher operator. And the space goes
 * after the mark rather than before the unit, which is where R-45 puts it: a
 * unit sits against its number everywhere else here (`37m`, `2h`), so moving
 * that space would make this the one reading that reads differently.
 *
 * Returned in parts because the mark is a qualifier rather than a digit, and at
 * full size beside a two-digit number it stops looking like one. `Eta.svelte`
 * sets it smaller; nothing else can, since a string has no seam to style.
 */
export function etaParts(seconds: number): { mark?: string; value: string } {
  if (!Number.isFinite(seconds)) return { value: '—' };
  const minutes = seconds / 60;
  if (minutes < 1) return { value: `<1${t.units.minutes}` };
  return { mark: t.units.approx, value: `${Math.round(minutes)}${t.units.minutes}` };
}

/**
 * The same reading as one string, for everywhere an element cannot go — a
 * `title`, a log line, the suite. `Eta.svelte` is what the screen uses, and it
 * is the only place the mark can be set apart from the number.
 */
export function formatEta(seconds: number): string {
  const { mark, value } = etaParts(seconds);
  return mark ? `${mark} ${value}` : value;
}

/** Metres to a POI or a marker. Coarse past a hundred, for the reason above. */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres)) return '—';
  if (metres < 100) return `${Math.round(metres)}${t.player.metres}`;
  if (metres < 1000) return `${Math.round(metres / 10) * 10}${t.player.metres}`;
  return `${(metres / 1000).toFixed(1)}k${t.player.metres}`;
}

export function formatCoords(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/**
 * R-12's radius. Rounded coarsely on purpose once it is large: a circle of
 * "±1240m" invites reading a precision that a walking-speed guess about someone
 * who has been silent for fifteen minutes does not have.
 */
export function formatUncertainty(metres: number): string {
  if (metres < 100) return `±${Math.round(metres)}${t.player.metres}`;
  if (metres < 1000) return `±${Math.round(metres / 10) * 10}${t.player.metres}`;
  return `±${(metres / 1000).toFixed(1)}k${t.player.metres}`;
}

/**
 * A bearing as a compass point, for R-43's return arrow.
 *
 * **A compass bearing and not a screen-relative direction**, which is the
 * honest thing to render: R-50 rules out device sensors and browser
 * geolocation entirely, so nothing in the system knows which way the phone is
 * being held. "Vuelve hacia el O" is followable with the map on screen; an
 * arrow that looks screen-relative and is not would send a player the wrong way
 * in the dark.
 *
 * Eight points rather than sixteen or degrees, because the position it is
 * computed from carries 8 m of error and the player is running.
 */
export function formatBearing(degrees: number): string {
  const points = t.compass;
  const index = Math.round((((degrees % 360) + 360) % 360) / 45) % 8;
  return points[index] ?? points[0]!;
}

/**
 * A zone as its name, never as its id.
 *
 * `position.zoneId` is what §4 decides visibility on and what the server sends;
 * it is an identifier out of the geometry file — `zone-restaurantes` — and it
 * reached the master's card as one. A zone is something a master says out
 * loud on the radio, so the only useful form of it is the name the venue's
 * geometry gives it.
 *
 * Here rather than in either view because both draw it, and a second copy of
 * this lookup is a second answer: the player's roster had the only one, so the
 * master's card printed the raw value for as long as it existed.
 *
 * The fallbacks are ordered on purpose. A zone the payload does not carry falls
 * back to **the id**, not to the dash: an id nobody can read is still evidence
 * that somebody is somewhere, and the dash says the opposite. Only an absent
 * zone — out of every one of them (R-40) — gets the dash.
 */
export function zoneName(
  zones: ReadonlyArray<{ id: string; name: string }> | undefined,
  id: string | undefined,
): string {
  if (id === undefined) return '—';
  return zones?.find((zone) => zone.id === id)?.name ?? id;
}

/**
 * Where somebody is, in both of R-70's words: `NORTE · NORTE ESTE`.
 *
 * A zone name was the whole answer while there was one venue, and it stopped
 * being one the day the game covered more ground than one walk. "Estoy en
 * Comercio" locates nobody who has not been there, and across a dozen sectors
 * that is most people most of the time — the sector is the half a master can
 * act on over a radio, and the zone is the half that says where in it.
 *
 * **The sector is dropped when it would repeat the zone.** A sector whose only
 * zone carries the sector's own name (R-70) reads honestly as `Ribera`, not
 * `Ribera · Ribera`. The duplicate is not a formatting nicety: a card that says
 * everything twice teaches the reader to skip the line.
 *
 * Same fallbacks as `zoneName()` and for the same reason — an id nobody can
 * read is still evidence somebody is somewhere, and only an absent zone gets
 * the dash. A zone whose sector is not in the payload prints the zone alone,
 * which is what a player gets for a sector R-71 closed under them.
 */
export function placeName(
  zones: ReadonlyArray<{ id: string; name: string; sector: string }> | undefined,
  sectors: ReadonlyArray<{ id: string; name: string }> | undefined,
  id: string | undefined,
): string {
  if (id === undefined) return '—';
  const zone = zones?.find((candidate) => candidate.id === id);
  if (!zone) return id;
  const sector = sectors?.find((candidate) => candidate.id === zone.sector);
  if (!sector || sector.name === zone.name) return zone.name;
  return `${sector.name} · ${zone.name}`;
}

/**
 * A wall-clock reading of an instant, to the second (R-66).
 *
 * `2026/09/23 11:07:58`. Every other time on screen is an **age** —
 * `formatAge()` prints `45s` because what a master needs mid-game is how stale
 * a fix is, not what the clock said when it arrived. A debrief inverts that: the
 * question is what happened *at* 10:51, which an age cannot answer, and the
 * answer has to be sayable out loud to somebody holding a radio log.
 *
 * Big-endian date because it sorts, and because it cannot be misread — a Spanish
 * master reading `09/23` and an English one reading `23/09` both get the same
 * day out of `2026/09/23`, and no reading of it is a valid other date.
 *
 * **The device's own timezone, and deliberately not the server's.** R-36 makes
 * `serverNow` the one clock anything is *compared* against, which is about
 * arithmetic on a handset whose clock drifts; this is the opposite direction —
 * a number the master reads off the screen and matches to their own watch, a
 * radio log or a video's timecode. A game is played in one place, and the
 * master's browser is in it.
 *
 * Built from the date's own fields rather than `toLocaleString`, which renders
 * this differently in every locale the browser might be set to and would put the
 * month first on a machine configured in English.
 */
export function formatClock(ts: number): string {
  const at = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const date = `${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())}`;
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * The right-hand column of a log line: what an event was about, and what it
 * carried.
 *
 * Joined rather than concatenated, and that is the whole of it. This was
 * `target ?? ''` followed by `' ' + data`, so the space that separates the two
 * was written as part of the second — which is correct for the events that have
 * both and wrong for the ones that have only data. `GAME_STATE` and
 * `CUT_SWITCH` name no target, so every one of their lines began with a space
 * and sat one character right of every line above it, in a column of monospace
 * where that is the one thing the eye is reading.
 *
 * Truthiness rather than `!== undefined`, to keep what the markup did: an event
 * with no data prints nothing for it, and an empty target contributes no
 * separator of its own.
 */
export function eventDetail(event: { target?: string; data?: unknown }): string {
  const parts: string[] = [];
  if (event.target) parts.push(event.target);
  if (event.data) parts.push(JSON.stringify(event.data));
  return parts.join(' ');
}

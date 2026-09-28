import type { Player, Team } from '@q4413/shared';

/**
 * Adding and removing players (R-07, R-27).
 *
 * R-07 requires the whole game — players included — to be configurable before
 * anyone leaves for the venue, and until now the roster was a literal in the
 * Worker. That was worse than it looked: players are **seeded**, not deployed.
 * A game reads its roster once, on the storage miss that creates it, so editing
 * the seed changes what the next game would start with and nothing about the one
 * running. The same shape as the geometry, and the same answer — a route.
 *
 * Pure, and separate from the Durable Object, because the decisions here are the
 * game's and the storage is the platform's (§6.5). What is left in the Worker is
 * writing the result down and closing the removed player's socket.
 *
 * ## Who is allowed to do this, and when
 *
 * Not a view-mode question. `AUTHORITATIVE` differs from `OPERATIONAL` on exactly
 * one axis — which position source a stopped feed uses (R-22) — and its
 * confirmation and ten-minute revert (R-24, R-25) exist to *discourage* entering
 * it, because it spoils the game for a master who plays. Configuration behind it
 * would mean setting up in spoiler mode.
 *
 * The real concern is a stray tap mid-game, and game state already answers it:
 * the caller refuses these while `IN_PROGRESS`, exactly as the geometry switch
 * does. R-07's "before anyone leaves for the venue" is the same sentence.
 */

/**
 * A callsign is spoken on the radio, so it is letters and digits and nothing
 * clever. Unicode letters rather than ASCII: the players are Spanish and a
 * callsign like ÑANDU is ordinary, while `<` and `/` are not sayable and would
 * only ever arrive from a paste. The id derived below flattens the accent, so
 * ÑU becomes player-nu and stays URL-shaped.
 */
const CALLSIGN = /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u;

export type RosterError =
  | { reason: 'CALLSIGN_REQUIRED' }
  | { reason: 'TEAM_NAME_REQUIRED' }
  | { reason: 'TEAM_NAME_INVALID'; name: string }
  | { reason: 'TEAM_TAKEN'; name: string }
  | { reason: 'TEAM_NOT_EMPTY'; teamId: string; players: number }
  | { reason: 'LAST_TEAM' }
  | { reason: 'CALLSIGN_INVALID'; callsign: string }
  | { reason: 'CALLSIGN_TAKEN'; callsign: string }
  | { reason: 'FULL_NAME_REQUIRED' }
  | { reason: 'UNKNOWN_TEAM'; teamId: string }
  | { reason: 'NO_TEAMS' }
  | { reason: 'UNKNOWN_PLAYER'; playerId: string };

export type RosterResult<T> = { ok: true; value: T } | { ok: false; error: RosterError };

export interface Roster {
  players: Player[];
  teams: Team[];
}

/**
 * `ALFA` becomes `player-alfa`, which is readable in a log and in a URL.
 *
 * Derived from the callsign rather than counted, because a counter renumbers when
 * something is removed and these ids are stored on devices and referenced by
 * radio-contact records. It is unique for the same reason a callsign is: two
 * players with the same one could not be told apart on the radio either.
 */
export function playerIdFor(callsign: string): string {
  return `player-${slug(callsign)}`;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** `ZULU` becomes `team-zulu`, by the same rule and for the same reasons as a player id. */
export function teamIdFor(name: string): string {
  return `team-${slug(name)}`;
}

/** Uppercased, because every screen shows it that way and the radio has no case. */
export function normaliseCallsign(callsign: string): string {
  return callsign.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * @param sessionToken the new player's invite token, supplied rather than
 *        generated so this stays pure and portable (§6.5) — randomness is the
 *        one thing the runtime has to provide.
 */
export function addPlayer(
  roster: Roster,
  input: { callsign: string; fullName: string; teamId?: string },
  sessionToken: string,
): RosterResult<{ roster: Roster; player: Player }> {
  const callsign = normaliseCallsign(input.callsign ?? '');
  const fullName = (input.fullName ?? '').trim();

  if (callsign === '') return { ok: false, error: { reason: 'CALLSIGN_REQUIRED' } };
  if (!CALLSIGN.test(callsign)) {
    return { ok: false, error: { reason: 'CALLSIGN_INVALID', callsign } };
  }
  // R-27: a record holds exactly two identity fields, and both are the point of
  // it — fullName is there so a master who has forgotten who NOGAL is can check.
  if (fullName === '') return { ok: false, error: { reason: 'FULL_NAME_REQUIRED' } };

  const id = playerIdFor(callsign);
  const clash = roster.players.some(
    (player) => player.id === id || normaliseCallsign(player.callsign) === callsign,
  );
  if (clash) return { ok: false, error: { reason: 'CALLSIGN_TAKEN', callsign } };

  if (roster.teams.length === 0) return { ok: false, error: { reason: 'NO_TEAMS' } };
  const team = input.teamId
    ? roster.teams.find((candidate) => candidate.id === input.teamId)
    : roster.teams[0];
  if (!team) return { ok: false, error: { reason: 'UNKNOWN_TEAM', teamId: input.teamId! } };

  const player: Player = { id, callsign, fullName, teamId: team.id, sessionToken };

  return {
    ok: true,
    value: {
      roster: {
        players: [...roster.players, player],
        teams: roster.teams.map((candidate) =>
          candidate.id === team.id
            ? { ...candidate, playerIds: [...candidate.playerIds, id] }
            : candidate,
        ),
      },
      player,
    },
  };
}

/**
 * Removing a player takes their team membership with them, and reports the device
 * they were holding so the caller can drop its binding.
 *
 * The device record is dropped rather than reassigned: an unknown id lands in the
 * tray on its next ping (R-06), so the binding heals itself the moment the phone
 * reports again, and nothing has to remember a device that may never come back.
 *
 * Radio-contact records naming the removed player as `reportedBy` are left alone.
 * They are a note that somebody spoke to somebody, and the note was true when it
 * was made; rewriting history to tidy a foreign key would be the larger lie, and
 * R-13 gives contact five minutes before it stops counting anyway.
 */
export function removePlayer(
  roster: Roster,
  playerId: string,
): RosterResult<{ roster: Roster; removed: Player; deviceId?: string }> {
  const removed = roster.players.find((player) => player.id === playerId);
  if (!removed) return { ok: false, error: { reason: 'UNKNOWN_PLAYER', playerId } };

  return {
    ok: true,
    value: {
      roster: {
        players: roster.players.filter((player) => player.id !== playerId),
        teams: roster.teams.map((team) => ({
          ...team,
          playerIds: team.playerIds.filter((id) => id !== playerId),
        })),
      },
      removed,
      ...(removed.deviceId === undefined ? {} : { deviceId: removed.deviceId }),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Teams                                                              */
/*                                                                    */
/* Teams were seeded too, which is the same trap the roster and the   */
/* geometry were in and was found the same way: a game keeps the two  */
/* placeholder teams it was created with, so every player added by    */
/* hand landed in "Equipo A" with no way to say otherwise.            */
/*                                                                    */
/* What a team is for is narrow, and worth keeping in view. It scopes */
/* POI and marker audiences (R-17, R-19) and grants no visibility     */
/* whatever — R-41 is explicit that a teammate in another zone is as  */
/* invisible as anyone else. So this is labelling and addressing, not */
/* a second security axis.                                            */
/* ------------------------------------------------------------------ */

/** A team name is read on a screen, not spoken, so it is looser than a callsign. */
const TEAM_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

export function addTeam(roster: Roster, input: { name: string }): RosterResult<{
  roster: Roster;
  team: Team;
}> {
  const name = (input.name ?? '').trim().replace(/\s+/g, ' ');
  if (name === '') return { ok: false, error: { reason: 'TEAM_NAME_REQUIRED' } };
  if (!TEAM_NAME.test(name)) return { ok: false, error: { reason: 'TEAM_NAME_INVALID', name } };

  const id = teamIdFor(name);
  const clash = roster.teams.some(
    (team) => team.id === id || team.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) return { ok: false, error: { reason: 'TEAM_TAKEN', name } };

  const team: Team = { id, name, playerIds: [] };
  return { ok: true, value: { roster: { ...roster, teams: [...roster.teams, team] }, team } };
}

/**
 * Renames a team **without touching its id.**
 *
 * Deriving the id from the name is right at creation and wrong afterwards: every
 * player carries `teamId`, and a rename that renumbered it would silently orphan
 * all of them. So a team created as "Equipo A" and renamed to "ZULU" keeps
 * `team-a`, which is mildly ugly in a log and is the price of the name being
 * editable at all. Nothing reads the id for meaning.
 */
export function renameTeam(
  roster: Roster,
  teamId: string,
  input: { name: string },
): RosterResult<{ roster: Roster; team: Team }> {
  const existing = roster.teams.find((team) => team.id === teamId);
  if (!existing) return { ok: false, error: { reason: 'UNKNOWN_TEAM', teamId } };

  const name = (input.name ?? '').trim().replace(/\s+/g, ' ');
  if (name === '') return { ok: false, error: { reason: 'TEAM_NAME_REQUIRED' } };
  if (!TEAM_NAME.test(name)) return { ok: false, error: { reason: 'TEAM_NAME_INVALID', name } };

  const clash = roster.teams.some(
    (team) => team.id !== teamId && team.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) return { ok: false, error: { reason: 'TEAM_TAKEN', name } };

  const team: Team = { ...existing, name };
  return {
    ok: true,
    value: {
      roster: { ...roster, teams: roster.teams.map((t) => (t.id === teamId ? team : t)) },
      team,
    },
  };
}

/**
 * Refuses to remove a team that still holds players, and refuses to remove the
 * last one.
 *
 * Reassigning them silently would be the friendlier-looking choice and the worse
 * one: which team they land in is a decision, and making it on the master's behalf
 * while they are looking at a delete button is how someone ends up addressed by a
 * marker meant for the other side. Move them first, deliberately.
 *
 * The last team is refused because `addPlayer` has nowhere to put anyone without
 * one, so a roster with no teams is a roster that cannot grow.
 */
export function removeTeam(roster: Roster, teamId: string): RosterResult<{ roster: Roster }> {
  const existing = roster.teams.find((team) => team.id === teamId);
  if (!existing) return { ok: false, error: { reason: 'UNKNOWN_TEAM', teamId } };

  const holding = roster.players.filter((player) => player.teamId === teamId).length;
  if (holding > 0) {
    return { ok: false, error: { reason: 'TEAM_NOT_EMPTY', teamId, players: holding } };
  }
  if (roster.teams.length === 1) return { ok: false, error: { reason: 'LAST_TEAM' } };

  return {
    ok: true,
    value: { roster: { ...roster, teams: roster.teams.filter((team) => team.id !== teamId) } },
  };
}

/**
 * Moves a player between teams, keeping `Player.teamId` and `Team.playerIds` in
 * step — they are two spellings of one fact, and §3 keeps both, so every write has
 * to touch both or the roster starts disagreeing with itself.
 */
export function movePlayer(
  roster: Roster,
  playerId: string,
  teamId: string,
): RosterResult<{ roster: Roster; player: Player }> {
  const existing = roster.players.find((player) => player.id === playerId);
  if (!existing) return { ok: false, error: { reason: 'UNKNOWN_PLAYER', playerId } };
  if (!roster.teams.some((team) => team.id === teamId)) {
    return { ok: false, error: { reason: 'UNKNOWN_TEAM', teamId } };
  }

  const player: Player = { ...existing, teamId };
  return {
    ok: true,
    value: {
      roster: {
        players: roster.players.map((p) => (p.id === playerId ? player : p)),
        teams: roster.teams.map((team) => ({
          ...team,
          playerIds:
            team.id === teamId
              ? [...team.playerIds.filter((id) => id !== playerId), playerId]
              : team.playerIds.filter((id) => id !== playerId),
        })),
      },
      player,
    },
  };
}

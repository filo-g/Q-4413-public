import { describe, expect, it } from 'vitest';

import {
  addPlayer,
  addTeam,
  movePlayer,
  normaliseCallsign,
  playerIdFor,
  removePlayer,
  removeTeam,
  renameTeam,
} from '@q4413/core';
import type { Player, Team } from '@q4413/shared';

/**
 * R-07 makes the roster configuration, and configuration that can only be edited
 * by redeploying is not configuration. These are the decisions; writing them down
 * and closing the removed player's socket is the Worker's part.
 */
const TOKEN = 'token-nuevo';

const player = (callsign: string, over: Partial<Player> = {}): Player => ({
  id: playerIdFor(callsign),
  callsign,
  fullName: `Nombre de ${callsign}`,
  teamId: 'team-zulu',
  sessionToken: `token-${callsign.toLowerCase()}`,
  ...over,
});

const roster = (callsigns: string[] = ['ALFA', 'LIMA']) => {
  const players = callsigns.map((callsign) => player(callsign));
  const teams: Team[] = [
    { id: 'team-zulu', name: 'ZULU', playerIds: players.map((p) => p.id) },
  ];
  return { players, teams };
};

describe('playerIdFor — readable, and unique because callsigns are', () => {
  it('derives the id from the callsign rather than a counter', () => {
    // A counter renumbers on removal, and these ids are stored on devices and
    // referenced by radio-contact records.
    expect(playerIdFor('ALFA')).toBe('player-alfa');
    expect(playerIdFor('CONTROL')).toBe('player-control');
  });

  it('flattens spaces and accents into something URL-shaped', () => {
    expect(playerIdFor('SIERRA DOS')).toBe('player-sierra-dos');
    expect(playerIdFor('ÑU')).toBe('player-nu');
  });
});

describe('normaliseCallsign', () => {
  it('uppercases and collapses whitespace, because the radio has no case', () => {
    expect(normaliseCallsign('  alfa   dos ')).toBe('ALFA DOS');
  });
});

describe('addPlayer', () => {
  it('adds the player and puts them in the team', () => {
    const result = addPlayer(roster(), { callsign: 'kilo', fullName: 'Nombre de KILO' }, TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.player).toEqual({
      id: 'player-kilo',
      callsign: 'KILO',
      fullName: 'Nombre de KILO',
      teamId: 'team-zulu',
      sessionToken: TOKEN,
    });
    expect(result.value.roster.players.map((p) => p.callsign)).toEqual(['ALFA', 'LIMA', 'KILO']);
    expect(result.value.roster.teams[0]?.playerIds).toContain('player-kilo');
  });

  it('does not mutate the roster it was given', () => {
    const original = roster();
    addPlayer(original, { callsign: 'KILO', fullName: 'Nombre de KILO' }, TOKEN);
    expect(original.players).toHaveLength(2);
    expect(original.teams[0]?.playerIds).toHaveLength(2);
  });

  it('refuses a callsign already in use, whatever case it was typed in', () => {
    const result = addPlayer(roster(), { callsign: '  alfa ', fullName: 'Otro' }, TOKEN);
    expect(result).toEqual({ ok: false, error: { reason: 'CALLSIGN_TAKEN', callsign: 'ALFA' } });
  });

  it('refuses two callsigns that would collapse to the same id', () => {
    // ALFA-DOS and "ALFA DOS" are different on the radio and identical in a URL.
    const first = addPlayer(roster(), { callsign: 'ALFA DOS', fullName: 'Uno' }, TOKEN);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = addPlayer(first.value.roster, { callsign: 'ALFA-DOS', fullName: 'Dos' }, TOKEN);
    expect(second.ok).toBe(false);
  });

  it('requires both identity fields R-27 allows', () => {
    expect(addPlayer(roster(), { callsign: '', fullName: 'Nombre de KILO' }, TOKEN)).toEqual({
      ok: false,
      error: { reason: 'CALLSIGN_REQUIRED' },
    });
    expect(addPlayer(roster(), { callsign: 'KILO', fullName: '  ' }, TOKEN)).toEqual({
      ok: false,
      error: { reason: 'FULL_NAME_REQUIRED' },
    });
  });

  it('refuses a callsign that is not sayable on a radio', () => {
    const result = addPlayer(roster(), { callsign: 'K/L<O>', fullName: 'Nombre de KILO' }, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('CALLSIGN_INVALID');
  });

  it('accepts an accented callsign, since the players are Spanish', () => {
    const result = addPlayer(roster(), { callsign: 'ñandú', fullName: 'Nombre' }, TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.player.callsign).toBe('ÑANDÚ');
    // The id flattens it, so it stays URL-shaped and readable in a log.
    expect(result.value.player.id).toBe('player-nandu');
  });

  it('defaults to the first team and refuses an unknown one', () => {
    const two = roster();
    two.teams.push({ id: 'team-b', name: 'Equipo B', playerIds: [] });

    const defaulted = addPlayer(two, { callsign: 'KILO', fullName: 'Nombre de KILO' }, TOKEN);
    expect(defaulted.ok && defaulted.value.player.teamId).toBe('team-zulu');

    const chosen = addPlayer(two, { callsign: 'KILO', fullName: 'Nombre de KILO', teamId: 'team-b' }, TOKEN);
    expect(chosen.ok && chosen.value.player.teamId).toBe('team-b');

    expect(
      addPlayer(two, { callsign: 'KILO', fullName: 'Nombre de KILO', teamId: 'team-z' }, TOKEN),
    ).toEqual({ ok: false, error: { reason: 'UNKNOWN_TEAM', teamId: 'team-z' } });
  });

  it('refuses when there is no team to join', () => {
    expect(
      addPlayer({ players: [], teams: [] }, { callsign: 'KILO', fullName: 'Nombre de KILO' }, TOKEN),
    ).toEqual({ ok: false, error: { reason: 'NO_TEAMS' } });
  });
});

describe('removePlayer', () => {
  it('takes the player out of the roster and out of the team', () => {
    const result = removePlayer(roster(), 'player-alfa');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.roster.players.map((p) => p.id)).toEqual(['player-lima']);
    expect(result.value.roster.teams[0]?.playerIds).toEqual(['player-lima']);
    expect(result.value.removed.callsign).toBe('ALFA');
  });

  it('reports the device the player was holding, so the caller can drop it', () => {
    const held = roster();
    held.players[0] = player('ALFA', { deviceId: 'movil-pixel9' });
    const result = removePlayer(held, 'player-alfa');
    expect(result.ok && result.value.deviceId).toBe('movil-pixel9');
  });

  it('reports no device for a player who never had one', () => {
    const result = removePlayer(roster(), 'player-alfa');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty('deviceId');
  });

  it('does not mutate the roster it was given', () => {
    const original = roster();
    removePlayer(original, 'player-alfa');
    expect(original.players).toHaveLength(2);
    expect(original.teams[0]?.playerIds).toHaveLength(2);
  });

  it('refuses an unknown player rather than succeeding quietly', () => {
    expect(removePlayer(roster(), 'player-nadie')).toEqual({
      ok: false,
      error: { reason: 'UNKNOWN_PLAYER', playerId: 'player-nadie' },
    });
  });

  it('frees the callsign, so a typo can be corrected by removing and re-adding', () => {
    const removed = removePlayer(roster(), 'player-alfa');
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const readded = addPlayer(removed.value.roster, { callsign: 'ALFA', fullName: 'Nombre de ALFA' }, TOKEN);
    expect(readded.ok).toBe(true);
    if (!readded.ok) return;
    // A fresh invite token, which is the honest outcome: the old link was handed
    // to somebody and removing the player is what revokes it (§6.4).
    expect(readded.value.player.sessionToken).toBe(TOKEN);
    expect(readded.value.player.fullName).toBe('Nombre de ALFA');
  });
});

describe('teams — labelling and addressing, not a security axis', () => {
  it('creates a team with an id derived from the name, and empty', () => {
    const result = addTeam(roster(), { name: 'Equipo Bravo' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Empty on creation: joining is movePlayer's job, so there is one way in.
    expect(result.value.team).toEqual({
      id: 'team-equipo-bravo',
      name: 'Equipo Bravo',
      playerIds: [],
    });
  });

  it('refuses a duplicate name whatever case or spacing it was typed in', () => {
    // The fixture's team is already ZULU.
    expect(addTeam(roster(), { name: '  zulu  ' })).toEqual({
      ok: false,
      error: { reason: 'TEAM_TAKEN', name: 'zulu' },
    });
  });

  it('requires a usable name', () => {
    expect(addTeam(roster(), { name: '   ' })).toEqual({
      ok: false,
      error: { reason: 'TEAM_NAME_REQUIRED' },
    });
    const bad = addTeam(roster(), { name: '<script>' });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.reason).toBe('TEAM_NAME_INVALID');
  });

  /**
   * The whole point of renaming being separate from creating: every player carries
   * teamId, so a rename that renumbered the id would orphan all of them at once.
   */
  it('renames without touching the id, so nobody is orphaned', () => {
    const result = renameTeam(roster(), 'team-zulu', { name: 'Equipo A' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.team).toEqual({
      id: 'team-zulu',
      name: 'Equipo A',
      playerIds: ['player-alfa', 'player-lima'],
    });
    // And the players still point at a team that exists.
    for (const player of result.value.roster.players) {
      expect(result.value.roster.teams.some((t) => t.id === player.teamId)).toBe(true);
    }
  });

  it('refuses to rename an unknown team', () => {
    expect(renameTeam(roster(), 'team-nadie', { name: 'X' })).toEqual({
      ok: false,
      error: { reason: 'UNKNOWN_TEAM', teamId: 'team-nadie' },
    });
  });

  it('refuses to remove a team that still holds players', () => {
    expect(removeTeam(roster(), 'team-zulu')).toEqual({
      ok: false,
      error: { reason: 'TEAM_NOT_EMPTY', teamId: 'team-zulu', players: 2 },
    });
  });

  it('refuses to remove the last team, since addPlayer would have nowhere to put anyone', () => {
    const empty = { players: [], teams: [{ id: 'team-zulu', name: 'ZULU', playerIds: [] }] };
    expect(removeTeam(empty, 'team-zulu')).toEqual({ ok: false, error: { reason: 'LAST_TEAM' } });
  });

  it('removes an empty team when another remains', () => {
    const two = addTeam(roster(), { name: 'BRAVO' });
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    const result = removeTeam(two.value.roster, 'team-bravo');
    expect(result.ok && result.value.roster.teams.map((t) => t.id)).toEqual(['team-zulu']);
  });
});

describe('movePlayer — the two spellings of one fact stay in step', () => {
  const twoTeams = () => {
    const base = roster();
    const added = addTeam(base, { name: 'BRAVO' });
    if (!added.ok) throw new Error('fixture');
    return added.value.roster;
  };

  it('moves the player and both team lists with them', () => {
    const result = movePlayer(twoTeams(), 'player-alfa', 'team-bravo');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.player.teamId).toBe('team-bravo');
    const teams = Object.fromEntries(result.value.roster.teams.map((t) => [t.id, t.playerIds]));
    expect(teams['team-zulu']).toEqual(['player-lima']);
    expect(teams['team-bravo']).toEqual(['player-alfa']);
  });

  it('keeps Player.teamId and Team.playerIds agreeing after several moves', () => {
    // §3 stores the membership twice, so every write has to touch both or the
    // roster starts disagreeing with itself.
    let current = twoTeams();
    for (const teamId of ['team-bravo', 'team-zulu', 'team-bravo']) {
      const result = movePlayer(current, 'player-alfa', teamId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      current = result.value.roster;
    }
    for (const team of current.teams) {
      for (const id of team.playerIds) {
        expect(current.players.find((p) => p.id === id)?.teamId).toBe(team.id);
      }
    }
    for (const player of current.players) {
      const holder = current.teams.filter((t) => t.playerIds.includes(player.id));
      expect(holder).toHaveLength(1);
      expect(holder[0]?.id).toBe(player.teamId);
    }
  });

  it('does not duplicate the player when moved to the team they are already in', () => {
    const result = movePlayer(twoTeams(), 'player-alfa', 'team-zulu');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roster.teams[0]?.playerIds.filter((id) => id === 'player-alfa')).toHaveLength(1);
  });

  it('refuses an unknown player or an unknown team', () => {
    expect(movePlayer(twoTeams(), 'player-nadie', 'team-zulu')).toEqual({
      ok: false,
      error: { reason: 'UNKNOWN_PLAYER', playerId: 'player-nadie' },
    });
    expect(movePlayer(twoTeams(), 'player-alfa', 'team-nadie')).toEqual({
      ok: false,
      error: { reason: 'UNKNOWN_TEAM', teamId: 'team-nadie' },
    });
  });

  it('does not mutate the roster it was given', () => {
    const original = twoTeams();
    movePlayer(original, 'player-alfa', 'team-bravo');
    expect(original.players.find((p) => p.id === 'player-alfa')?.teamId).toBe('team-zulu');
  });
});

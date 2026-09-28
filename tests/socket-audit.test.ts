import { describe, expect, it } from 'vitest';

import { auditMasterPayload, auditPlayerPayload, parseArgs } from '../tools/socket-audit.mjs';

/**
 * An auditor that never finds anything is worse than no auditor, so it gets fed
 * deliberately dirty payloads. Each case is one way a future change could leak.
 */
const cleanPlayer = (): Record<string, any> => ({
  game: { id: 'g', name: 'Q-4413', state: 'IN_PROGRESS', cutSwitch: false },
  self: { id: 'alfa', callsign: 'ALFA', fullName: 'Nombre', position: { zoneId: 'z1' } },
  players: [
    { id: 'bravo', callsign: 'BRAVO', distanceMetres: 20, position: { lat: 1, lon: 2 }, battery: 70 },
    { id: 'golf', callsign: 'GOLF', distanceMetres: 90, position: { lat: 1, lon: 2 } },
    { id: 'charlie', callsign: 'CHARLIE', outOfZone: true },
  ],
  teams: [],
  pois: [],
  zones: [],
  markers: [],
  replayAvailable: false,
});

describe('auditPlayerPayload', () => {
  it('passes a clean payload', () => {
    expect(auditPlayerPayload(cleanPlayer())).toEqual([]);
  });

  it('catches a full name on another player (R-27)', () => {
    const payload = cleanPlayer();
    payload.players[0].fullName = 'Nombre de BRAVO';
    expect(auditPlayerPayload(payload).join()).toMatch(/fullName present/);
  });

  it('catches a device id', () => {
    const payload = cleanPlayer();
    payload.players[0].deviceId = 'ph-bravo';
    expect(auditPlayerPayload(payload).join()).toMatch(/deviceId present/);
  });

  it('catches elimination state (R-30.2)', () => {
    const payload = cleanPlayer();
    payload.players[0].eliminated = { ts: 1, dropPoint: { lat: 1, lon: 2 }, selfDeclared: true };
    expect(auditPlayerPayload(payload).join()).toMatch(/elimination state present/);
  });

  it('catches a position on an out-of-zone player (R-40)', () => {
    const payload = cleanPlayer();
    payload.players[2].position = { lat: 1, lon: 2 };
    expect(auditPlayerPayload(payload).join()).toMatch(/out of zone with a position/);
  });

  it('catches a distance on an out-of-zone player (R-42)', () => {
    const payload = cleanPlayer();
    payload.players[2].distanceMetres = 400;
    expect(auditPlayerPayload(payload).join()).toMatch(/out of zone with a distance/);
  });

  it('catches a battery reading on an out-of-zone player', () => {
    const payload = cleanPlayer();
    payload.players[2].battery = 50;
    expect(auditPlayerPayload(payload).join()).toMatch(/out of zone with a battery/);
  });

  it('catches same-zone players out of proximity order (R-42)', () => {
    const payload = cleanPlayer();
    payload.players[0].distanceMetres = 90;
    payload.players[1].distanceMetres = 20;
    expect(auditPlayerPayload(payload).join()).toMatch(/not ordered by proximity/);
  });

  it('catches the out-of-zone group not being last (R-40)', () => {
    const payload = cleanPlayer();
    payload.players = [payload.players[2], payload.players[0], payload.players[1]];
    expect(auditPlayerPayload(payload).join()).toMatch(/not last in the list/);
  });

  it.each(['tray', 'events', 'viewMode'])('catches a master-only field: %s', (field) => {
    const payload = cleanPlayer();
    payload[field] = field === 'viewMode' ? 'AUTHORITATIVE' : [];
    expect(auditPlayerPayload(payload).join()).toMatch(new RegExp(`${field} present`));
  });

  it('catches replay being offered to a player (R-26)', () => {
    const payload = cleanPlayer();
    payload.replayAvailable = true;
    expect(auditPlayerPayload(payload).join()).toMatch(/replayAvailable/);
  });

  it('catches a missing self record (R-38)', () => {
    const payload = cleanPlayer();
    delete payload.self;
    expect(auditPlayerPayload(payload).join()).toMatch(/no self record/);
  });

  it('catches a session token anywhere in the payload', () => {
    const payload = cleanPlayer();
    payload.players[0].sessionToken = 'leaked';
    expect(auditPlayerPayload(payload).join()).toMatch(/session token/);
  });
});

describe('auditMasterPayload', () => {
  // Loosely typed on purpose: the auditor's job is to catch fields that should
  // not be there, so the fixtures have to be able to carry them.
  const cleanMaster = (): Record<string, any> => ({
    viewMode: 'OPERATIONAL',
    tray: [],
    players: [
      { id: 'alfa', callsign: 'ALFA', position: { source: 'LAST_KNOWN', state: 'NO_LINK' } },
    ],
    replayAvailable: false,
  });

  it('passes a clean OPERATIONAL payload', () => {
    expect(auditMasterPayload(cleanMaster())).toEqual([]);
  });

  it('catches elimination leaking into OPERATIONAL (R-22)', () => {
    const payload = cleanMaster();
    payload.players[0].eliminated = { ts: 1, dropPoint: { lat: 1, lon: 2 }, selfDeclared: true };
    expect(auditMasterPayload(payload).join()).toMatch(/elimination visible in OPERATIONAL/);
  });

  it('catches a live position for a stopped feed in OPERATIONAL (R-22)', () => {
    const payload = cleanMaster();
    payload.players[0].position = { source: 'LIVE', state: 'NO_LINK' };
    expect(auditMasterPayload(payload).join()).toMatch(/live position for a stopped feed/);
  });

  it('catches replay in OPERATIONAL (R-26)', () => {
    const payload = cleanMaster();
    payload.replayAvailable = true;
    expect(auditMasterPayload(payload).join()).toMatch(/replay available in OPERATIONAL/);
  });

  it('accepts everything in AUTHORITATIVE', () => {
    const payload = cleanMaster();
    payload.viewMode = 'AUTHORITATIVE';
    // R-25's deadline travels with the mode: an AUTHORITATIVE payload without one
    // is itself a violation, checked below.
    payload.authoritativeExpiresAt = 1_760_000_600_000;
    payload.replayAvailable = true;
    payload.players[0].eliminated = { ts: 1, dropPoint: { lat: 1, lon: 2 }, selfDeclared: true };
    expect(auditMasterPayload(payload)).toEqual([]);
  });

  /**
   * Both directions, because both are silent failures on a screen. Without the
   * deadline the master cannot see the revert coming and the client cannot derive
   * it; with one in OPERATIONAL the panel counts down to nothing.
   */
  it('catches AUTHORITATIVE with no deadline (R-25)', () => {
    const payload = cleanMaster();
    payload.viewMode = 'AUTHORITATIVE';
    expect(auditMasterPayload(payload).join()).toMatch(/AUTHORITATIVE with no deadline/);
  });

  it('catches an elimination in the OPERATIONAL log (R-30.2)', () => {
    const payload = cleanMaster();
    payload.events = [{ ts: 1, kind: 'ELIMINATION', target: 'alfa', visibility: 'MASTER' }];
    expect(auditMasterPayload(payload).join()).toMatch(/ELIMINATION in the OPERATIONAL event log/);
  });

  it('catches a deadline that outlived the mode (R-25)', () => {
    const payload = cleanMaster();
    payload.authoritativeExpiresAt = 1_760_000_600_000;
    expect(auditMasterPayload(payload).join()).toMatch(/deadline in OPERATIONAL/);
  });
});

describe('parseArgs', () => {
  it('reads role and cookie', () => {
    const options = parseArgs(['--role', 'master', '--cookie', 'q4413_session=x']);
    expect(options.role).toBe('master');
    expect(options.cookie).toBe('q4413_session=x');
  });

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['--nope', '1'])).toThrow(/unknown option/);
  });
});

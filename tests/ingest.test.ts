import { describe, expect, it } from 'vitest';

import { parseOsmAndPing, type ParseResult } from '@q4413/core';
import type { OsmAndPing, OsmAndStatus } from '@q4413/shared';

const RECEIVED_AT = 1_756_000_000_000;

const pairs = (query: string): Array<[string, string]> => [...new URLSearchParams(query)];

/** Narrows to a position, and fails loudly rather than silently passing. */
const positionOf = (result: ParseResult): OsmAndPing => {
  if (!result.ok || result.kind !== 'POSITION') {
    throw new Error(`expected a position, got ${JSON.stringify(result)}`);
  }
  return result.ping;
};

const statusOf = (result: ParseResult): OsmAndStatus => {
  if (!result.ok || result.kind !== 'STATUS') {
    throw new Error(`expected a status report, got ${JSON.stringify(result)}`);
  }
  return result.status;
};

describe('parseOsmAndPing — OsmAnd protocol (R-01, R-03)', () => {
  it('decodes the documented field set', () => {
    const result = parseOsmAndPing(
      pairs(
        'id=abc123&lat=40.4200&lon=-3.7000&timestamp=1756000000&accuracy=12.5' +
          '&bearing=271.4&speed=1.2&batt=87&is_moving=true&activity=walking&event=motionchange',
      ),
      RECEIVED_AT,
    );

    expect(result.ok).toBe(true);
    expect(positionOf(result)).toMatchObject({
      deviceId: 'abc123',
      lat: 40.42,
      lon: -3.7,
      accuracy: 12.5,
      bearing: 271.4,
      speed: 1.2,
      battery: 87,
      isMoving: true,
      activity: 'walking',
      event: 'motionchange',
      receivedAt: RECEIVED_AT,
    });
  });

  it('accepts the same parameters from a POST body, since both must work (R-01)', () => {
    const fromQuery = parseOsmAndPing(pairs('id=dev&lat=1&lon=2'), RECEIVED_AT);
    const fromBody = parseOsmAndPing(
      [...new URLSearchParams('id=dev&lat=1&lon=2')],
      RECEIVED_AT,
    );
    expect(fromQuery).toEqual(fromBody);
  });

  it('lets the body override a stale query copy of the same parameter', () => {
    // The Worker merges query pairs first, then body pairs.
    const result = parseOsmAndPing(
      [
        ['id', 'dev'],
        ['lat', '1'],
        ['lon', '2'],
        ['lat', '10'],
      ],
      RECEIVED_AT,
    );
    expect(positionOf(result).lat).toBe(10);
  });

  it('keeps unrecognised parameters in the attribute map (R-03)', () => {
    const result = parseOsmAndPing(
      pairs('id=dev&lat=1&lon=2&altitude=655&hdop=0.8&charge=true&whatever=x'),
      RECEIVED_AT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(positionOf(result).attributes).toEqual({
      altitude: '655',
      hdop: '0.8',
      charge: 'true',
      whatever: 'x',
    });
  });

  it('reads the fix time as Unix seconds', () => {
    const result = parseOsmAndPing(pairs('id=dev&lat=1&lon=2&timestamp=1756000000'), RECEIVED_AT);
    expect(positionOf(result).ts).toBe(1_756_000_000_000);
  });

  it('recognises a millisecond fix time instead of landing in the year 57000', () => {
    const result = parseOsmAndPing(
      pairs('id=dev&lat=1&lon=2&timestamp=1756000000000'),
      RECEIVED_AT,
    );
    expect(positionOf(result).ts).toBe(1_756_000_000_000);
  });

  it('recognises an ISO 8601 fix time', () => {
    const result = parseOsmAndPing(
      pairs('id=dev&lat=1&lon=2&timestamp=2025-08-24T02:26:40.000Z'),
      RECEIVED_AT,
    );
    expect(positionOf(result).ts).toBe(Date.parse('2025-08-24T02:26:40.000Z'));
  });

  it('falls back to the receive time when no fix time is sent (R-03, R-36)', () => {
    const result = parseOsmAndPing(pairs('id=dev&lat=1&lon=2'), RECEIVED_AT);
    expect(positionOf(result).ts).toBe(RECEIVED_AT);
  });

  it('falls back to the receive time when the fix time is unparseable', () => {
    const result = parseOsmAndPing(pairs('id=dev&lat=1&lon=2&timestamp=soon'), RECEIVED_AT);
    expect(positionOf(result).ts).toBe(RECEIVED_AT);
  });

  /* ---------------------------------------------------------------- */

  describe('a body with no coordinates is a status report, not a malformed ping', () => {
    // Traccar Client posts one every time its location service starts, before it
    // has a fix. Treating it as malformed threw away the battery and wrote an
    // INGEST_REJECTED event for routine behaviour.

    it('reads the shape a starting service actually sends', () => {
      const result = parseOsmAndPing(
        pairs('id=movil-pixel9&timestamp=1756000000&batt=91&charge=false'),
        RECEIVED_AT,
      );

      expect(statusOf(result)).toEqual({
        deviceId: 'movil-pixel9',
        receivedAt: RECEIVED_AT,
        battery: 91,
        attributes: { charge: 'false' },
      });
    });

    /**
     * The shape captured from a real phone on 2026-09-01, which is not the one
     * this branch first assumed. It carries a push-token registration and no
     * battery, no coordinates and no fix time — so `attributes` holds a
     * per-device credential, and nothing may go on to store it.
     */
    it('decodes the push-token registration a real service start sent', () => {
      const result = parseOsmAndPing(
        pairs(
          'id=movil-pixel9&notificationToken=' +
            'NOT-A-REAL-TOKEN%3AAPA91bEXAMPLE_placeholder_for_tests_only',
        ),
        RECEIVED_AT,
      );

      expect(statusOf(result)).toEqual({
        deviceId: 'movil-pixel9',
        receivedAt: RECEIVED_AT,
        attributes: {
          notificationToken: 'NOT-A-REAL-TOKEN:APA91bEXAMPLE_placeholder_for_tests_only',
        },
      });
      // No battery key at all, rather than one set to undefined: a body that
      // carries none must not blank a reading taken a moment ago.
      expect(statusOf(result)).not.toHaveProperty('battery');
    });

    it('treats an empty coordinate the same as an absent one', () => {
      expect(statusOf(parseOsmAndPing(pairs('id=dev&lat=&lon='), RECEIVED_AT)).deviceId).toBe('dev');
    });

    it('carries no position of any kind, so nothing downstream can mistake it for one', () => {
      const status = statusOf(parseOsmAndPing(pairs('id=dev&batt=50'), RECEIVED_AT));
      expect(status).not.toHaveProperty('lat');
      expect(status).not.toHaveProperty('lon');
      expect(status).not.toHaveProperty('ts');
    });

    it('omits the battery rather than inventing one when the body carries none', () => {
      expect(statusOf(parseOsmAndPing(pairs('id=dev'), RECEIVED_AT)).battery).toBeUndefined();
    });

    it('still rejects a body with no id at all', () => {
      const result = parseOsmAndPing(pairs('batt=91'), RECEIVED_AT);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.rejection).toEqual({ reason: 'MISSING_FIELD', field: 'id' });
    });

    it.each([
      ['lat', 'id=dev&lon=2'],
      ['lon', 'id=dev&lat=1'],
    ])(
      'is not a status report when only %s is missing — half a coordinate is broken, not starting up',
      (field, query) => {
        const result = parseOsmAndPing(pairs(query), RECEIVED_AT);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.rejection).toEqual({ reason: 'MISSING_FIELD', field });
      },
    );

    it('validates batt on a status report exactly as it would on a position', () => {
      const result = parseOsmAndPing(pairs('id=dev&batt=full'), RECEIVED_AT);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.rejection).toEqual({ reason: 'BAD_NUMBER', field: 'batt', value: 'full' });
    });
  });

  /* ---------------------------------------------------------------- */

  it.each(['id', 'lat', 'lon'])('rejects a ping with no %s', (field) => {
    const all = new URLSearchParams('id=dev&lat=1&lon=2');
    all.delete(field);
    const result = parseOsmAndPing([...all], RECEIVED_AT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toEqual({ reason: 'MISSING_FIELD', field });
  });

  it('rejects a non-numeric coordinate rather than storing NaN', () => {
    const result = parseOsmAndPing(pairs('id=dev&lat=north&lon=2'), RECEIVED_AT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toEqual({ reason: 'BAD_NUMBER', field: 'lat', value: 'north' });
  });

  it.each([
    ['lat', '91'],
    ['lat', '-91'],
    ['lon', '181'],
    ['lon', '-181'],
  ])('rejects %s out of range: %s', (field, value) => {
    const all = new URLSearchParams('id=dev&lat=1&lon=2');
    all.set(field, value);
    const result = parseOsmAndPing([...all], RECEIVED_AT);
    expect(result.ok).toBe(false);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('decodes is_moving=%s', (raw, expected) => {
    const result = parseOsmAndPing(pairs(`id=dev&lat=1&lon=2&is_moving=${raw}`), RECEIVED_AT);
    expect(positionOf(result).isMoving).toBe(expected);
  });

  it('leaves is_moving absent rather than guessing when it cannot be read', () => {
    const result = parseOsmAndPing(pairs('id=dev&lat=1&lon=2&is_moving=maybe'), RECEIVED_AT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(positionOf(result).isMoving).toBeUndefined();
    // MOVING is the default when evidence is absent (R-10), so a misread value
    // must not be silently turned into `false`.
  });
});

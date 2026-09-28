import type { OsmAndPing, OsmAndStatus, TrayEntry } from '@q4413/shared';

/**
 * Unpaired device tray (R-06).
 *
 * A ping with an unknown id is **not discarded**: it creates or updates a tray
 * entry the master pairs from (R-07). Discarding it would make pairing
 * impossible, since a device only becomes known by pinging first.
 */
export function upsertTrayEntry(existing: TrayEntry | undefined, ping: OsmAndPing): TrayEntry {
  // Battery and accuracy are kept per ping rather than only once a device has an
  // owner: they are how a master tells one anonymous phone from another, and
  // dropping them until pairing meant the tray showed six identical rows.
  const observed = {
    lastSeen: ping.receivedAt,
    lat: ping.lat,
    lon: ping.lon,
    ...(ping.battery === undefined ? {} : { battery: ping.battery }),
    ...(ping.accuracy === undefined ? {} : { accuracy: ping.accuracy }),
  };

  if (!existing) {
    return { deviceId: ping.deviceId, firstSeen: ping.receivedAt, pings: 1, ...observed };
  }

  // A ping that omits battery leaves the last reading standing, rather than
  // blanking a column that was populated a second ago.
  return { ...existing, ...observed, pings: existing.pings + 1 };
}

/**
 * A status report on a device still in the tray. Battery only.
 *
 * **`lastSeen` deliberately does not move**, which reads backwards against the
 * field's name and is what its two consumers require. Both treat it as the
 * timestamp *of the position*, not of the last contact:
 * `dotsOf()` feeds it to `derivePositionState({ ts: entry.lastSeen, ... })` to
 * decide whether the stray dot is live, and pairing copies it into
 * `knownPosition.ts`. Advancing it on a report that brings no coordinates would
 * make a stale dot render fresh, and would hand a paired player a `knownPosition`
 * timestamped now over a position from minutes ago.
 *
 * The cost is that a phone which is powered on but has never had a fix stays
 * invisible to the master. Making that visible needs a field separate from the
 * position's timestamp rather than a looser rule here — `pings` is untouched for
 * the same reason, since it counts positions.
 *
 * Returns the same object when there is no battery to record.
 */
export function applyStatusToTrayEntry(existing: TrayEntry, status: OsmAndStatus): TrayEntry {
  if (status.battery === undefined) return existing;
  return { ...existing, battery: status.battery };
}

#!/usr/bin/env node
/**
 * Audits what a live socket actually receives (§4, M2's exit criterion).
 *
 * The criterion is "a devtools inspection of a live player socket confirms it
 * receives nothing forbidden". This is that inspection, written down so it can
 * be repeated after every change instead of remembered.
 *
 * It connects with a real session cookie, waits for the snapshot, and checks the
 * payload against what the recipient's column of §4 allows. Exits non-zero on
 * any violation.
 *
 *   node tools/socket-audit.mjs --role player --cookie "q4413_session=..."
 *   node tools/socket-audit.mjs --url http://127.0.0.1:8799 --role master --cookie "..."
 *
 * Getting a cookie: log in or redeem an invite with curl -c, then read the jar.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULTS = { url: 'http://127.0.0.1:8787', role: 'player', cookie: '', timeout: 5 };

const HELP = `
Audit a live socket against the §4 matrix.

  --url <base>       Worker origin (default ${DEFAULTS.url})
  --role player|master
  --cookie <header>  full cookie header, e.g. "q4413_session=..."
  --timeout <s>      how long to wait for the snapshot (default ${DEFAULTS.timeout})
`;

/** Fields no player socket may ever carry, and where they would show up. */
const FORBIDDEN_FOR_PLAYER = [
  { path: 'tray', why: 'the unpaired device tray is a master control (R-06, R-59)' },
  { path: 'events', why: 'the event log is master-only (§3 visibility)' },
  { path: 'viewMode', why: 'view mode is a master concept (R-22)' },
  { path: 'authoritativeExpiresAt', why: "a master's idle clock is not a player's business (R-25)" },
];

export function parseArgs(argv, defaults = DEFAULTS) {
  const options = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { ...options, help: true };
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!(key in defaults)) throw new Error(`unknown option: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    i += 1;
    options[key] = typeof defaults[key] === 'number' ? Number(value) : value;
  }
  return options;
}

/**
 * The checks themselves, pure so they can be unit tested against a payload
 * without a Worker. Returns a list of violations; empty means clean.
 */
export function auditPlayerPayload(payload) {
  const violations = [];
  const raw = JSON.stringify(payload);

  for (const { path, why } of FORBIDDEN_FOR_PLAYER) {
    if (payload[path] !== undefined) violations.push(`${path} present — ${why}`);
  }

  if (payload.replayAvailable !== false) {
    violations.push('replayAvailable is not false — replay is master AUTHORITATIVE only (R-26)');
  }

  if (!payload.self) violations.push('no self record: a player must see their own position (R-38)');

  for (const other of payload.players ?? []) {
    if (other.fullName !== undefined) {
      violations.push(`${other.callsign}: fullName present — never on a player socket (R-27)`);
    }
    if (other.deviceId !== undefined) {
      violations.push(`${other.callsign}: deviceId present — pairing is a master control`);
    }
    if (other.eliminated !== undefined) {
      violations.push(`${other.callsign}: elimination state present — never told to players (R-30.2)`);
    }
    if (other.outOfZone) {
      // Callsign only. No position, no distance, no last known position, no
      // ghost marker (R-40), and no ordering derived from position (R-42).
      if (other.position !== undefined) violations.push(`${other.callsign}: out of zone with a position (R-40)`);
      if (other.distanceMetres !== undefined) violations.push(`${other.callsign}: out of zone with a distance (R-42)`);
      if (other.battery !== undefined) violations.push(`${other.callsign}: out of zone with a battery reading`);
    }
  }

  const sameZone = (payload.players ?? []).filter((p) => !p.outOfZone);
  const distances = sameZone.map((p) => p.distanceMetres ?? Infinity);
  if (distances.some((value, index) => index > 0 && value < distances[index - 1])) {
    violations.push('same-zone players are not ordered by proximity (R-42)');
  }
  const firstOutOfZone = (payload.players ?? []).findIndex((p) => p.outOfZone);
  if (firstOutOfZone >= 0 && (payload.players ?? []).slice(firstOutOfZone).some((p) => !p.outOfZone)) {
    violations.push('the out-of-zone group is not last in the list (R-40)');
  }

  // R-20b: at most five, and audience filtering already happened server-side —
  // what is checkable from here is that the cap was not exceeded on the wire.
  if (!Array.isArray(payload.markers)) {
    violations.push('markers is not an array — the single-slot shape is gone (R-20b)');
  } else if (payload.markers.length > 5) {
    violations.push(`${payload.markers.length} markers reached the socket, cap is 5 (R-20b)`);
  }

  if (raw.includes('sessionToken')) violations.push('a session token reached the socket');
  if (raw.includes('ingestSecret')) violations.push('the ingest secret reached the socket');

  return violations;
}

export function auditMasterPayload(payload) {
  const violations = [];
  if (payload.viewMode === undefined) violations.push('no viewMode: a master session always has one');
  if (payload.tray === undefined) violations.push('no tray: the pairing tray is a master control');
  // R-25's deadline travels with the mode, both directions. Without it the master
  // has no way to know the revert is coming; with it in OPERATIONAL it is a clock
  // counting down to nothing.
  if (payload.viewMode === 'AUTHORITATIVE' && payload.authoritativeExpiresAt === undefined) {
    violations.push('AUTHORITATIVE with no deadline: R-25 cannot be observed or derived');
  }
  if (payload.viewMode === 'OPERATIONAL') {
    if (payload.authoritativeExpiresAt !== undefined) {
      violations.push('an AUTHORITATIVE deadline in OPERATIONAL (R-25)');
    }
    for (const other of payload.players ?? []) {
      if (other.eliminated !== undefined) {
        violations.push(`${other.callsign}: elimination visible in OPERATIONAL (R-22)`);
      }
      if (other.position?.source === 'LIVE' && other.position.state === 'NO_LINK') {
        violations.push(`${other.callsign}: live position for a stopped feed in OPERATIONAL (R-22)`);
      }
    }
    if (payload.replayAvailable !== false) {
      violations.push('replay available in OPERATIONAL (R-26)');
    }
    // R-30.2's other half. The field is withheld above; an ELIMINATION line in
    // the log would announce the same thing in a different column, and the log is
    // the place it would be easiest to leak by forgetting a visibility.
    for (const event of payload.events ?? []) {
      if (event.kind === 'ELIMINATION' || event.kind === 'ELIMINATION_REVERSED') {
        violations.push(`${event.kind} in the OPERATIONAL event log (R-22, R-30.2)`);
      }
    }
  }
  if (JSON.stringify(payload).includes('sessionToken')) {
    violations.push('a session token reached the socket');
  }
  return violations;
}

async function firstSnapshot(url, cookie, timeoutSeconds) {
  const wsUrl = `${url.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws`;
  const socket = new WebSocket(wsUrl, { headers: { cookie } });
  try {
    return await new Promise((resolve, reject) => {
      socket.addEventListener('message', (event) => {
        try {
          resolve(JSON.parse(event.data));
        } catch (error) {
          reject(error);
        }
      });
      socket.addEventListener('error', () => reject(new Error(`cannot open ${wsUrl}`)));
      socket.addEventListener('close', (event) =>
        reject(new Error(`socket closed before any snapshot (${event.code})`)),
      );
      setTimeout(() => reject(new Error(`no snapshot in ${timeoutSeconds}s`)), timeoutSeconds * 1000);
    });
  } finally {
    socket.close();
  }
}

function describe(payload) {
  const lines = [`  keys: ${Object.keys(payload).sort().join(' ')}`];
  if (payload.self) {
    lines.push(
      `  self: ${payload.self.callsign} zone=${payload.self.position?.zoneId ?? '-'}`,
    );
  }
  for (const other of payload.players ?? []) {
    lines.push(
      `  ${String(other.callsign).padEnd(8)} ${other.outOfZone ? 'out of zone  ' : 'same zone    '}` +
        ` dist=${other.distanceMetres ?? '-'}` +
        ` pos=${other.position ? `${other.position.lat},${other.position.lon}/${other.position.source}` : '-'}` +
        ` batt=${other.battery ?? '-'} name=${other.fullName ?? '-'}`,
    );
  }
  return lines.join('\n');
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(String(error.message ?? error), HELP);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (!options.cookie) {
    console.error('missing --cookie: the audit needs a real session', HELP);
    process.exitCode = 2;
    return;
  }

  const message = await firstSnapshot(options.url, options.cookie, options.timeout);
  if (message.t !== 'snapshot') {
    console.error(`expected a snapshot, got ${message.t}`);
    process.exitCode = 1;
    return;
  }

  console.log(`${options.role} socket:`);
  console.log(describe(message.payload));

  const violations =
    options.role === 'master'
      ? auditMasterPayload(message.payload)
      : auditPlayerPayload(message.payload);

  if (violations.length === 0) {
    console.log(`\nclean: nothing forbidden for a ${options.role} recipient`);
    return;
  }
  console.error(`\n${violations.length} violation(s):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(fileURLToPath(pathToFileURL(process.argv[1]).href)).href;

if (invokedDirectly) {
  await main(process.argv.slice(2));
}

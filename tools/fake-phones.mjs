#!/usr/bin/env node
/**
 * Synthetic Traccar Client emitters (R-01, R-03).
 *
 * Posts OsmAnd pings the way the real app does, for as many devices as you ask
 * for, walking inside the perimeter from packages/shared/geo/pruebas.geojson by default — the
 * profile a fresh game seeds with, so its pings are accepted IN_PROGRESS. Pass
 * --geo for the real venue. It
 * exists so ingest, position state and replay can be developed without six
 * phones and a field trip.
 *
 * Deliberately dependency-free and plain .mjs: it has to run against a deployed
 * environment with nothing but `node`, so it carries its own point-in-polygon
 * instead of importing @q4413/core. tests/fake-phones.test.ts cross-checks that
 * copy against turf, which is the price of the duplication.
 *
 * It is a test tool. No game rule may ever be defined here.
 *
 *   node tools/fake-phones.mjs --secret dev-secret --url http://127.0.0.1:8787
 *   node tools/fake-phones.mjs --help
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULTS = {
  url: 'http://127.0.0.1:8787',
  secret: process.env.INGEST_SECRET ?? '',
  devices: 6,
  ids: '',
  interval: 10,
  jitter: 0.15,
  speed: 1.4, // walkingSpeed from Game.config
  scenario: 'mixed',
  duration: 0,
  seed: 4413,
  geo: 'packages/shared/geo/pruebas.geojson',
  zones: '',
  method: 'post',
  once: false,
  activity: true,
  quiet: false,
  outside: true,
};

const HELP = `
Synthetic Traccar Client emitters.

  --url <base>        Worker origin (default ${DEFAULTS.url})
  --secret <s>        ingest path secret; or set INGEST_SECRET
  --devices <n>       how many devices (default ${DEFAULTS.devices})
  --ids a,b,c         explicit device ids, overrides --devices
  --interval <s>      seconds between pings per device (default ${DEFAULTS.interval})
  --jitter <0..1>     timing jitter (default ${DEFAULTS.jitter})
  --speed <m/s>       walking speed (default ${DEFAULTS.speed})
  --scenario <name>   walk | stationary | nolink | outside | mixed (default ${DEFAULTS.scenario})
  --duration <s>      stop after this long (default: run until Ctrl-C)
  --seed <n>          deterministic run (default ${DEFAULTS.seed})
  --geo <path>        geometry file (default ${DEFAULTS.geo})
  --zones a,b,c       put device N inside zone N and keep it there, instead of
                      anywhere in the perimeter. Positional against --ids, and
                      an empty entry leaves that device on the perimeter. This
                      is how §4 is exercised: the zone decides who sees whom,
                      and two devices dropped at random are almost never in the
                      same one
  --method get|post   how to send parameters (default ${DEFAULTS.method}, like Traccar Client)
  --once              one ping per device, then exit
  --no-activity       omit the activity parameter, like a device without Play services
  --no-outside        in mixed, walk the device that would have gone outside the
                      ingest area. What it exercises is R-04, which applies only
                      IN_PROGRESS; in PREPARATION the ping is accepted on
                      purpose, so all it produces there is a dot off the map
  --quiet             only errors and the summary

Scenarios
  walk        every device moves at walking speed inside the perimeter
  stationary  motionchange with is_moving=false, then heartbeats from a fixed point
  nolink      three pings, then silence — crosses to NO_LINK after linkThresholdMs
  outside     pings from outside the ingest area; rejected only while IN_PROGRESS (R-04)
  mixed       walkers, plus one stationary, one going silent and one outside

Notes
  Zone ids come from the geometry file, e.g. zone-norte-este for madrid.
  Unknown device ids land in the unpaired tray (R-06); pair them from the panel.
  Unrecognised parameters (altitude, hdop) are sent on purpose to exercise R-03.
`;

/* ------------------------------------------------------------------ */
/* Pure helpers, in their own file so the browser demo walks with them  */
/* ------------------------------------------------------------------ */

/**
 * Re-exported rather than moved out of sight: every caller of this tool, and
 * `tests/fake-phones.test.ts`, keeps importing them from here. See
 * [tools/walk.mjs](walk.mjs) for why they are in a file of their own.
 */
export {
  bboxOf,
  metresPerDegree,
  mulberry32,
  pointInRing,
  pointOutsideRing,
  randomPointInRing,
  ringOf,
  walkStep,
  zoneRing,
} from './walk.mjs';

import {
  bboxOf,
  metresPerDegree,
  mulberry32,
  pointInRing,
  pointOutsideRing,
  randomPointInRing,
  ringOf,
  walkStep,
  zoneRing,
} from './walk.mjs';

export function parseArgs(argv, defaults = DEFAULTS) {
  const options = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { ...options, help: true };
    if (arg === '--once') { options.once = true; continue; }
    if (arg === '--quiet') { options.quiet = true; continue; }
    if (arg === '--no-activity') { options.activity = false; continue; }
    if (arg === '--no-outside') { options.outside = false; continue; }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!(key in defaults)) throw new Error(`unknown option: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    i += 1;
    options[key] = typeof defaults[key] === 'number' ? Number(value) : value;
    if (typeof defaults[key] === 'number' && !Number.isFinite(options[key])) {
      throw new Error(`${arg} needs a number, got ${value}`);
    }
  }
  return options;
}

/**
 * Roles per device. `mixed` is the interesting case for position states and
 * view modes.
 *
 * @param outside whether the last device goes outside the ingest area. It is
 *        what R-04's rejection is exercised with, and R-04 only applies
 *        `IN_PROGRESS` — in `PREPARATION` the ping is accepted on purpose, so
 *        all the role produces there is a dot tens of kilometres off the map.
 */
export function rolesFor(scenario, ids, outside = true) {
  if (scenario !== 'mixed') return ids.map(() => scenario);
  return ids.map((_, index) => {
    if (index === ids.length - 1 && ids.length >= 4) return outside ? 'outside' : 'walk';
    if (index === ids.length - 2 && ids.length >= 3) return 'nolink';
    if (index === ids.length - 3 && ids.length >= 3) return 'stationary';
    return 'walk';
  });
}

/* ------------------------------------------------------------------ */
/* Emitter                                                            */
/* ------------------------------------------------------------------ */

function ingestUrl(base, secret) {
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/i/${secret}/`;
}

function pingParams(device, options) {
  const params = new URLSearchParams({
    id: device.id,
    lat: device.lat.toFixed(6),
    lon: device.lon.toFixed(6),
    timestamp: String(Math.floor(Date.now() / 1000)),
    accuracy: device.accuracy.toFixed(1),
    batt: String(Math.round(device.battery)),
    // Unrecognised on purpose: R-03 keeps them in the attribute map.
    altitude: device.altitude.toFixed(0),
    hdop: (0.6 + device.random() * 0.8).toFixed(1),
  });

  if (device.role === 'stationary') {
    params.set('is_moving', 'false');
    params.set('event', device.pings === 0 ? 'motionchange' : 'heartbeat');
    if (options.activity) params.set('activity', 'still');
  } else {
    params.set('is_moving', 'true');
    params.set('bearing', device.heading.toFixed(1));
    params.set('speed', device.speed.toFixed(2));
    if (options.activity) params.set('activity', 'walking');
  }

  return params;
}

async function send(device, options, endpoint) {
  const params = pingParams(device, options);
  const request =
    options.method === 'get'
      ? fetch(`${endpoint}?${params}`)
      : // Traccar Client posts with the parameters in the query string and an
        // empty body on some builds, form-encoded on others. R-01 requires both;
        // this sends the form-encoded shape.
        fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });

  const response = await request;
  return { status: response.status, ok: response.ok };
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(String(error.message ?? error));
    console.error(HELP);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(HELP);
    return;
  }
  if (!options.secret) {
    console.error('missing --secret (or INGEST_SECRET). It is the ingest path secret, R-02.');
    process.exitCode = 2;
    return;
  }

  const geojson = JSON.parse(readFileSync(options.geo, 'utf8'));
  const perimeter = ringOf(geojson, 'PERIMETER');
  const ingestArea = ringOf(geojson, 'INGEST_AREA');
  const endpoint = ingestUrl(options.url, options.secret);

  const ids = options.ids
    ? options.ids.split(',').map((id) => id.trim()).filter(Boolean)
    : Array.from({ length: options.devices }, (_, index) => `fake-${index + 1}`);
  const roles = rolesFor(options.scenario, ids, options.outside);
  // Positional against --ids, and short on purpose: naming the two devices a
  // visibility check is about should not mean naming the other four.
  const zoneIds = options.zones.split(',').map((entry) => entry.trim());

  const devices = ids.map((id, index) => {
    const random = mulberry32(options.seed + index * 7919);
    const role = roles[index];
    // The ring this device lives in, which is also the ring it walks inside:
    // a device placed in a zone that then wandered out of it would answer a
    // visibility question with whichever zone it happened to be in by the time
    // anybody looked.
    const zoneId = zoneIds[index] || undefined;
    const ring = zoneId ? zoneRing(geojson, zoneId) : perimeter;
    const start =
      role === 'outside' ? pointOutsideRing(ingestArea) : randomPointInRing(ring, random);
    return {
      id,
      role,
      zoneId,
      ring,
      random,
      lon: start[0],
      lat: start[1],
      heading: random() * 360,
      speed: options.speed * (0.8 + random() * 0.4),
      accuracy: 4 + random() * 8,
      battery: 70 + random() * 30,
      altitude: 20 + random() * 80,
      pings: 0,
      sent: 0,
      rejected: 0,
      failed: 0,
      timer: undefined,
    };
  });

  const counters = { sent: 0, failed: 0 };
  const log = (...args) => {
    if (!options.quiet) console.log(...args);
  };

  log(`endpoint ${endpoint}`);
  log(`geometry ${options.geo}`);
  log(
    `${devices.length} device(s), seed ${options.seed}, every ${options.interval}s: ` +
      devices.map((d) => `${d.id}=${d.role}${d.zoneId ? `@${d.zoneId}` : ''}`).join(' '),
  );

  const tick = async (device) => {
    // NO_LINK is silence, not a message: after three pings this device simply
    // stops, and the client derives the state from lastPingTs (R-11, R-15).
    if (device.role === 'nolink' && device.pings >= 3) {
      if (device.pings === 3) {
        log(`${device.id} going silent — NO_LINK expected after linkThresholdMs`);
        device.pings += 1;
      }
      return;
    }

    if (device.role === 'walk') {
      const metres = device.speed * options.interval;
      const next = walkStep(device, { ring: device.ring, metres, random: device.random });
      device.lon = next.lon;
      device.lat = next.lat;
      device.heading = next.heading;
    }

    device.accuracy = Math.max(3, device.accuracy + (device.random() - 0.5) * 3);
    device.battery = Math.max(1, device.battery - options.interval / 120);

    try {
      const { status, ok } = await send(device, options, endpoint);
      device.pings += 1;
      device.sent += 1;
      counters.sent += 1;
      log(
        `${device.id.padEnd(10)} ${device.role.padEnd(10)} ` +
          `${device.lat.toFixed(6)},${device.lon.toFixed(6)} ` +
          `±${device.accuracy.toFixed(0)}m ${Math.round(device.battery)}% → ${status}`,
      );
      if (!ok) device.rejected += 1;
    } catch (error) {
      device.failed += 1;
      counters.failed += 1;
      console.error(`${device.id} failed: ${String(error.message ?? error)}`);
    }
  };

  const summary = () => {
    const lines = devices.map(
      (d) => `  ${d.id.padEnd(10)} ${d.role.padEnd(10)} sent ${d.sent} failed ${d.failed}`,
    );
    console.log(
      `\n${counters.sent} ping(s) sent, ${counters.failed} failed\n${lines.join('\n')}`,
    );
  };

  if (options.once) {
    await Promise.all(devices.map(tick));
    summary();
    return;
  }

  for (const device of devices) {
    void tick(device);
    const jitter = 1 + (device.random() - 0.5) * 2 * options.jitter;
    device.timer = setInterval(() => void tick(device), options.interval * 1000 * jitter);
  }

  const stop = () => {
    for (const device of devices) clearInterval(device.timer);
    summary();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (options.duration > 0) setTimeout(stop, options.duration * 1000);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(fileURLToPath(pathToFileURL(process.argv[1]).href)).href;

if (invokedDirectly) {
  await main(process.argv.slice(2));
}

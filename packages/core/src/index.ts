/**
 * Runtime-agnostic game logic (§6.5).
 *
 * Nothing in this package may import a Cloudflare or DOM API. That is what lets
 * the platform change in a day rather than a rewrite — the ranked fallback is a
 * Hetzner CX22 running Node + Socket.IO + SQLite + Caddy.
 *
 * §7 places ingest.ts, projection.ts and friends under workers/src, while §6.5
 * and the README require all game logic to live here. Read together: the pure
 * decisions live in this package and workers/src holds the HTTP, storage and
 * socket adapters that call them. project() (§4) lands here in M2.
 */

export { parseOsmAndPing, type ParseResult } from './ingest.ts';
export {
  noteRejection,
  REJECTION_LOG_WINDOW_MS,
  REJECTION_MAX_KEYS,
  type RejectionRecord,
  type RejectionState,
} from './rejections.ts';
export {
  checkPingAccepted,
  cutSwitchOnStateChange,
  geofenceApplies,
  ingestOpen,
  playerFeedOpen,
  insideIngestArea,
} from './gating.ts';
export { applyStatusToTrayEntry, upsertTrayEntry } from './devices.ts';
export {
  accountabilityOf,
  derivePositionState,
  distanceMetres,
  feedStopped,
  positionAgeMs,
  radioContactFresh,
  stateFromPing,
  stationaryEvidence,
  stationarySinceFor,
  uncertaintyRadiusMetres,
  type Accountability,
} from './position-state.ts';
export {
  commsReachOf,
  masterRecipient,
  project,
  type Recipient,
  type World,
} from './projection.ts';
export {
  authoritativeExpiresAt,
  authoritativeLapsed,
  effectiveViewMode,
  idleRevertApplies,
  isMasterAction,
  replayAllowed,
  viewModeInForce,
  type ViewModeClock,
  type ViewModeSession,
} from './view-mode.ts';
export {
  declareEliminated,
  eliminationOpen,
  reviveEliminated,
  ELIMINATION_STATES,
} from './elimination.ts';
export { constantTimeEquals } from './secret.ts';
export {
  checkLoginAllowed,
  clearLoginFailures,
  recordLoginFailure,
  MASTER_LOGIN_THROTTLE,
  type AttemptRecord,
  type ThrottleConfig,
  type ThrottleDecision,
} from './throttle.ts';
export {
  base64UrlDecodeAscii,
  base64UrlEncodeAscii,
  isUrlSafeId,
  playerForToken,
  signSession,
  verifySession,
  type SessionEpochs,
  type SessionPayload,
  type Signer,
} from './session.ts';
export {
  basemapBbox,
  gameGeoFromGeoJson,
  sectorsOf,
  poisOf,
  zonesOf,
  BASEMAP_FRAME_FACTOR,
  GameGeoError,
} from './geo.ts';
export { playAreaOf } from './play-area.ts';
export { geoJsonFromPayload } from './geojson.ts';
export {
  activeMarkers,
  markerExpired,
  nextMarkerExpiry,
  placeMarker,
  MARKER_LABEL_MAX,
  MARKER_MAX,
  MARKER_TTL_MAX_MS,
  MARKER_TTL_MIN_MS,
  type MarkerError,
  type MarkerInput,
  type MarkerResult,
} from './marker.ts';
export { applyPing, applyStatus } from './positions.ts';
export { etaSeconds, poiDistances, type PoiDistance } from './proximity.ts';
export {
  addPlayer,
  addTeam,
  movePlayer,
  normaliseCallsign,
  playerIdFor,
  removePlayer,
  removeTeam,
  renameTeam,
  teamIdFor,
  type Roster,
  type RosterError,
  type RosterResult,
} from './roster.ts';
export {
  bearingDegrees,
  distanceToBoundaryMetres,
  nearestBoundaryPoint,
  type BoundaryPoint,
} from './geometry.ts';
export { zoneAt, ZONE_HOLD_MAX_METRES, type ZoneHold } from './zones.ts';
export {
  advanceCursor,
  earliestSampleTs,
  indexTrack,
  positionAt,
  replayAt,
  routeAt,
  sampleOf,
  trackAttributes,
  REPLAY_DEFAULT_WINDOW_MS,
  REPLAY_SPEEDS,
  replayStartCursor,
  replayWindowFor,
  TRACK_ATTRIBUTES,
  TRACK_ATTRIBUTE_VALUE_MAX,
  TRACK_RETENTION_MS,
  trackTrimRefusal,
  type ReplayIndex,
  type TrackTrimRefusal,
  type TrackWindow,
} from './track.ts';

export type {
  Device,
  Game,
  GameEvent,
  MasterMarker,
  OsmAndPing,
  OsmAndStatus,
  PingRejection,
  Player,
  Poi,
  Team,
  TrackSample,
  TrayEntry,
  Zone,
} from '@q4413/shared';

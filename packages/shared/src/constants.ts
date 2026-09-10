/**
 * Core simulation constants. Both the authoritative server and the client
 * predictor/renderer read these, so they must never drift apart.
 */

/** Simulation ticks per second. Snapshots are emitted at the same rate. */
export const TICK_RATE = 20;
/** Fixed timestep, in seconds. */
export const DT = 1 / TICK_RATE;

/** Square arena, world units. */
export const WORLD_SIZE = 6000;
/** Background grid cell size, world units. */
export const GRID_SIZE = 50;

/** Broad-phase uniform grid cell size. Roughly 2x the largest common radius. */
export const SPATIAL_CELL = 128;

// ---------------------------------------------------------------------------
// Tanks
// ---------------------------------------------------------------------------

/** Radius of a level-1 tank body, world units. */
export const BASE_TANK_RADIUS = 25;
/** Body radius grows by this factor per level. */
export const RADIUS_GROWTH = 1.007;

export const MAX_LEVEL = 45;

/** Base top speed (world units / second) before class and stat modifiers. */
export const BASE_MAX_SPEED = 210;
/**
 * Movement model, shared so the client can predict exactly what the server
 * will do. Drive velocity converges on the input direction at `DRIVE_RESPONSE`
 * per second and coasts down at `COAST_DECAY` when no key is held; impulses
 * (recoil, knockback) live in a separate channel that decays at `IMPULSE_DECAY`.
 */
export const DRIVE_RESPONSE = 7.5;
export const COAST_DECAY = 4.5;
export const IMPULSE_DECAY = 2.4;
/** Knockback strength applied when two solid bodies overlap. */
export const SEPARATION_FORCE = 22;

/** Health model, mirrors diep.io's additive curve. */
export const BASE_MAX_HEALTH = 50;
export const HEALTH_PER_LEVEL = 2;
export const HEALTH_PER_UPGRADE = 20;

/** Seconds without taking damage before passive regeneration kicks in. */
export const REGEN_DELAY = 4;

/** Body-collision damage. */
export const BASE_BODY_DAMAGE = 20;
export const BODY_DAMAGE_PER_UPGRADE = 6;
/** Body damage can only be applied to the same target this often (seconds). */
export const BODY_DAMAGE_COOLDOWN = 0.25;

/** Seconds of spawn protection; the tank cannot be damaged nor deal damage. */
export const SPAWN_PROTECTION = 5;
/** Spawn protection breaks early once the player shoots or moves this far. */
export const SPAWN_PROTECTION_BREAK_DIST = 400;

/** Seconds a dead player waits before they may respawn. */
export const RESPAWN_DELAY = 2;

// ---------------------------------------------------------------------------
// Bullets
// ---------------------------------------------------------------------------

export const BASE_BULLET_SPEED = 640;
export const BASE_BULLET_DAMAGE = 8;
export const BASE_BULLET_HEALTH = 6;
export const BASE_BULLET_LIFETIME = 1.6;
/** Recoil impulse applied to the shooter, as a fraction of muzzle speed. */
export const RECOIL_FACTOR = 0.12;

// ---------------------------------------------------------------------------
// Shapes (the passive XP food)
// ---------------------------------------------------------------------------

export const SHAPE_TARGET_COUNT = 480;
/** Shapes drift at this speed and slowly rotate. */
export const SHAPE_SPEED = 12;

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

/** Entities beyond this distance from the camera are not sent to a client. */
export const VIEW_RADIUS = 1150;
/** Client renders the world this many milliseconds in the past, to interpolate. */
export const INTERP_DELAY_MS = 110;
/** Connection is dropped after this long without any client frame. */
export const CLIENT_TIMEOUT_MS = 20_000;
/** Server -> client heartbeat interval. */
export const PING_INTERVAL_MS = 4_000;

// ---------------------------------------------------------------------------
// Match rules
// ---------------------------------------------------------------------------

export const CASUAL_ROOM_CAP = 40;

/** A ranked lobby needs this many players before it starts. */
export const RANKED_MIN_PLAYERS = 4;
export const RANKED_MAX_PLAYERS = 12;
/** Seconds a ranked lobby waits for a full house before starting anyway. */
export const RANKED_QUEUE_GRACE = 30;
/** Ranked match duration, in seconds. */
export const RANKED_MATCH_SECONDS = 480;
/** Countdown shown to ranked players before the match goes live. */
export const RANKED_COUNTDOWN_SECONDS = 5;
/** In ranked, a death costs you this fraction of your score. */
export const RANKED_DEATH_SCORE_PENALTY = 0.25;

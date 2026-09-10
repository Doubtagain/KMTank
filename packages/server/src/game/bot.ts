import {
  ACT_AUTOFIRE,
  BASE_BULLET_SPEED,
  MAX_STAT_LEVEL,
  MOVE_DOWN,
  MOVE_LEFT,
  MOVE_RIGHT,
  MOVE_UP,
  WORLD_SIZE,
  availableUpgrades,
  bulletSpeedMultiplier,
} from '@kmtank/shared';

import type { Room } from './room.js';
import type { Tank } from './entities.js';
import { distanceSq } from './spatial.js';

/**
 * Bot AI.
 *
 * Bots drive the same input struct as human players, so they are subject to
 * exactly the same physics, reload rules and damage model — there is no
 * separate code path for them in the simulation.
 */

interface Brain {
  targetId: number;
  targetKind: 'tank' | 'shape' | null;
  retargetAt: number;
  wanderX: number;
  wanderY: number;
  /** Stat indices, spent in order. */
  build: number[];
  /** Reaction jitter so bots do not all turn on the same tick. */
  aimNoise: number;
}

const brains = new Map<number, Brain>();

/** A few archetypes, so a lobby of bots is not all the same tank. */
const BUILDS: number[][] = [
  [5, 4, 6, 1, 7, 2, 3, 0], // bullet damage bruiser
  [6, 5, 3, 7, 1, 4, 2, 0], // reload spammer
  [7, 1, 2, 5, 0, 6, 3, 4], // rammer
  [3, 5, 4, 6, 7, 1, 0, 2], // sniper
];

const HUNT_RADIUS = 760;
const SHAPE_RADIUS = 640;
const RETARGET_INTERVAL = 1.1;
/** Bots will not chase a tank this many levels below them. */
const MERCY_LEVEL_GAP = 8;

function brainFor(tank: Tank, now: number): Brain {
  let brain = brains.get(tank.id);
  if (!brain) {
    brain = {
      targetId: 0,
      targetKind: null,
      retargetAt: 0,
      wanderX: Math.random() * WORLD_SIZE,
      wanderY: Math.random() * WORLD_SIZE,
      build: BUILDS[Math.floor(Math.random() * BUILDS.length)],
      aimNoise: 0.02 + Math.random() * 0.06,
    };
    brains.set(tank.id, brain);
  }
  if (brain.retargetAt === 0) brain.retargetAt = now;
  return brain;
}

/** Called when a bot tank leaves the room, so brains do not leak. */
export function forgetBot(tankId: number): void {
  brains.delete(tankId);
}

export function updateBot(room: Room, tank: Tank): void {
  const now = room.time;
  const brain = brainFor(tank, now);

  spendUpgrades(tank, brain);

  if (now >= brain.retargetAt) {
    brain.retargetAt = now + RETARGET_INTERVAL;
    retarget(room, tank, brain);
  }

  const lowHealth = tank.health < tank.maxHealth * 0.3;
  let move = 0;
  let actions = 0;
  let aim = tank.angle;

  const target = resolveTarget(room, brain);
  if (target) {
    const dx = target.x - tank.x;
    const dy = target.y - tank.y;
    const dist = Math.hypot(dx, dy) || 1;

    // Lead the shot by the bullet's travel time.
    const bulletSpeed = BASE_BULLET_SPEED * bulletSpeedMultiplier(tank.stats[3]);
    const travel = dist / bulletSpeed;
    const leadX = target.x + target.vx * travel;
    const leadY = target.y + target.vy * travel;
    aim = Math.atan2(leadY - tank.y, leadX - tank.x) + (Math.random() - 0.5) * brain.aimNoise;

    const engageRange = brain.targetKind === 'tank' ? 320 : tank.radius + target.radius + 30;
    const wantsRetreat = brain.targetKind === 'tank' && lowHealth;
    const desired = wantsRetreat ? -1 : dist > engageRange ? 1 : dist < engageRange * 0.6 ? -1 : 0;

    if (desired !== 0) move = directionBits((dx / dist) * desired, (dy / dist) * desired);
    else move = strafeBits(dx / dist, dy / dist, tank.id, now);

    if (dist < (brain.targetKind === 'tank' ? 900 : 520)) actions |= ACT_AUTOFIRE;
  } else {
    if (distanceSq(tank.x, tank.y, brain.wanderX, brain.wanderY) < 260 * 260) {
      brain.wanderX = 300 + Math.random() * (WORLD_SIZE - 600);
      brain.wanderY = 300 + Math.random() * (WORLD_SIZE - 600);
    }
    const dx = brain.wanderX - tank.x;
    const dy = brain.wanderY - tank.y;
    const dist = Math.hypot(dx, dy) || 1;
    move = directionBits(dx / dist, dy / dist);
    aim = Math.atan2(dy, dx);
  }

  // Stay off the walls; being cornered is a death sentence.
  const edge = 240;
  if (tank.x < edge) move = (move & ~MOVE_LEFT) | MOVE_RIGHT;
  else if (tank.x > WORLD_SIZE - edge) move = (move & ~MOVE_RIGHT) | MOVE_LEFT;
  if (tank.y < edge) move = (move & ~MOVE_UP) | MOVE_DOWN;
  else if (tank.y > WORLD_SIZE - edge) move = (move & ~MOVE_DOWN) | MOVE_UP;

  tank.input.move = move;
  tank.input.actions = actions;
  tank.input.aim = aim;
}

interface TargetView {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

function resolveTarget(room: Room, brain: Brain): TargetView | null {
  if (brain.targetKind === 'tank') {
    const tank = room.tanks.get(brain.targetId);
    if (!tank || tank.dead) {
      brain.targetKind = null;
      return null;
    }
    return { x: tank.x, y: tank.y, vx: tank.vx + tank.ix, vy: tank.vy + tank.iy, radius: tank.radius };
  }
  if (brain.targetKind === 'shape') {
    const shape = room.shapes.get(brain.targetId);
    if (!shape || shape.dead) {
      brain.targetKind = null;
      return null;
    }
    return { x: shape.x, y: shape.y, vx: shape.vx, vy: shape.vy, radius: shape.radius };
  }
  return null;
}

function retarget(room: Room, tank: Tank, brain: Brain): void {
  let bestTankId = 0;
  let bestTankDist = HUNT_RADIUS * HUNT_RADIUS;
  for (const other of room.tanks.values()) {
    if (other.id === tank.id || other.dead) continue;
    if (room.time < other.protectedUntil) continue;
    // A veteran bot ignores tanks far below it. There is no XP in the kill, and
    // it is what makes an arena unplayable for someone who just spawned.
    if (tank.level - other.level > MERCY_LEVEL_GAP) continue;
    const d = distanceSq(tank.x, tank.y, other.x, other.y);
    if (d < bestTankDist) {
      bestTankDist = d;
      bestTankId = other.id;
    }
  }

  // Prefer a fight unless badly hurt, in which case farm shapes instead.
  const healthy = tank.health > tank.maxHealth * 0.45;
  if (bestTankId && healthy) {
    brain.targetKind = 'tank';
    brain.targetId = bestTankId;
    return;
  }

  let bestShapeId = 0;
  let bestShapeScore = -Infinity;
  for (const shape of room.shapes.values()) {
    if (shape.dead) continue;
    const d = distanceSq(tank.x, tank.y, shape.x, shape.y);
    if (d > SHAPE_RADIUS * SHAPE_RADIUS) continue;
    // Favour high-XP shapes that are also close.
    const score = shape.xp / (1 + Math.sqrt(d) / 100);
    if (score > bestShapeScore) {
      bestShapeScore = score;
      bestShapeId = shape.id;
    }
  }

  if (bestShapeId) {
    brain.targetKind = 'shape';
    brain.targetId = bestShapeId;
    return;
  }
  if (bestTankId) {
    brain.targetKind = 'tank';
    brain.targetId = bestTankId;
    return;
  }
  brain.targetKind = null;
}

function spendUpgrades(tank: Tank, brain: Brain): void {
  while (tank.statPoints > 0) {
    const next = brain.build.find((index) => tank.stats[index] < MAX_STAT_LEVEL);
    if (next === undefined) break;
    if (!tank.investStat(next)) break;
  }
  const options = availableUpgrades(tank.classKey, tank.level);
  if (options.length > 0) {
    const pick = options[Math.floor(Math.random() * options.length)];
    tank.classKey = pick;
    tank.cooldowns = [];
    tank.recompute();
  }
}

function directionBits(nx: number, ny: number): number {
  let bits = 0;
  if (nx < -0.35) bits |= MOVE_LEFT;
  else if (nx > 0.35) bits |= MOVE_RIGHT;
  if (ny < -0.35) bits |= MOVE_UP;
  else if (ny > 0.35) bits |= MOVE_DOWN;
  return bits;
}

/** Circle-strafe: move perpendicular to the target, flipping every few seconds. */
function strafeBits(nx: number, ny: number, seed: number, now: number): number {
  const sign = Math.floor(now / 2.5 + seed) % 2 === 0 ? 1 : -1;
  return directionBits(-ny * sign, nx * sign);
}

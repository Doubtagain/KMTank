import { MAX_LEVEL } from './constants.js';

/** The eight upgradable stats, in HUD order. */
export const STAT_IDS = [
  'healthRegen',
  'maxHealth',
  'bodyDamage',
  'bulletSpeed',
  'bulletPenetration',
  'bulletDamage',
  'reload',
  'movementSpeed',
] as const;

export type StatId = (typeof STAT_IDS)[number];

export const STAT_COUNT = STAT_IDS.length;

/** Maximum points investable in a single stat. */
export const MAX_STAT_LEVEL = 7;

export const STAT_LABELS: Record<StatId, string> = {
  healthRegen: 'Health Regen',
  maxHealth: 'Max Health',
  bodyDamage: 'Body Damage',
  bulletSpeed: 'Bullet Speed',
  bulletPenetration: 'Bullet Penetration',
  bulletDamage: 'Bullet Damage',
  reload: 'Reload',
  movementSpeed: 'Movement Speed',
};

export const STAT_COLORS: Record<StatId, string> = {
  healthRegen: '#e07be0',
  maxHealth: '#e0a93b',
  bodyDamage: '#8a4fd8',
  bulletSpeed: '#3b7de0',
  bulletPenetration: '#e0e04a',
  bulletDamage: '#e05a5a',
  reload: '#4fd88a',
  movementSpeed: '#4fd8d8',
};

/** A fixed-length vector of invested points, indexed by `STAT_IDS`. */
export type StatVector = number[];

export function emptyStats(): StatVector {
  return new Array(STAT_COUNT).fill(0);
}

export function statIndex(id: StatId): number {
  return STAT_IDS.indexOf(id);
}

/**
 * Total stat points a tank has earned by `level`.
 *
 * Levels 2-28 grant one point each; past 28 a point arrives every third level.
 * This matches diep.io closely enough that build guides transfer.
 */
export function statPointsForLevel(level: number): number {
  const capped = Math.min(level, MAX_LEVEL);
  if (capped <= 1) return 0;
  if (capped <= 28) return capped - 1;
  return 27 + Math.floor((capped - 28) / 3);
}

/**
 * XP required to advance *from* `level` to `level + 1`.
 *
 * Superlinear so that the early game is fast and late levels are a grind.
 */
export function xpToNextLevel(level: number): number {
  if (level >= MAX_LEVEL) return Infinity;
  return Math.round(4 * Math.pow(1.06, level - 1) * level + 10);
}

/** Cumulative XP needed to reach `level` from a fresh spawn. */
export function totalXpForLevel(level: number): number {
  let sum = 0;
  for (let i = 1; i < level; i++) sum += xpToNextLevel(i);
  return sum;
}

/** Level implied by a total XP amount. */
export function levelForXp(xp: number): number {
  let level = 1;
  let remaining = xp;
  while (level < MAX_LEVEL) {
    const need = xpToNextLevel(level);
    if (remaining < need) break;
    remaining -= need;
    level++;
  }
  return level;
}

// --- Per-stat multipliers -------------------------------------------------

/** Health points granted per invested point. */
export const regenPerSecond = (points: number, maxHealth: number): number =>
  (maxHealth * (0.02 + points * 0.012)) / 1;

export const speedMultiplier = (points: number): number => 1 + points * 0.075;
export const reloadMultiplier = (points: number): number => Math.pow(0.915, points);
export const bulletSpeedMultiplier = (points: number): number => 1 + points * 0.09;
export const bulletDamageMultiplier = (points: number): number => 1 + points * 0.22;
export const bulletHealthMultiplier = (points: number): number => 1 + points * 0.28;

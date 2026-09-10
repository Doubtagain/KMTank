/**
 * The tank upgrade tree.
 *
 * A tank is described entirely by its barrels; the simulation has no
 * class-specific branches. Barrel geometry is expressed in multiples of the
 * tank's body radius so everything scales with level automatically.
 */

export interface Barrel {
  /** Aim-relative direction of the muzzle, in radians. */
  angle: number;
  /** Lateral offset from the body centre, in body radii (perpendicular to `angle`). */
  offset: number;
  /** Barrel width, in body radii. */
  width: number;
  /** Barrel length measured from the body centre, in body radii. */
  length: number;
  /** Phase within the shared reload cycle, 0..1. Lets barrels alternate. */
  delay: number;
  /** Multiplier on the reload cycle length. Lower fires faster. */
  reload: number;
  /** Multipliers applied to the bullet spawned by this barrel. */
  damage: number;
  health: number;
  speed: number;
  /** Random angular scatter applied per shot, in degrees. */
  scatter: number;
  /** Multiplier on the recoil impulse pushed back into the tank. */
  recoil: number;
  /** Bullet radius as a fraction of the barrel width. */
  bulletSize: number;
}

const barrel = (b: Partial<Barrel> & Pick<Barrel, 'angle'>): Barrel => ({
  offset: 0,
  width: 0.72,
  length: 1.85,
  delay: 0,
  reload: 1,
  damage: 1,
  health: 1,
  speed: 1,
  scatter: 2,
  recoil: 1,
  bulletSize: 1,
  ...b,
});

const DEG = Math.PI / 180;

export interface TankClass {
  id: number;
  name: string;
  /** Level at which this class becomes selectable. */
  tier: 0 | 1 | 2 | 3;
  /** Classes this one can upgrade into. */
  upgrades: string[];
  barrels: Barrel[];
  /** Camera zoom-out multiplier. Snipers see further. */
  fov: number;
  /** Multiplier on the tank's base reload cycle. */
  reload: number;
  /** Multiplier on the tank's top speed. */
  speed: number;
  /** Multiplier on the tank's max health. */
  health: number;
  /** Multiplier on body-collision damage. */
  bodyDamage: number;
}

const defineClass = (
  key: string,
  id: number,
  tier: 0 | 1 | 2 | 3,
  upgrades: string[],
  barrels: Barrel[],
  extra: Partial<Pick<TankClass, 'fov' | 'reload' | 'speed' | 'health' | 'bodyDamage'>> = {},
): [string, TankClass] => [
  key,
  {
    id,
    name: key
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (c) => c.toUpperCase())
      .trim(),
    tier,
    upgrades,
    barrels,
    fov: 1,
    reload: 1,
    speed: 1,
    health: 1,
    bodyDamage: 1,
    ...extra,
  },
];

/** Every playable class, keyed by its stable string id. */
export const TANK_CLASSES: Record<string, TankClass> = Object.fromEntries([
  // --- Tier 0 -------------------------------------------------------------
  defineClass('basic', 0, 0, ['twin', 'sniper', 'machineGun', 'flankGuard'], [barrel({ angle: 0 })]),

  // --- Tier 1 (level 15) --------------------------------------------------
  defineClass(
    'twin',
    1,
    1,
    ['tripleShot', 'doubleTwin'],
    [
      barrel({ angle: 0, offset: -0.5, delay: 0, damage: 0.62, reload: 1 }),
      barrel({ angle: 0, offset: 0.5, delay: 0.5, damage: 0.62, reload: 1 }),
    ],
    { reload: 0.83 },
  ),
  defineClass(
    'sniper',
    2,
    1,
    ['assassin', 'hunter'],
    [barrel({ angle: 0, length: 2.6, width: 0.68, speed: 1.45, damage: 1.15, health: 1.2, scatter: 0.6 })],
    { fov: 1.32, reload: 1.6 },
  ),
  defineClass(
    'machineGun',
    3,
    1,
    ['destroyer', 'gunner', 'sprayer'],
    [barrel({ angle: 0, width: 1.05, length: 1.6, scatter: 11, damage: 0.7, health: 0.75, speed: 0.92, bulletSize: 0.9 })],
    { reload: 0.55 },
  ),
  defineClass(
    'flankGuard',
    4,
    1,
    ['twinFlank', 'triAngle', 'quadTank'],
    [
      barrel({ angle: 0 }),
      barrel({ angle: Math.PI, length: 1.6, width: 0.66, damage: 0.75, speed: 0.85 }),
    ],
  ),

  // --- Tier 2 (level 30) --------------------------------------------------
  defineClass(
    'tripleShot',
    5,
    2,
    ['pentaShot', 'spreadShot'],
    [
      barrel({ angle: 0, damage: 0.72 }),
      barrel({ angle: -26 * DEG, length: 1.7, damage: 0.72 }),
      barrel({ angle: 26 * DEG, length: 1.7, damage: 0.72 }),
    ],
    { reload: 1.05 },
  ),
  defineClass(
    'doubleTwin',
    6,
    2,
    ['tripleTwin', 'octoTank'],
    [
      barrel({ angle: 0, offset: -0.5, delay: 0, damage: 0.6 }),
      barrel({ angle: 0, offset: 0.5, delay: 0.5, damage: 0.6 }),
      barrel({ angle: Math.PI, offset: -0.5, delay: 0.25, damage: 0.6 }),
      barrel({ angle: Math.PI, offset: 0.5, delay: 0.75, damage: 0.6 }),
    ],
    { reload: 0.83 },
  ),
  defineClass(
    'assassin',
    7,
    2,
    ['ranger', 'stalker'],
    [barrel({ angle: 0, length: 3.1, width: 0.66, speed: 1.6, damage: 1.3, health: 1.35, scatter: 0.35 })],
    { fov: 1.5, reload: 1.85 },
  ),
  defineClass(
    'hunter',
    8,
    2,
    ['predator', 'streamliner'],
    [
      barrel({ angle: 0, width: 0.86, length: 2.3, damage: 0.68, health: 0.9, speed: 1.25, delay: 0 }),
      barrel({ angle: 0, width: 0.6, length: 2.75, damage: 0.68, health: 0.9, speed: 1.3, delay: 0.18 }),
    ],
    { fov: 1.28, reload: 1.5 },
  ),
  defineClass(
    'destroyer',
    9,
    2,
    ['annihilator'],
    [barrel({ angle: 0, width: 1.4, length: 2.0, damage: 3.2, health: 3.0, speed: 0.62, scatter: 1, recoil: 3.4, bulletSize: 1 })],
    { reload: 4.2 },
  ),
  defineClass(
    'gunner',
    10,
    2,
    ['streamliner', 'sprayer'],
    [
      barrel({ angle: 0, offset: -0.72, width: 0.46, length: 1.5, delay: 0, damage: 0.3, health: 0.55, scatter: 4 }),
      barrel({ angle: 0, offset: -0.26, width: 0.46, length: 1.9, delay: 0.5, damage: 0.3, health: 0.55, scatter: 4 }),
      barrel({ angle: 0, offset: 0.26, width: 0.46, length: 1.9, delay: 0.25, damage: 0.3, health: 0.55, scatter: 4 }),
      barrel({ angle: 0, offset: 0.72, width: 0.46, length: 1.5, delay: 0.75, damage: 0.3, health: 0.55, scatter: 4 }),
    ],
    { reload: 0.72 },
  ),
  defineClass(
    'sprayer',
    11,
    2,
    [],
    [
      barrel({ angle: 0, width: 1.05, length: 1.6, scatter: 13, damage: 0.55, health: 0.6, speed: 0.9, bulletSize: 0.85 }),
      barrel({ angle: 0, width: 0.66, length: 2.1, scatter: 6, damage: 0.6, health: 0.7, speed: 1.1 }),
    ],
    { reload: 0.5 },
  ),
  defineClass(
    'twinFlank',
    12,
    2,
    ['tripleTwin', 'octoTank'],
    [
      barrel({ angle: 0, offset: -0.5, delay: 0, damage: 0.62 }),
      barrel({ angle: 0, offset: 0.5, delay: 0.5, damage: 0.62 }),
      barrel({ angle: Math.PI, offset: -0.5, delay: 0.25, damage: 0.62 }),
      barrel({ angle: Math.PI, offset: 0.5, delay: 0.75, damage: 0.62 }),
    ],
    { reload: 0.85 },
  ),
  defineClass(
    'triAngle',
    13,
    2,
    ['booster', 'fighter'],
    [
      barrel({ angle: 0 }),
      barrel({ angle: 150 * DEG, length: 1.6, width: 0.66, damage: 0.5, speed: 0.8, recoil: 2.6 }),
      barrel({ angle: -150 * DEG, length: 1.6, width: 0.66, damage: 0.5, speed: 0.8, recoil: 2.6 }),
    ],
    { speed: 1.06 },
  ),
  defineClass(
    'quadTank',
    14,
    2,
    ['octoTank'],
    [
      barrel({ angle: 0 }),
      barrel({ angle: Math.PI / 2 }),
      barrel({ angle: Math.PI }),
      barrel({ angle: -Math.PI / 2 }),
    ],
    { reload: 1.1 },
  ),

  // --- Tier 3 (level 45) --------------------------------------------------
  defineClass(
    'pentaShot',
    15,
    3,
    [],
    [
      barrel({ angle: 0, length: 2.1, damage: 0.68, delay: 0 }),
      barrel({ angle: -22 * DEG, length: 1.85, damage: 0.68, delay: 0.5 }),
      barrel({ angle: 22 * DEG, length: 1.85, damage: 0.68, delay: 0.5 }),
      barrel({ angle: -44 * DEG, length: 1.6, damage: 0.68, delay: 0 }),
      barrel({ angle: 44 * DEG, length: 1.6, damage: 0.68, delay: 0 }),
    ],
    { reload: 1.05 },
  ),
  defineClass(
    'spreadShot',
    16,
    3,
    [],
    [
      barrel({ angle: 0, length: 2.2, damage: 0.9, delay: 0 }),
      ...[-12, 12, -24, 24, -36, 36, -48, 48].map((deg, i) =>
        barrel({
          angle: deg * DEG,
          length: 1.95 - Math.abs(deg) * 0.012,
          damage: 0.34,
          health: 0.6,
          delay: 0.12 * (i + 1),
          reload: 1,
        }),
      ),
    ],
    { reload: 1.1 },
  ),
  defineClass(
    'tripleTwin',
    17,
    3,
    [],
    [
      ...[0, 120, 240].flatMap((deg, i) => [
        barrel({ angle: deg * DEG, offset: -0.5, delay: i * 0.16, damage: 0.6 }),
        barrel({ angle: deg * DEG, offset: 0.5, delay: i * 0.16 + 0.5, damage: 0.6 }),
      ]),
    ],
    { reload: 0.9 },
  ),
  defineClass(
    'octoTank',
    18,
    3,
    [],
    [...Array.from({ length: 8 }, (_, i) => barrel({ angle: (i * 45) * DEG, damage: 0.62, length: 1.75 }))],
    { reload: 1.15 },
  ),
  defineClass(
    'ranger',
    19,
    3,
    [],
    [barrel({ angle: 0, length: 3.5, width: 0.64, speed: 1.85, damage: 1.4, health: 1.5, scatter: 0.2 })],
    { fov: 1.85, reload: 2.1 },
  ),
  defineClass(
    'stalker',
    20,
    3,
    [],
    [barrel({ angle: 0, length: 3.1, width: 0.66, speed: 1.65, damage: 1.35, health: 1.4, scatter: 0.3 })],
    { fov: 1.55, reload: 1.85, speed: 1.05 },
  ),
  defineClass(
    'predator',
    21,
    3,
    [],
    [
      barrel({ angle: 0, width: 0.95, length: 2.1, damage: 0.65, speed: 1.1, delay: 0 }),
      barrel({ angle: 0, width: 0.78, length: 2.6, damage: 0.65, speed: 1.2, delay: 0.12 }),
      barrel({ angle: 0, width: 0.6, length: 3.05, damage: 0.65, speed: 1.3, delay: 0.24 }),
    ],
    { fov: 1.45, reload: 1.9 },
  ),
  defineClass(
    'streamliner',
    22,
    3,
    [],
    [
      ...[0, 0.1, 0.2, 0.3, 0.4].map((d, i) =>
        barrel({ angle: 0, width: 0.6, length: 2.6 - i * 0.14, damage: 0.28, health: 0.5, speed: 1.15, delay: d, scatter: 3 }),
      ),
    ],
    { fov: 1.2, reload: 0.8 },
  ),
  defineClass(
    'annihilator',
    23,
    3,
    [],
    [barrel({ angle: 0, width: 1.85, length: 1.95, damage: 4.6, health: 4.2, speed: 0.58, scatter: 0.8, recoil: 4.6 })],
    { reload: 5.2 },
  ),
  defineClass(
    'booster',
    24,
    3,
    [],
    [
      barrel({ angle: 0 }),
      barrel({ angle: 150 * DEG, length: 1.6, width: 0.62, damage: 0.4, speed: 0.75, recoil: 2.9 }),
      barrel({ angle: -150 * DEG, length: 1.6, width: 0.62, damage: 0.4, speed: 0.75, recoil: 2.9 }),
      barrel({ angle: 165 * DEG, length: 1.45, width: 0.58, damage: 0.35, speed: 0.7, recoil: 2.9 }),
      barrel({ angle: -165 * DEG, length: 1.45, width: 0.58, damage: 0.35, speed: 0.7, recoil: 2.9 }),
    ],
    { speed: 1.12 },
  ),
  defineClass(
    'fighter',
    25,
    3,
    [],
    [
      barrel({ angle: 0 }),
      barrel({ angle: Math.PI / 2, length: 1.5, width: 0.62, damage: 0.45, speed: 0.8 }),
      barrel({ angle: -Math.PI / 2, length: 1.5, width: 0.62, damage: 0.45, speed: 0.8 }),
      barrel({ angle: 150 * DEG, length: 1.6, width: 0.66, damage: 0.45, speed: 0.8, recoil: 2.4 }),
      barrel({ angle: -150 * DEG, length: 1.6, width: 0.66, damage: 0.45, speed: 0.8, recoil: 2.4 }),
    ],
    { speed: 1.05 },
  ),
]);

/** Stable numeric id -> class key, for the wire format. */
export const TANK_CLASS_BY_ID: Record<number, string> = Object.fromEntries(
  Object.entries(TANK_CLASSES).map(([key, def]) => [def.id, key]),
);

export const TIER_LEVELS: Record<1 | 2 | 3, number> = { 1: 15, 2: 30, 3: 45 };

/** Class keys a player at `level` may upgrade `from` into right now. */
export function availableUpgrades(from: string, level: number): string[] {
  const def = TANK_CLASSES[from];
  if (!def) return [];
  return def.upgrades.filter((key) => {
    const next = TANK_CLASSES[key];
    return next !== undefined && level >= TIER_LEVELS[next.tier as 1 | 2 | 3];
  });
}

/** Whether `to` is a legal single-step upgrade from `from` at `level`. */
export function canUpgradeTo(from: string, to: string, level: number): boolean {
  return availableUpgrades(from, level).includes(to);
}

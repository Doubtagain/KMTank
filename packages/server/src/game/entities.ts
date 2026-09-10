import {
  BASE_BODY_DAMAGE,
  BASE_BULLET_DAMAGE,
  BASE_BULLET_HEALTH,
  BASE_BULLET_LIFETIME,
  BASE_BULLET_SPEED,
  BASE_MAX_HEALTH,
  BASE_MAX_SPEED,
  BASE_TANK_RADIUS,
  BODY_DAMAGE_PER_UPGRADE,
  HEALTH_PER_LEVEL,
  HEALTH_PER_UPGRADE,
  MAX_STAT_LEVEL,
  RADIUS_GROWTH,
  RECOIL_FACTOR,
  TANK_CLASSES,
  bulletDamageMultiplier,
  bulletHealthMultiplier,
  bulletSpeedMultiplier,
  emptyStats,
  levelForXp,
  reloadMultiplier,
  speedMultiplier,
  statPointsForLevel,
  xpToNextLevel,
  type Barrel,
  type StatVector,
} from '@kmtank/shared';

/** Base seconds between shots before class and stat modifiers. */
export const BASE_RELOAD_CYCLE = 0.55;

export type EntityKind = 'tank' | 'bullet' | 'shape';

export interface Damageable {
  readonly kind: EntityKind;
  id: number;
  x: number;
  y: number;
  radius: number;
  health: number;
  maxHealth: number;
  /** Damage dealt on contact. */
  damage: number;
  dead: boolean;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ShapeSpec {
  sides: 3 | 4 | 5;
  radius: number;
  health: number;
  damage: number;
  xp: number;
  weight: number;
}

export const SHAPE_SPECS: ShapeSpec[] = [
  { sides: 4, radius: 17, health: 10, damage: 8, xp: 10, weight: 0.7 },
  { sides: 3, radius: 20, health: 30, damage: 12, xp: 25, weight: 0.22 },
  { sides: 5, radius: 32, health: 100, damage: 16, xp: 130, weight: 0.08 },
];

export class Shape implements Damageable {
  readonly kind = 'shape' as const;
  dead = false;
  vx = 0;
  vy = 0;
  angle = Math.random() * Math.PI * 2;
  spin: number;
  health: number;
  maxHealth: number;
  damage: number;
  radius: number;
  xp: number;
  sides: 3 | 4 | 5;

  constructor(
    public id: number,
    public x: number,
    public y: number,
    spec: ShapeSpec,
  ) {
    this.sides = spec.sides;
    this.radius = spec.radius;
    this.health = spec.health;
    this.maxHealth = spec.health;
    this.damage = spec.damage;
    this.xp = spec.xp;
    this.spin = (Math.random() - 0.5) * 1.2;
  }
}

export function pickShapeSpec(): ShapeSpec {
  const roll = Math.random();
  let acc = 0;
  for (const spec of SHAPE_SPECS) {
    acc += spec.weight;
    if (roll <= acc) return spec;
  }
  return SHAPE_SPECS[0];
}

// ---------------------------------------------------------------------------
// Bullets
// ---------------------------------------------------------------------------

export class Bullet implements Damageable {
  readonly kind = 'bullet' as const;
  dead = false;
  /** Remaining lifetime in seconds. */
  life: number;

  constructor(
    public id: number,
    public ownerId: number,
    public x: number,
    public y: number,
    public vx: number,
    public vy: number,
    public radius: number,
    public damage: number,
    public health: number,
    public maxHealth: number,
    public colorIndex: number,
    life = BASE_BULLET_LIFETIME,
  ) {
    this.life = life;
  }
}

// ---------------------------------------------------------------------------
// Tanks
// ---------------------------------------------------------------------------

export interface TankInput {
  move: number;
  actions: number;
  aim: number;
}

/** A live tank. Backed either by a socket (`Player`) or by the bot AI. */
export class Tank implements Damageable {
  readonly kind = 'tank' as const;

  x = 0;
  y = 0;
  /** Velocity produced by the movement keys. */
  vx = 0;
  vy = 0;
  /** Velocity from external impulses: recoil and collision knockback. */
  ix = 0;
  iy = 0;
  angle = 0;
  radius = BASE_TANK_RADIUS;

  health = BASE_MAX_HEALTH;
  maxHealth = BASE_MAX_HEALTH;
  damage = BASE_BODY_DAMAGE;

  dead = false;
  /** Server time (seconds) the tank died at. */
  diedAt = 0;
  /** Server time until which the tank cannot deal or take damage. */
  protectedUntil = 0;
  spawnX = 0;
  spawnY = 0;

  classKey = 'basic';
  level = 1;
  /** XP for the current life; drives `level`. */
  xp = 0;
  /** Cumulative score across the whole match. */
  matchScore = 0;
  stats: StatVector = emptyStats();
  statPoints = 0;

  kills = 0;
  deaths = 0;
  /** Server time of the last damage taken, for regeneration delay. */
  lastDamagedAt = -999;
  /** Server time this tank spawned, for survival stats. */
  spawnedAt = 0;

  /**
   * Upper bound on lifetime XP. Bots are capped so a long-lived room does not
   * fill up with level-45 AI that new players cannot survive.
   */
  xpCap = Infinity;

  input: TankInput = { move: 0, actions: 0, aim: 0 };
  /** Per-barrel cooldowns in seconds, parallel to the class barrel list. */
  cooldowns: number[] = [0];
  /** Per-target body-damage cooldowns, keyed by entity id. */
  contactCooldown = new Map<number, number>();

  constructor(
    public id: number,
    public name: string,
    public colorIndex: number,
    public readonly isBot: boolean,
    /** Persisted account id, or null for guests and bots. */
    public userId: string | null = null,
  ) {
    this.recompute(true);
  }

  get def() {
    return TANK_CLASSES[this.classKey] ?? TANK_CLASSES.basic;
  }

  get barrels(): Barrel[] {
    return this.def.barrels;
  }

  /** Score shown on the in-game leaderboard: this life's XP. */
  get score(): number {
    return this.xp;
  }

  get maxSpeed(): number {
    return (
      BASE_MAX_SPEED *
      speedMultiplier(this.stats[7]) *
      this.def.speed *
      Math.pow(0.995, this.level - 1)
    );
  }

  get reloadCycle(): number {
    return BASE_RELOAD_CYCLE * this.def.reload * reloadMultiplier(this.stats[6]);
  }

  get regenPerSecond(): number {
    const points = this.stats[0];
    // A base trickle plus a strong scaling term, expressed as %max health/sec.
    return this.maxHealth * (0.008 + points * 0.014);
  }

  get xpProgress(): number {
    let consumed = 0;
    for (let i = 1; i < this.level; i++) consumed += xpToNextLevel(i);
    const need = xpToNextLevel(this.level);
    if (!Number.isFinite(need)) return 1;
    return Math.max(0, Math.min(1, (this.xp - consumed) / need));
  }

  /**
   * Recomputes level-derived attributes. Health is scaled proportionally so
   * that gaining a level or investing in Max Health never feels like a nerf.
   */
  recompute(resetHealth = false): void {
    const previousMax = this.maxHealth;
    const previousRatio = previousMax > 0 ? this.health / previousMax : 1;

    this.level = levelForXp(this.xp);
    this.radius = BASE_TANK_RADIUS * Math.pow(RADIUS_GROWTH, this.level - 1);
    this.maxHealth =
      (BASE_MAX_HEALTH + HEALTH_PER_LEVEL * (this.level - 1) + HEALTH_PER_UPGRADE * this.stats[1]) *
      this.def.health;
    this.damage = (BASE_BODY_DAMAGE + BODY_DAMAGE_PER_UPGRADE * this.stats[2]) * this.def.bodyDamage;

    if (resetHealth) this.health = this.maxHealth;
    else this.health = Math.min(this.maxHealth, previousRatio * this.maxHealth);

    const spent = this.stats.reduce((a, b) => a + b, 0);
    this.statPoints = Math.max(0, statPointsForLevel(this.level) - spent);

    if (this.cooldowns.length !== this.barrels.length) {
      this.cooldowns = this.barrels.map((b) => b.delay * this.reloadCycle * b.reload);
    }
  }

  /** Invests one point into `statIndex`. Returns whether it was applied. */
  investStat(statIndex: number): boolean {
    if (statIndex < 0 || statIndex >= this.stats.length) return false;
    if (this.statPoints <= 0) return false;
    if (this.stats[statIndex] >= MAX_STAT_LEVEL) return false;
    this.stats[statIndex] += 1;
    this.recompute();
    return true;
  }

  addXp(amount: number, rankedScoring: boolean): void {
    if (amount <= 0) return;
    if (this.xp >= this.xpCap) return;
    amount = Math.min(amount, this.xpCap - this.xp);
    this.xp += amount;
    if (rankedScoring) this.matchScore += amount;
    this.recompute();
  }

  /** Resets the tank for a fresh life at the given spawn point. */
  respawn(x: number, y: number, now: number): void {
    this.x = x;
    this.y = y;
    this.spawnX = x;
    this.spawnY = y;
    this.vx = 0;
    this.vy = 0;
    this.ix = 0;
    this.iy = 0;
    this.xp = 0;
    this.stats = emptyStats();
    this.classKey = 'basic';
    this.cooldowns = [0];
    this.contactCooldown.clear();
    this.dead = false;
    this.spawnedAt = now;
    this.lastDamagedAt = -999;
    this.recompute(true);
  }
}

/** Muzzle position and bullet parameters for one barrel of a tank. */
export function computeShot(tank: Tank, barrel: Barrel) {
  const dir = tank.angle + barrel.angle;
  const cos = Math.cos(dir);
  const sin = Math.sin(dir);
  const forward = barrel.length * tank.radius;
  const lateral = barrel.offset * tank.radius;

  const spread = ((Math.random() - 0.5) * barrel.scatter * Math.PI) / 180;
  const shotDir = dir + spread;

  const speed =
    BASE_BULLET_SPEED * barrel.speed * bulletSpeedMultiplier(tank.stats[3]);
  const radius = Math.max(3, barrel.width * tank.radius * 0.5 * barrel.bulletSize);
  const damage = BASE_BULLET_DAMAGE * barrel.damage * bulletDamageMultiplier(tank.stats[5]);
  const health = BASE_BULLET_HEALTH * barrel.health * bulletHealthMultiplier(tank.stats[4]);

  return {
    x: tank.x + cos * forward - sin * lateral,
    y: tank.y + sin * forward + cos * lateral,
    vx: Math.cos(shotDir) * speed,
    vy: Math.sin(shotDir) * speed,
    radius,
    damage,
    health,
    /** Impulse pushed back into the shooter. */
    recoilX: -cos * speed * RECOIL_FACTOR * barrel.recoil * (radius / tank.radius),
    recoilY: -sin * speed * RECOIL_FACTOR * barrel.recoil * (radius / tank.radius),
  };
}

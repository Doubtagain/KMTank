import {
  ACT_AUTOFIRE,
  ACT_AUTOSPIN,
  ACT_FIRE,
  BODY_DAMAGE_COOLDOWN,
  BinaryWriter,
  CASUAL_ROOM_CAP,
  COAST_DECAY,
  DRIVE_RESPONSE,
  DT,
  MOVE_DOWN,
  MOVE_LEFT,
  MOVE_RIGHT,
  MOVE_UP,
  RANKED_COUNTDOWN_SECONDS,
  RANKED_DEATH_SCORE_PENALTY,
  RANKED_MAX_PLAYERS,
  REGEN_DELAY,
  IMPULSE_DECAY,
  RESPAWN_DELAY,
  SEPARATION_FORCE,
  SHAPE_TARGET_COUNT,
  SHAPE_SPEED,
  SPAWN_PROTECTION,
  SPAWN_PROTECTION_BREAK_DIST,
  TANK_CLASSES,
  TANK_FLAG_BOT,
  TANK_FLAG_INVULNERABLE,
  TANK_FLAG_SELF,
  VIEW_RADIUS,
  WORLD_SIZE,
  availableUpgrades,
  canUpgradeTo,
  totalXpForLevel,
  writeBullet,
  writeShape,
  writeSnapshotHeader,
  writeTank,
  type GameMode,
  type PlayerInfo,
  type ServerMessage,
} from '@kmtank/shared';

import { SpatialHash, type Circle, circlesOverlap, distanceSq } from './spatial.js';
import {
  Bullet,
  Shape,
  Tank,
  computeShot,
  pickShapeSpec,
  type Damageable,
} from './entities.js';
import { forgetBot, updateBot } from './bot.js';
import { config } from '../config.js';

/** Anything the room needs from a connected socket. */
export interface RoomClient {
  tankId: number;
  /** Persisted account id, or null for guests. */
  userId: string | null;
  name: string;
  sendJson(message: ServerMessage): void;
  sendBinary(data: Uint8Array): void;
}

export type MatchPhase = 'waiting' | 'countdown' | 'live' | 'ended';

/** One player's contribution to a ranked match, kept even after they leave. */
export interface Participant {
  userId: string;
  name: string;
  score: number;
  kills: number;
  deaths: number;
  /** False once the socket has gone away. */
  present: boolean;
}

export interface RoomOptions {
  id: string;
  mode: GameMode;
  botTarget: number;
  /** Called once a ranked match is over and results are final. */
  onMatchEnd?: (room: Room, participants: Participant[]) => void;
  /** Called when the room has no human players left and can be reclaimed. */
  onEmpty?: (room: Room) => void;
}

const MAX_ENTITY_ID = 65535;

/** Level ceiling range for AI tanks; each bot picks one on spawn. */
const BOT_LEVEL_MIN = 14;
const BOT_LEVEL_MAX = 30;

export class Room {
  readonly id: string;
  readonly mode: GameMode;

  tick = 0;
  /** Seconds of simulated time since the room was created. */
  time = 0;

  phase: MatchPhase;
  /** Simulated time at which the current phase ends; Infinity for casual. */
  phaseEndsAt = Infinity;

  readonly tanks = new Map<number, Tank>();
  readonly bullets = new Map<number, Bullet>();
  readonly shapes = new Map<number, Shape>();
  readonly clients = new Map<number, RoomClient>();

  /** Ranked bookkeeping, keyed by account id. */
  readonly participants = new Map<string, Participant>();

  private readonly hash = new SpatialHash<Circle & Damageable>();
  private readonly queryBuffer: (Circle & Damageable)[] = [];
  private nextId = 1;
  private readonly freeIds: number[] = [];
  private nextColor = 0;
  private leaderboardTimer = 0;
  private readonly botTarget: number;
  private readonly onMatchEnd?: (room: Room, participants: Participant[]) => void;
  private readonly onEmpty?: (room: Room) => void;
  private ended = false;

  constructor(options: RoomOptions) {
    this.id = options.id;
    this.mode = options.mode;
    this.botTarget = options.botTarget;
    this.onMatchEnd = options.onMatchEnd;
    this.onEmpty = options.onEmpty;
    this.phase = options.mode === 'casual' ? 'live' : 'countdown';
    if (options.mode === 'ranked') this.phaseEndsAt = RANKED_COUNTDOWN_SECONDS;

    for (let i = 0; i < SHAPE_TARGET_COUNT; i++) this.spawnShape();
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  get capacity(): number {
    return this.mode === 'casual' ? CASUAL_ROOM_CAP : RANKED_MAX_PLAYERS;
  }

  get humanCount(): number {
    return this.clients.size;
  }

  get isFull(): boolean {
    return this.humanCount >= this.capacity;
  }

  private allocateId(): number {
    const recycled = this.freeIds.pop();
    if (recycled !== undefined) return recycled;
    if (this.nextId > MAX_ENTITY_ID) throw new Error('room entity id space exhausted');
    return this.nextId++;
  }

  private releaseId(id: number): void {
    this.freeIds.push(id);
  }

  /** Creates a tank for a connecting player and returns its entity id. */
  addPlayer(name: string, userId: string | null): Tank {
    const tank = new Tank(this.allocateId(), name, this.nextColor++ % 8, false, userId);
    const spawn = this.findSpawnPoint();
    tank.respawn(spawn.x, spawn.y, this.time);
    tank.protectedUntil = this.time + SPAWN_PROTECTION;
    this.tanks.set(tank.id, tank);

    if (this.mode === 'ranked' && userId) {
      if (!this.participants.has(userId)) {
        this.participants.set(userId, {
          userId,
          name,
          score: 0,
          kills: 0,
          deaths: 0,
          present: true,
        });
      } else {
        this.participants.get(userId)!.present = true;
      }
    }
    return tank;
  }

  attachClient(client: RoomClient): void {
    this.clients.set(client.tankId, client);
  }

  removePlayer(tankId: number): void {
    const tank = this.tanks.get(tankId);
    if (tank && this.mode === 'ranked' && tank.userId) {
      const participant = this.participants.get(tank.userId);
      if (participant) {
        participant.score = Math.max(participant.score, Math.round(tank.matchScore));
        participant.kills = tank.kills;
        participant.deaths = tank.deaths;
        participant.present = false;
      }
    }
    if (tank) {
      this.tanks.delete(tankId);
      this.releaseId(tankId);
    }
    this.clients.delete(tankId);

    if (this.humanCount === 0) this.onEmpty?.(this);
  }

  private addBot(): void {
    const tank = new Tank(this.allocateId(), randomBotName(), this.nextColor++ % 8, true);
    const spawn = this.findSpawnPoint();
    tank.respawn(spawn.x, spawn.y, this.time);
    tank.protectedUntil = this.time + SPAWN_PROTECTION;
    // Each bot is capped at its own ceiling, so the room keeps a spread of
    // levels instead of converging on a wall of level-45 AI.
    tank.xpCap = totalXpForLevel(BOT_LEVEL_MIN + Math.floor(Math.random() * (BOT_LEVEL_MAX - BOT_LEVEL_MIN + 1)));
    tank.addXp(totalXpForLevel(1 + Math.floor(Math.random() * 8)), false);
    this.tanks.set(tank.id, tank);
  }

  // -------------------------------------------------------------------------
  // Player commands
  // -------------------------------------------------------------------------

  setInput(tankId: number, move: number, actions: number, aim: number): void {
    const tank = this.tanks.get(tankId);
    if (!tank || tank.dead) return;
    tank.input.move = move;
    tank.input.actions = actions;
    tank.input.aim = aim;
  }

  upgradeStat(tankId: number, statIndex: number): void {
    const tank = this.tanks.get(tankId);
    if (!tank || tank.dead) return;
    if (tank.investStat(statIndex)) this.sendStatsTo(tank);
  }

  upgradeClass(tankId: number, classKey: string): void {
    const tank = this.tanks.get(tankId);
    if (!tank || tank.dead) return;
    if (!canUpgradeTo(tank.classKey, classKey, tank.level)) return;
    tank.classKey = classKey;
    tank.cooldowns = TANK_CLASSES[classKey].barrels.map(() => 0);
    tank.recompute();
    this.sendStatsTo(tank);
  }

  requestRespawn(tankId: number): void {
    const tank = this.tanks.get(tankId);
    if (!tank || !tank.dead) return;
    if (this.mode === 'ranked' && this.phase !== 'live') return;
    if (this.time - tank.diedAt < RESPAWN_DELAY) return;
    const spawn = this.findSpawnPoint();
    tank.respawn(spawn.x, spawn.y, this.time);
    tank.protectedUntil = this.time + SPAWN_PROTECTION;
    this.sendStatsTo(tank);
  }

  private sendStatsTo(tank: Tank): void {
    const client = this.clients.get(tank.id);
    client?.sendJson({
      t: 'stats',
      stats: [...tank.stats],
      statPoints: tank.statPoints,
      classKey: tank.classKey,
      upgrades: availableUpgrades(tank.classKey, tank.level),
    });
  }

  broadcast(message: ServerMessage): void {
    for (const client of this.clients.values()) client.sendJson(message);
  }

  rosterMessage(): ServerMessage {
    const players: PlayerInfo[] = [];
    for (const tank of this.tanks.values()) {
      players.push({
        id: tank.id,
        name: tank.name,
        userId: tank.userId,
        classKey: tank.classKey,
        level: tank.level,
        score: Math.round(tank.score),
        colorIndex: tank.colorIndex,
        mmr: null,
        rankLabel: null,
        bot: tank.isBot,
      });
    }
    return { t: 'roster', players };
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  step(): void {
    this.tick++;
    this.time += DT;

    this.advancePhase();
    this.maintainBots();
    this.maintainShapes();

    const inputsLive = this.phase === 'live';

    for (const tank of this.tanks.values()) {
      if (tank.dead) continue;
      if (tank.isBot && inputsLive) updateBot(this, tank);
      this.stepTank(tank, inputsLive);
    }

    this.stepShapes();
    this.stepBullets();

    this.rebuildHash();
    this.resolveBulletCollisions();
    this.resolveBodyCollisions();

    this.sweepDead();
    this.sendSnapshots();

    this.leaderboardTimer += DT;
    if (this.leaderboardTimer >= 0.5) {
      this.leaderboardTimer = 0;
      this.broadcastLeaderboard();
      this.broadcastMatchState();
    }
  }

  private advancePhase(): void {
    if (this.mode !== 'ranked' || this.ended) return;
    if (this.time < this.phaseEndsAt) return;

    if (this.phase === 'countdown') {
      this.phase = 'live';
      this.phaseEndsAt = this.time + config.rankedMatchSeconds;
      for (const tank of this.tanks.values()) tank.protectedUntil = this.time + SPAWN_PROTECTION;
    } else if (this.phase === 'live') {
      this.finishMatch();
    }
  }

  private finishMatch(): void {
    if (this.ended) return;
    this.ended = true;
    this.phase = 'ended';
    this.phaseEndsAt = Infinity;

    for (const tank of this.tanks.values()) {
      if (!tank.userId) continue;
      const participant = this.participants.get(tank.userId);
      if (!participant) continue;
      participant.score = Math.max(participant.score, Math.round(tank.matchScore));
      participant.kills = tank.kills;
      participant.deaths = tank.deaths;
    }
    this.onMatchEnd?.(this, [...this.participants.values()]);
  }

  /** Ends a ranked match early, e.g. when everyone has disconnected. */
  abortMatch(): void {
    if (this.mode === 'ranked') this.finishMatch();
  }

  private stepTank(tank: Tank, inputsLive: boolean): void {
    const move = inputsLive ? tank.input.move : 0;
    const actions = inputsLive ? tank.input.actions : 0;

    let dx = 0;
    let dy = 0;
    if (move & MOVE_LEFT) dx -= 1;
    if (move & MOVE_RIGHT) dx += 1;
    if (move & MOVE_UP) dy -= 1;
    if (move & MOVE_DOWN) dy += 1;
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      dx /= len;
      dy /= len;
    }

    const maxSpeed = tank.maxSpeed;
    if (len > 0) {
      const targetX = dx * maxSpeed;
      const targetY = dy * maxSpeed;
      const k = 1 - Math.exp(-DRIVE_RESPONSE * DT);
      tank.vx += (targetX - tank.vx) * k;
      tank.vy += (targetY - tank.vy) * k;
    } else {
      const decay = Math.exp(-COAST_DECAY * DT);
      tank.vx *= decay;
      tank.vy *= decay;
    }

    const impulseDecay = Math.exp(-IMPULSE_DECAY * DT);
    tank.ix *= impulseDecay;
    tank.iy *= impulseDecay;

    // Aim: autospin overrides the mouse.
    if (actions & ACT_AUTOSPIN) tank.angle += 2.4 * DT;
    else tank.angle = tank.input.aim;

    tank.x += (tank.vx + tank.ix) * DT;
    tank.y += (tank.vy + tank.iy) * DT;

    if (tank.x < tank.radius) {
      tank.x = tank.radius;
      tank.vx = Math.max(0, tank.vx);
      tank.ix = Math.max(0, tank.ix);
    } else if (tank.x > WORLD_SIZE - tank.radius) {
      tank.x = WORLD_SIZE - tank.radius;
      tank.vx = Math.min(0, tank.vx);
      tank.ix = Math.min(0, tank.ix);
    }
    if (tank.y < tank.radius) {
      tank.y = tank.radius;
      tank.vy = Math.max(0, tank.vy);
      tank.iy = Math.max(0, tank.iy);
    } else if (tank.y > WORLD_SIZE - tank.radius) {
      tank.y = WORLD_SIZE - tank.radius;
      tank.vy = Math.min(0, tank.vy);
      tank.iy = Math.min(0, tank.iy);
    }

    // Spawn protection lapses on aggression or once you have left the spawn.
    if (this.time < tank.protectedUntil) {
      const firing = (actions & (ACT_FIRE | ACT_AUTOFIRE)) !== 0;
      const travelled = distanceSq(tank.x, tank.y, tank.spawnX, tank.spawnY);
      if (firing || travelled > SPAWN_PROTECTION_BREAK_DIST ** 2) {
        tank.protectedUntil = 0;
      }
    }

    this.stepWeapons(tank, actions, inputsLive);

    if (this.time - tank.lastDamagedAt > REGEN_DELAY && tank.health < tank.maxHealth) {
      tank.health = Math.min(tank.maxHealth, tank.health + tank.regenPerSecond * DT);
    }

    for (const [key, until] of tank.contactCooldown) {
      if (this.time >= until) tank.contactCooldown.delete(key);
    }
  }

  private stepWeapons(tank: Tank, actions: number, inputsLive: boolean): void {
    const firing = inputsLive && (actions & (ACT_FIRE | ACT_AUTOFIRE)) !== 0;
    const barrels = tank.barrels;
    const cycle = tank.reloadCycle;

    if (tank.cooldowns.length !== barrels.length) {
      tank.cooldowns = barrels.map((b) => b.delay * cycle * b.reload);
    }

    for (let i = 0; i < barrels.length; i++) {
      const barrel = barrels[i];
      const barrelCycle = cycle * barrel.reload;
      if (!firing) {
        // Idle: park each barrel at its phase slot so alternation is preserved
        // and the first shot after a pause is instant for the lead barrel.
        tank.cooldowns[i] = barrel.delay * barrelCycle;
        continue;
      }
      tank.cooldowns[i] -= DT;
      if (tank.cooldowns[i] > 0) continue;
      tank.cooldowns[i] += barrelCycle;
      this.fire(tank, i);
    }
  }

  private fire(tank: Tank, barrelIndex: number): void {
    const barrel = tank.barrels[barrelIndex];
    const shot = computeShot(tank, barrel);
    const id = this.allocateId();
    const bullet = new Bullet(
      id,
      tank.id,
      shot.x,
      shot.y,
      shot.vx,
      shot.vy,
      shot.radius,
      shot.damage,
      shot.health,
      shot.health,
      tank.colorIndex,
    );
    this.bullets.set(id, bullet);
    tank.ix += shot.recoilX;
    tank.iy += shot.recoilY;
    if (this.time < tank.protectedUntil) tank.protectedUntil = 0;
  }

  private stepShapes(): void {
    for (const shape of this.shapes.values()) {
      shape.x += shape.vx * DT;
      shape.y += shape.vy * DT;
      shape.angle += shape.spin * DT;
      if (shape.x < shape.radius || shape.x > WORLD_SIZE - shape.radius) {
        shape.vx *= -1;
        shape.x = Math.max(shape.radius, Math.min(WORLD_SIZE - shape.radius, shape.x));
      }
      if (shape.y < shape.radius || shape.y > WORLD_SIZE - shape.radius) {
        shape.vy *= -1;
        shape.y = Math.max(shape.radius, Math.min(WORLD_SIZE - shape.radius, shape.y));
      }
    }
  }

  private stepBullets(): void {
    for (const bullet of this.bullets.values()) {
      bullet.x += bullet.vx * DT;
      bullet.y += bullet.vy * DT;
      bullet.life -= DT;
      if (
        bullet.life <= 0 ||
        bullet.x < 0 ||
        bullet.y < 0 ||
        bullet.x > WORLD_SIZE ||
        bullet.y > WORLD_SIZE
      ) {
        bullet.dead = true;
      }
    }
  }

  private rebuildHash(): void {
    this.hash.clear();
    for (const tank of this.tanks.values()) if (!tank.dead) this.hash.insert(tank);
    for (const bullet of this.bullets.values()) if (!bullet.dead) this.hash.insert(bullet);
    for (const shape of this.shapes.values()) if (!shape.dead) this.hash.insert(shape);
  }

  private resolveBulletCollisions(): void {
    for (const bullet of this.bullets.values()) {
      if (bullet.dead) continue;
      const candidates = this.hash.query(bullet.x, bullet.y, bullet.radius, this.queryBuffer);
      for (const other of candidates) {
        if (bullet.dead) break;
        if (other === bullet || other.dead) continue;
        if (other.kind === 'bullet') {
          const otherBullet = other as Bullet;
          // Own bullets pass through each other; resolve each pair once.
          if (otherBullet.ownerId === bullet.ownerId) continue;
          if (otherBullet.id < bullet.id) continue;
        } else if (other.kind === 'tank') {
          const tank = other as Tank;
          if (tank.id === bullet.ownerId) continue;
          if (this.time < tank.protectedUntil) continue;
        }
        if (!circlesOverlap(bullet, other)) continue;
        this.exchangeDamage(bullet, other);
      }
    }
  }

  private resolveBodyCollisions(): void {
    for (const tank of this.tanks.values()) {
      if (tank.dead) continue;
      const candidates = this.hash.query(tank.x, tank.y, tank.radius, this.queryBuffer);
      for (const other of candidates) {
        if (other === tank || other.dead || other.kind === 'bullet') continue;
        if (other.kind === 'tank' && other.id < tank.id) continue;
        if (!circlesOverlap(tank, other)) continue;

        this.separate(tank, other);

        const otherTank = other.kind === 'tank' ? (other as Tank) : null;
        if (this.time < tank.protectedUntil) continue;
        if (otherTank && this.time < otherTank.protectedUntil) continue;

        const ready = (tank.contactCooldown.get(other.id) ?? 0) <= this.time;
        if (!ready) continue;
        tank.contactCooldown.set(other.id, this.time + BODY_DAMAGE_COOLDOWN);
        otherTank?.contactCooldown.set(tank.id, this.time + BODY_DAMAGE_COOLDOWN);
        this.exchangeDamage(tank, other);
      }
    }
  }

  /** Pushes two overlapping bodies apart, heavier bodies moving less. */
  private separate(tank: Tank, other: Damageable & Circle): void {
    let dx = tank.x - other.x;
    let dy = tank.y - other.y;
    let dist = Math.hypot(dx, dy);
    if (dist === 0) {
      dx = Math.random() - 0.5;
      dy = Math.random() - 0.5;
      dist = Math.hypot(dx, dy) || 1;
    }
    const overlap = tank.radius + other.radius - dist;
    if (overlap <= 0) return;
    const nx = dx / dist;
    const ny = dy / dist;

    const otherMass = other.radius * other.radius;
    const selfMass = tank.radius * tank.radius;
    const total = selfMass + otherMass;

    tank.ix += nx * overlap * SEPARATION_FORCE * (otherMass / total);
    tank.iy += ny * overlap * SEPARATION_FORCE * (otherMass / total);

    if (other.kind === 'tank') {
      const otherTank = other as Tank;
      otherTank.ix -= nx * overlap * SEPARATION_FORCE * (selfMass / total);
      otherTank.iy -= ny * overlap * SEPARATION_FORCE * (selfMass / total);
    } else if (other.kind === 'shape') {
      const shape = other as Shape;
      shape.vx -= nx * overlap * SEPARATION_FORCE * (selfMass / total) * 0.3;
      shape.vy -= ny * overlap * SEPARATION_FORCE * (selfMass / total) * 0.3;
    }
  }

  /** Both bodies subtract the other's contact damage; either may die. */
  private exchangeDamage(a: Damageable, b: Damageable): void {
    const damageToB = a.damage;
    const damageToA = b.damage;
    this.applyDamage(b, damageToB, this.attributionFor(a));
    this.applyDamage(a, damageToA, this.attributionFor(b));
  }

  /** Which tank should be credited for damage dealt by `source`. */
  private attributionFor(source: Damageable): number {
    if (source.kind === 'bullet') return (source as Bullet).ownerId;
    if (source.kind === 'tank') return source.id;
    return 0;
  }

  private applyDamage(target: Damageable, amount: number, killerId: number): void {
    if (target.dead || amount <= 0) return;
    if (target.kind === 'tank') {
      const tank = target as Tank;
      if (this.time < tank.protectedUntil) return;
      tank.lastDamagedAt = this.time;
    }
    target.health -= amount;
    if (target.health <= 0) this.destroy(target, killerId);
  }

  private destroy(target: Damageable, killerId: number): void {
    if (target.dead) return;
    target.dead = true;
    const killer = this.tanks.get(killerId);

    if (target.kind === 'shape') {
      killer?.addXp((target as Shape).xp, this.mode === 'ranked');
      return;
    }
    if (target.kind === 'bullet') return;

    const victim = target as Tank;
    victim.diedAt = this.time;
    victim.deaths += 1;

    if (this.mode === 'ranked') {
      victim.matchScore = Math.max(0, victim.matchScore - victim.xp * RANKED_DEATH_SCORE_PENALTY);
      const participant = victim.userId ? this.participants.get(victim.userId) : undefined;
      if (participant) {
        participant.score = Math.round(victim.matchScore);
        participant.deaths = victim.deaths;
      }
    }

    if (killer && killer !== victim) {
      killer.kills += 1;
      killer.addXp(20 + victim.xp * 0.35, this.mode === 'ranked');
      if (this.mode === 'ranked' && killer.userId) {
        const participant = this.participants.get(killer.userId);
        if (participant) {
          participant.kills = killer.kills;
          participant.score = Math.round(killer.matchScore);
        }
      }
      this.broadcast({ t: 'kill', killerName: killer.name, victimName: victim.name });
    }

    const client = this.clients.get(victim.id);
    client?.sendJson({
      t: 'killed',
      killerId: killer?.id ?? 0,
      killerName: killer && killer !== victim ? killer.name : 'the arena',
      score: Math.round(victim.score),
      level: victim.level,
      survivedSeconds: Math.round(this.time - victim.spawnedAt),
      canRespawn: this.mode === 'casual' || this.phase === 'live',
      respawnInSeconds: RESPAWN_DELAY,
    });
  }

  private sweepDead(): void {
    for (const [id, bullet] of this.bullets) {
      if (bullet.dead) {
        this.bullets.delete(id);
        this.releaseId(id);
      }
    }
    for (const [id, shape] of this.shapes) {
      if (shape.dead) {
        this.shapes.delete(id);
        this.releaseId(id);
      }
    }
    // Dead tanks stay resident so the player keeps a camera and can respawn.
    for (const [id, tank] of this.tanks) {
      if (tank.dead && tank.isBot && this.time - tank.diedAt > RESPAWN_DELAY) {
        this.tanks.delete(id);
        this.releaseId(id);
        forgetBot(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // World upkeep
  // -------------------------------------------------------------------------

  private spawnShape(): void {
    const spec = pickShapeSpec();
    const id = this.allocateId();
    const shape = new Shape(
      id,
      spec.radius + Math.random() * (WORLD_SIZE - spec.radius * 2),
      spec.radius + Math.random() * (WORLD_SIZE - spec.radius * 2),
      spec,
    );
    const dir = Math.random() * Math.PI * 2;
    shape.vx = Math.cos(dir) * SHAPE_SPEED;
    shape.vy = Math.sin(dir) * SHAPE_SPEED;
    this.shapes.set(id, shape);
  }

  private maintainShapes(): void {
    let budget = 4;
    while (this.shapes.size < SHAPE_TARGET_COUNT && budget-- > 0) this.spawnShape();
  }

  private maintainBots(): void {
    if (this.mode !== 'casual' || this.botTarget <= 0) return;
    let bots = 0;
    for (const tank of this.tanks.values()) if (tank.isBot) bots++;
    // Thin out the bots as real players arrive.
    const wanted = Math.max(0, Math.min(this.botTarget, this.botTarget - this.humanCount + 2));
    if (bots < wanted) this.addBot();
  }

  /** A spot far from every live tank, so nobody spawns inside a fight. */
  private findSpawnPoint(): { x: number; y: number } {
    const margin = 200;
    let best = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
    let bestDist = -1;
    for (let attempt = 0; attempt < 12; attempt++) {
      const x = margin + Math.random() * (WORLD_SIZE - margin * 2);
      const y = margin + Math.random() * (WORLD_SIZE - margin * 2);
      let nearest = Infinity;
      for (const tank of this.tanks.values()) {
        if (tank.dead) continue;
        nearest = Math.min(nearest, distanceSq(x, y, tank.x, tank.y));
      }
      if (nearest > bestDist) {
        bestDist = nearest;
        best = { x, y };
      }
      if (nearest > 900 * 900) break;
    }
    return best;
  }

  /** Camera radius for a tank; snipers and high levels see further. */
  viewRadiusFor(tank: Tank): number {
    return VIEW_RADIUS * tank.def.fov * (1 + (tank.level - 1) * 0.005);
  }

  // -------------------------------------------------------------------------
  // Outbound state
  // -------------------------------------------------------------------------

  private sendSnapshots(): void {
    for (const [tankId, client] of this.clients) {
      const tank = this.tanks.get(tankId);
      if (!tank) continue;
      client.sendBinary(this.buildSnapshot(tank));
    }
  }

  private buildSnapshot(viewer: Tank): Uint8Array {
    const writer = new BinaryWriter(8192);
    const upgrades = availableUpgrades(viewer.classKey, viewer.level);
    const countOffset = writeSnapshotHeader(writer, this.tick, {
      id: viewer.id,
      score: Math.round(viewer.score),
      level: viewer.level,
      xpProgress: viewer.xpProgress,
      statPoints: viewer.statPoints,
      stats: viewer.stats,
      classId: viewer.def.id,
      health: viewer.health,
      maxHealth: viewer.maxHealth,
      alive: !viewer.dead,
      classUpgradeAvailable: upgrades.length > 0,
    });

    const radius = this.viewRadiusFor(viewer);
    const cx = viewer.x;
    const cy = viewer.y;
    let count = 0;

    for (const tank of this.tanks.values()) {
      if (tank.dead) continue;
      const cull = radius + tank.radius;
      if (distanceSq(cx, cy, tank.x, tank.y) > cull * cull) continue;
      writeTank(writer, {
        id: tank.id,
        x: tank.x,
        y: tank.y,
        angle: tank.angle,
        radius: tank.radius,
        healthPct: tank.maxHealth > 0 ? tank.health / tank.maxHealth : 0,
        classId: tank.def.id,
        level: tank.level,
        colorIndex: tank.colorIndex,
        flags:
          (this.time < tank.protectedUntil ? TANK_FLAG_INVULNERABLE : 0) |
          (tank.id === viewer.id ? TANK_FLAG_SELF : 0) |
          (tank.isBot ? TANK_FLAG_BOT : 0),
      });
      count++;
    }

    for (const bullet of this.bullets.values()) {
      if (bullet.dead) continue;
      const cull = radius + bullet.radius;
      if (distanceSq(cx, cy, bullet.x, bullet.y) > cull * cull) continue;
      writeBullet(writer, {
        id: bullet.id,
        x: bullet.x,
        y: bullet.y,
        radius: bullet.radius,
        colorIndex: bullet.colorIndex,
      });
      count++;
    }

    for (const shape of this.shapes.values()) {
      if (shape.dead) continue;
      const cull = radius + shape.radius;
      if (distanceSq(cx, cy, shape.x, shape.y) > cull * cull) continue;
      writeShape(writer, {
        id: shape.id,
        x: shape.x,
        y: shape.y,
        angle: shape.angle,
        radius: shape.radius,
        healthPct: shape.maxHealth > 0 ? shape.health / shape.maxHealth : 0,
        sides: shape.sides,
      });
      count++;
    }

    writer.patchU16(countOffset, count);
    return writer.finish();
  }

  private broadcastLeaderboard(): void {
    const ranked = [...this.tanks.values()]
      .filter((t) => !t.dead)
      .sort((a, b) => this.displayScore(b) - this.displayScore(a))
      .slice(0, 10)
      .map((t) => ({
        id: t.id,
        name: t.name,
        score: Math.round(this.displayScore(t)),
        classKey: t.classKey,
      }));
    this.broadcast({ t: 'leaderboard', entries: ranked });
  }

  private displayScore(tank: Tank): number {
    return this.mode === 'ranked' ? tank.matchScore : tank.score;
  }

  private broadcastMatchState(): void {
    if (this.mode !== 'ranked') return;
    const phase = this.phase === 'waiting' ? 'countdown' : this.phase;
    this.broadcast({
      t: 'match',
      phase: phase as 'countdown' | 'live' | 'ended',
      secondsLeft: Math.max(0, Math.round(this.phaseEndsAt - this.time)),
      elapsed: Math.round(this.time),
    });
  }
}

const BOT_NAMES = [
  'Rustbucket', 'Kimchi', 'Bulldozer', 'Pixel', 'Nomad', 'Turret', 'Havoc', 'Scrapheap',
  'Volt', 'Mantis', 'Cobalt', 'Dozer', 'Pepper', 'Onyx', 'Sable', 'Quartz', 'Hornet',
  'Drift', 'Ember', 'Gremlin', 'Comet', 'Basalt',
];

function randomBotName(): string {
  const base = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
  return `${base}${Math.floor(Math.random() * 90) + 10}`;
}

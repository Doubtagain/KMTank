import {
  BASE_MAX_SPEED,
  COAST_DECAY,
  DRIVE_RESPONSE,
  INTERP_DELAY_MS,
  MOVE_DOWN,
  MOVE_LEFT,
  MOVE_RIGHT,
  MOVE_UP,
  TANK_CLASS_BY_ID,
  TANK_CLASSES,
  WORLD_SIZE,
  speedMultiplier,
  type BulletView,
  type EntityView,
  type SelfState,
  type ShapeView,
  type Snapshot,
  type TankView,
} from '@kmtank/shared';

interface Frame {
  receivedAt: number;
  snapshot: Snapshot;
  byId: Map<number, EntityView>;
}

export interface SampledWorld {
  tanks: TankView[];
  bullets: BulletView[];
  shapes: ShapeView[];
  self: SelfState | null;
}

const MAX_FRAMES = 24;
const TAU = Math.PI * 2;

/** Interpolates an angle along the shortest arc. */
function lerpAngle(a: number, b: number, t: number): number {
  let delta = ((b - a) % TAU + TAU + Math.PI) % TAU - Math.PI;
  return a + delta * t;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Rolling snapshot buffer.
 *
 * Everything except the local tank is rendered `INTERP_DELAY_MS` in the past
 * and interpolated between the two surrounding snapshots, which hides jitter
 * without ever inventing state the server did not send.
 */
export class WorldView {
  private readonly frames: Frame[] = [];
  /** Most recent authoritative self-state, never interpolated. */
  self: SelfState | null = null;
  latestTick = 0;

  push(snapshot: Snapshot): void {
    const byId = new Map<number, EntityView>();
    for (const entity of snapshot.entities) byId.set(entity.id, entity);
    this.frames.push({ receivedAt: performance.now(), snapshot, byId });
    if (this.frames.length > MAX_FRAMES) this.frames.shift();
    this.self = snapshot.self;
    this.latestTick = snapshot.tick;
  }

  clear(): void {
    this.frames.length = 0;
    this.self = null;
    this.latestTick = 0;
  }

  get hasData(): boolean {
    return this.frames.length > 0;
  }

  /** Interpolated view of the world as of `INTERP_DELAY_MS` ago. */
  sample(now: number): SampledWorld {
    const result: SampledWorld = { tanks: [], bullets: [], shapes: [], self: this.self };
    if (this.frames.length === 0) return result;

    const renderTime = now - INTERP_DELAY_MS;

    let older: Frame | null = null;
    let newer: Frame | null = null;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].receivedAt <= renderTime) {
        older = this.frames[i];
        newer = this.frames[i + 1] ?? null;
        break;
      }
    }

    // Not enough history yet, or the buffer has run dry: show the newest frame.
    if (!older) {
      older = this.frames[0];
      newer = this.frames[1] ?? null;
    }

    const span = newer ? newer.receivedAt - older.receivedAt : 0;
    const t = span > 0 ? Math.max(0, Math.min(1, (renderTime - older.receivedAt) / span)) : 1;
    const base = newer ?? older;

    for (const entity of base.snapshot.entities) {
      const previous = newer ? older.byId.get(entity.id) : undefined;
      if (entity.kind === 0) {
        const from = previous?.kind === 0 ? previous : entity;
        result.tanks.push({
          ...entity,
          x: lerp(from.x, entity.x, t),
          y: lerp(from.y, entity.y, t),
          angle: lerpAngle(from.angle, entity.angle, t),
          radius: lerp(from.radius, entity.radius, t),
          healthPct: lerp(from.healthPct, entity.healthPct, t),
        });
      } else if (entity.kind === 1) {
        const from = previous?.kind === 1 ? previous : entity;
        result.bullets.push({
          ...entity,
          x: lerp(from.x, entity.x, t),
          y: lerp(from.y, entity.y, t),
        });
      } else {
        const from = previous?.kind === 2 ? previous : entity;
        result.shapes.push({
          ...entity,
          x: lerp(from.x, entity.x, t),
          y: lerp(from.y, entity.y, t),
          angle: lerpAngle(from.angle, entity.angle, t),
          healthPct: lerp(from.healthPct, entity.healthPct, t),
        });
      }
    }

    return result;
  }
}

/**
 * Local movement prediction.
 *
 * Runs the same drive model as the server so the local tank responds on the
 * frame the key is pressed, then eases towards the authoritative position on
 * every snapshot. Collisions and knockback are not predicted; the correction
 * term absorbs them.
 */
export class LocalPredictor {
  x = 0;
  y = 0;
  private vx = 0;
  private vy = 0;
  private initialised = false;

  /** Fraction of the remaining error corrected per snapshot. */
  private static readonly CORRECTION = 0.28;
  /** Beyond this much error, the prediction is abandoned and snapped. */
  private static readonly SNAP_DISTANCE = 260;

  reset(): void {
    this.initialised = false;
    this.vx = 0;
    this.vy = 0;
  }

  /** Folds an authoritative position into the prediction. */
  reconcile(serverX: number, serverY: number): void {
    if (!this.initialised) {
      this.x = serverX;
      this.y = serverY;
      this.initialised = true;
      return;
    }
    const dx = serverX - this.x;
    const dy = serverY - this.y;
    if (Math.hypot(dx, dy) > LocalPredictor.SNAP_DISTANCE) {
      this.x = serverX;
      this.y = serverY;
      this.vx = 0;
      this.vy = 0;
      return;
    }
    this.x += dx * LocalPredictor.CORRECTION;
    this.y += dy * LocalPredictor.CORRECTION;
  }

  step(dt: number, move: number, self: SelfState | null): void {
    if (!this.initialised || !self) return;

    let dx = 0;
    let dy = 0;
    if (move & MOVE_LEFT) dx -= 1;
    if (move & MOVE_RIGHT) dx += 1;
    if (move & MOVE_UP) dy -= 1;
    if (move & MOVE_DOWN) dy += 1;
    const length = Math.hypot(dx, dy);

    const maxSpeed = predictedMaxSpeed(self);
    if (length > 0) {
      const k = 1 - Math.exp(-DRIVE_RESPONSE * dt);
      this.vx += ((dx / length) * maxSpeed - this.vx) * k;
      this.vy += ((dy / length) * maxSpeed - this.vy) * k;
    } else {
      const decay = Math.exp(-COAST_DECAY * dt);
      this.vx *= decay;
      this.vy *= decay;
    }

    this.x = Math.max(0, Math.min(WORLD_SIZE, this.x + this.vx * dt));
    this.y = Math.max(0, Math.min(WORLD_SIZE, this.y + this.vy * dt));
  }
}

/** Top speed derived from the authoritative stat vector, matching the server. */
export function predictedMaxSpeed(self: SelfState): number {
  const key = TANK_CLASS_BY_ID[self.classId] ?? 'basic';
  const def = TANK_CLASSES[key] ?? TANK_CLASSES.basic;
  return BASE_MAX_SPEED * speedMultiplier(self.stats[7] ?? 0) * def.speed * Math.pow(0.995, self.level - 1);
}

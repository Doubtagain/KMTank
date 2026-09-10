/**
 * Binary codec for the hot path.
 *
 * Everything is little-endian. World coordinates are quantised to u16 across
 * `WORLD_SIZE` (~0.09 world units of precision) and angles to u16 across a full
 * turn, which keeps a busy snapshot of ~200 entities under 2.5 KB.
 */

import { WORLD_SIZE } from './constants.js';
import { BINARY_INPUT, BINARY_SNAPSHOT, type InputFrame } from './protocol.js';
import { STAT_COUNT } from './stats.js';

export const ENTITY_TANK = 0;
export const ENTITY_BULLET = 1;
export const ENTITY_SHAPE = 2;

/** Tank render flags. */
export const TANK_FLAG_INVULNERABLE = 1 << 0;
export const TANK_FLAG_SELF = 1 << 1;
export const TANK_FLAG_BOT = 1 << 2;

/** Self flags in the snapshot header. */
export const SELF_FLAG_ALIVE = 1 << 0;
export const SELF_FLAG_CLASS_UPGRADE = 1 << 1;

const TAU = Math.PI * 2;
const POS_SCALE = 65535 / WORLD_SIZE;
const ANGLE_SCALE = 65535 / TAU;
const RADIUS_SCALE = 8;

const clampU16 = (v: number): number => (v < 0 ? 0 : v > 65535 ? 65535 : v | 0);

export const encodePos = (v: number): number => clampU16(Math.round(v * POS_SCALE));
export const decodePos = (v: number): number => v / POS_SCALE;
export const encodeAngle = (a: number): number => {
  let n = a % TAU;
  if (n < 0) n += TAU;
  return clampU16(Math.round(n * ANGLE_SCALE));
};
export const decodeAngle = (v: number): number => v / ANGLE_SCALE;

// ---------------------------------------------------------------------------
// Buffer helpers
// ---------------------------------------------------------------------------

export class BinaryWriter {
  private view: DataView;
  private bytes: Uint8Array;
  private cursor = 0;

  constructor(initialSize = 4096) {
    this.bytes = new Uint8Array(initialSize);
    this.view = new DataView(this.bytes.buffer);
  }

  private ensure(extra: number): void {
    if (this.cursor + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.cursor + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes);
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.cursor, v & 0xff);
    this.cursor += 1;
  }

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.cursor, v & 0xffff, true);
    this.cursor += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.cursor, v >>> 0, true);
    this.cursor += 4;
  }

  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.cursor, v, true);
    this.cursor += 4;
  }

  /** Overwrite a u16 already written at `offset`. Used to backfill counts. */
  patchU16(offset: number, v: number): void {
    this.view.setUint16(offset, v & 0xffff, true);
  }

  get offset(): number {
    return this.cursor;
  }

  /** A copy of the written bytes, safe to hand to a socket. */
  finish(): Uint8Array {
    return this.bytes.slice(0, this.cursor);
  }
}

export class BinaryReader {
  private view: DataView;
  private cursor = 0;

  constructor(data: ArrayBuffer | Uint8Array) {
    this.view =
      data instanceof Uint8Array
        ? new DataView(data.buffer, data.byteOffset, data.byteLength)
        : new DataView(data);
  }

  u8(): number {
    const v = this.view.getUint8(this.cursor);
    this.cursor += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.cursor, true);
    this.cursor += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.cursor, true);
    this.cursor += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.cursor, true);
    this.cursor += 4;
    return v;
  }

  get remaining(): number {
    return this.view.byteLength - this.cursor;
  }
}

// ---------------------------------------------------------------------------
// Input frames (client -> server), 9 bytes
// ---------------------------------------------------------------------------

export function encodeInput(frame: InputFrame): Uint8Array {
  const w = new BinaryWriter(16);
  w.u8(BINARY_INPUT);
  w.u32(frame.seq);
  w.u8(frame.move);
  w.u8(frame.actions);
  w.u16(encodeAngle(frame.aim));
  return w.finish();
}

export function decodeInput(data: ArrayBuffer | Uint8Array): InputFrame | null {
  const r = new BinaryReader(data);
  if (r.remaining < 9) return null;
  if (r.u8() !== BINARY_INPUT) return null;
  return { seq: r.u32(), move: r.u8(), actions: r.u8(), aim: decodeAngle(r.u16()) };
}

// ---------------------------------------------------------------------------
// Snapshots (server -> client)
// ---------------------------------------------------------------------------

export interface SelfState {
  id: number;
  score: number;
  level: number;
  /** Progress towards the next level, 0..1. */
  xpProgress: number;
  statPoints: number;
  stats: number[];
  classId: number;
  health: number;
  maxHealth: number;
  alive: boolean;
  classUpgradeAvailable: boolean;
}

export interface TankView {
  kind: 0;
  id: number;
  x: number;
  y: number;
  angle: number;
  radius: number;
  healthPct: number;
  classId: number;
  level: number;
  colorIndex: number;
  flags: number;
}

export interface BulletView {
  kind: 1;
  id: number;
  x: number;
  y: number;
  radius: number;
  colorIndex: number;
}

export interface ShapeView {
  kind: 2;
  id: number;
  x: number;
  y: number;
  angle: number;
  radius: number;
  healthPct: number;
  sides: number;
}

export type EntityView = TankView | BulletView | ShapeView;

export interface Snapshot {
  tick: number;
  self: SelfState;
  entities: EntityView[];
}

/** Writes the fixed-size snapshot header. Entities follow. */
export function writeSnapshotHeader(w: BinaryWriter, tick: number, self: SelfState): number {
  w.u8(BINARY_SNAPSHOT);
  w.u32(tick);
  w.u16(self.id);
  w.u32(Math.max(0, Math.round(self.score)));
  w.u8(self.level);
  w.u16(clampU16(Math.round(self.xpProgress * 65535)));
  w.u8(self.statPoints);
  for (let i = 0; i < STAT_COUNT; i++) w.u8(self.stats[i] ?? 0);
  w.u8(self.classId);
  w.u16(clampU16(Math.round(Math.max(0, self.health))));
  w.u16(clampU16(Math.round(Math.max(0, self.maxHealth))));
  w.u8(
    (self.alive ? SELF_FLAG_ALIVE : 0) |
      (self.classUpgradeAvailable ? SELF_FLAG_CLASS_UPGRADE : 0),
  );
  const countOffset = w.offset;
  w.u16(0); // patched by the caller once entities are written
  return countOffset;
}

export function writeTank(w: BinaryWriter, t: Omit<TankView, 'kind'>): void {
  w.u8(ENTITY_TANK);
  w.u16(t.id);
  w.u16(encodePos(t.x));
  w.u16(encodePos(t.y));
  w.u16(encodeAngle(t.angle));
  w.u16(clampU16(Math.round(t.radius * RADIUS_SCALE)));
  w.u8(Math.round(Math.max(0, Math.min(1, t.healthPct)) * 255));
  w.u8(t.classId);
  w.u8(t.level);
  w.u8(t.colorIndex);
  w.u8(t.flags);
}

export function writeBullet(w: BinaryWriter, b: Omit<BulletView, 'kind'>): void {
  w.u8(ENTITY_BULLET);
  w.u16(b.id);
  w.u16(encodePos(b.x));
  w.u16(encodePos(b.y));
  w.u16(clampU16(Math.round(b.radius * RADIUS_SCALE)));
  w.u8(b.colorIndex);
}

export function writeShape(w: BinaryWriter, s: Omit<ShapeView, 'kind'>): void {
  w.u8(ENTITY_SHAPE);
  w.u16(s.id);
  w.u16(encodePos(s.x));
  w.u16(encodePos(s.y));
  w.u16(encodeAngle(s.angle));
  w.u16(clampU16(Math.round(s.radius * RADIUS_SCALE)));
  w.u8(Math.round(Math.max(0, Math.min(1, s.healthPct)) * 255));
  w.u8(s.sides);
}

export function decodeSnapshot(data: ArrayBuffer | Uint8Array): Snapshot | null {
  const r = new BinaryReader(data);
  if (r.remaining < 2) return null;
  if (r.u8() !== BINARY_SNAPSHOT) return null;

  const tick = r.u32();
  const id = r.u16();
  const score = r.u32();
  const level = r.u8();
  const xpProgress = r.u16() / 65535;
  const statPoints = r.u8();
  const stats: number[] = new Array(STAT_COUNT);
  for (let i = 0; i < STAT_COUNT; i++) stats[i] = r.u8();
  const classId = r.u8();
  const health = r.u16();
  const maxHealth = r.u16();
  const selfFlags = r.u8();
  const count = r.u16();

  const entities: EntityView[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const kind = r.u8();
    if (kind === ENTITY_TANK) {
      entities[i] = {
        kind: 0,
        id: r.u16(),
        x: decodePos(r.u16()),
        y: decodePos(r.u16()),
        angle: decodeAngle(r.u16()),
        radius: r.u16() / RADIUS_SCALE,
        healthPct: r.u8() / 255,
        classId: r.u8(),
        level: r.u8(),
        colorIndex: r.u8(),
        flags: r.u8(),
      };
    } else if (kind === ENTITY_BULLET) {
      entities[i] = {
        kind: 1,
        id: r.u16(),
        x: decodePos(r.u16()),
        y: decodePos(r.u16()),
        radius: r.u16() / RADIUS_SCALE,
        colorIndex: r.u8(),
      };
    } else if (kind === ENTITY_SHAPE) {
      entities[i] = {
        kind: 2,
        id: r.u16(),
        x: decodePos(r.u16()),
        y: decodePos(r.u16()),
        angle: decodeAngle(r.u16()),
        radius: r.u16() / RADIUS_SCALE,
        healthPct: r.u8() / 255,
        sides: r.u8(),
      };
    } else {
      // Unknown kind: the rest of the frame can no longer be parsed safely.
      return { tick, self: buildSelf(), entities: entities.slice(0, i) };
    }
  }

  function buildSelf(): SelfState {
    return {
      id,
      score,
      level,
      xpProgress,
      statPoints,
      stats,
      classId,
      health,
      maxHealth,
      alive: (selfFlags & SELF_FLAG_ALIVE) !== 0,
      classUpgradeAvailable: (selfFlags & SELF_FLAG_CLASS_UPGRADE) !== 0,
    };
  }

  return { tick, self: buildSelf(), entities };
}

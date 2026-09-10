import {
  ENEMY_COLOR,
  GRID_SIZE,
  SELF_COLOR,
  SHAPE_COLORS,
  TANK_CLASSES,
  TANK_CLASS_BY_ID,
  TANK_FLAG_INVULNERABLE,
  VIEW_RADIUS,
  WORLD_SIZE,
  type SelfState,
} from '@kmtank/shared';

import type { SampledWorld } from '../state/world.js';
import type { TouchStick } from '../input.js';

const ARENA_FILL = '#cdcdcd';
const OUTSIDE_FILL = '#b2b2b2';
const GRID_STROKE = 'rgba(0, 0, 0, 0.075)';
const BARREL_FILL = '#999999';
const OUTLINE_ALPHA = 0.22;
const HEALTH_FILL = '#85e37d';
const HEALTH_TRACK = 'rgba(0, 0, 0, 0.28)';

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface RenderContext {
  world: SampledWorld;
  self: SelfState | null;
  /** World position the camera is centred on. */
  cameraX: number;
  cameraY: number;
  /** Entity id -> display name, from the roster message. */
  names: Map<number, string>;
  selfId: number;
  /** Colour index assigned to the local player, used to tint own bullets. */
  selfColorIndex: number;
  stick: TouchStick;
  touchMode: boolean;
}

/** Darkens a hex colour, used for the consistent entity outlines. */
function outlineOf(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  const mix = (channel: number): number => Math.round(channel * (1 - OUTLINE_ALPHA));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

const OUTLINE_CACHE = new Map<string, string>();
function cachedOutline(hex: string): string {
  let cached = OUTLINE_CACHE.get(hex);
  if (!cached) {
    cached = outlineOf(hex);
    OUTLINE_CACHE.set(hex, cached);
  }
  return cached;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  readonly camera: Camera = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, scale: 1 };

  /** Timestamp until which the screen tints red after taking damage. */
  private hurtUntil = 0;
  private previousHealth = Infinity;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas is not available in this browser');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  /** Camera zoom so every player sees the same slice of world. */
  private computeScale(self: SelfState | null): number {
    const halfDiagonal = Math.hypot(this.width, this.height) / 2;
    const key = self ? TANK_CLASS_BY_ID[self.classId] ?? 'basic' : 'basic';
    const def = TANK_CLASSES[key] ?? TANK_CLASSES.basic;
    const level = self?.level ?? 1;
    const viewRadius = VIEW_RADIUS * def.fov * (1 + (level - 1) * 0.005);
    return halfDiagonal / viewRadius;
  }

  draw(context: RenderContext): void {
    const { ctx } = this;
    const now = performance.now();

    if (context.self) {
      if (context.self.health < this.previousHealth - 0.5) this.hurtUntil = now + 160;
      this.previousHealth = context.self.health;
    }

    this.camera.x = context.cameraX;
    this.camera.y = context.cameraY;
    this.camera.scale = this.computeScale(context.self);

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = OUTSIDE_FILL;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(this.camera.scale, this.camera.scale);
    ctx.translate(-this.camera.x, -this.camera.y);

    this.drawArena();
    this.drawShapes(context);
    this.drawBullets(context);
    this.drawTanks(context);

    ctx.restore();

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    if (now < this.hurtUntil) {
      ctx.fillStyle = `rgba(220, 60, 60, ${0.22 * ((this.hurtUntil - now) / 160)})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }
    this.drawMinimap(context);
    if (context.touchMode) this.drawStick(context.stick);
    ctx.restore();
  }

  /** The playable square plus its grid, clipped to the visible region. */
  private drawArena(): void {
    const { ctx } = this;
    const halfW = this.width / 2 / this.camera.scale;
    const halfH = this.height / 2 / this.camera.scale;
    const left = this.camera.x - halfW;
    const right = this.camera.x + halfW;
    const top = this.camera.y - halfH;
    const bottom = this.camera.y + halfH;

    ctx.fillStyle = ARENA_FILL;
    ctx.fillRect(
      Math.max(0, left),
      Math.max(0, top),
      Math.min(WORLD_SIZE, right) - Math.max(0, left),
      Math.min(WORLD_SIZE, bottom) - Math.max(0, top),
    );

    ctx.strokeStyle = GRID_STROKE;
    ctx.lineWidth = 1 / this.camera.scale;
    ctx.beginPath();
    const startX = Math.floor(left / GRID_SIZE) * GRID_SIZE;
    for (let x = startX; x <= right; x += GRID_SIZE) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    const startY = Math.floor(top / GRID_SIZE) * GRID_SIZE;
    for (let y = startY; y <= bottom; y += GRID_SIZE) {
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
  }

  private drawShapes(context: RenderContext): void {
    const { ctx } = this;
    for (const shape of context.world.shapes) {
      const color = SHAPE_COLORS[shape.sides] ?? '#ffe869';
      ctx.save();
      ctx.translate(shape.x, shape.y);
      ctx.rotate(shape.angle);
      ctx.beginPath();
      for (let i = 0; i < shape.sides; i++) {
        const angle = (i / shape.sides) * Math.PI * 2;
        const px = Math.cos(angle) * shape.radius;
        const py = Math.sin(angle) * shape.radius;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = Math.max(2, shape.radius * 0.16);
      ctx.strokeStyle = cachedOutline(color);
      ctx.stroke();
      ctx.restore();

      if (shape.healthPct < 0.999) {
        this.drawHealthBar(shape.x, shape.y + shape.radius + 9, shape.radius * 1.5, shape.healthPct);
      }
    }
  }

  private drawBullets(context: RenderContext): void {
    const { ctx } = this;
    for (const bullet of context.world.bullets) {
      const fill = bullet.colorIndex === context.selfColorIndex ? SELF_COLOR : ENEMY_COLOR;
      ctx.beginPath();
      ctx.arc(bullet.x, bullet.y, bullet.radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, bullet.radius * 0.22);
      ctx.strokeStyle = cachedOutline(fill);
      ctx.stroke();
    }
  }

  private drawTanks(context: RenderContext): void {
    const { ctx } = this;
    for (const tank of context.world.tanks) {
      const isSelf = tank.id === context.selfId;
      const fill = isSelf ? SELF_COLOR : ENEMY_COLOR;
      const outline = cachedOutline(fill);
      const invulnerable = (tank.flags & TANK_FLAG_INVULNERABLE) !== 0;

      ctx.save();
      ctx.globalAlpha = invulnerable ? 0.55 : 1;
      ctx.translate(tank.x, tank.y);
      ctx.rotate(tank.angle);

      const key = TANK_CLASS_BY_ID[tank.classId] ?? 'basic';
      const def = TANK_CLASSES[key] ?? TANK_CLASSES.basic;

      ctx.lineJoin = 'round';
      for (const barrel of def.barrels) {
        const width = barrel.width * tank.radius;
        const length = barrel.length * tank.radius;
        ctx.save();
        ctx.rotate(barrel.angle);
        ctx.translate(0, barrel.offset * tank.radius);
        ctx.fillStyle = BARREL_FILL;
        ctx.strokeStyle = '#727272';
        ctx.lineWidth = Math.max(2, tank.radius * 0.12);
        ctx.beginPath();
        ctx.rect(0, -width / 2, length, width);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      ctx.beginPath();
      ctx.arc(0, 0, tank.radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = Math.max(2, tank.radius * 0.12);
      ctx.strokeStyle = outline;
      ctx.stroke();
      ctx.restore();

      const name = context.names.get(tank.id);
      if (name) this.drawLabel(name, tank.x, tank.y - tank.radius - 20, 15);
      this.drawLabel(`Lvl ${tank.level}`, tank.x, tank.y - tank.radius - 7, 11, 'rgba(255,255,255,0.85)');
      if (tank.healthPct < 0.999) {
        this.drawHealthBar(tank.x, tank.y + tank.radius + 11, tank.radius * 1.7, tank.healthPct);
      }
    }
  }

  private drawLabel(text: string, x: number, y: number, size: number, fill = '#ffffff'): void {
    const { ctx } = this;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${size}px "Trebuchet MS", "Segoe UI", system-ui, sans-serif`;
    ctx.lineWidth = size * 0.32;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  private drawHealthBar(x: number, y: number, halfWidth: number, pct: number): void {
    const { ctx } = this;
    const width = halfWidth * 2;
    const height = Math.max(5, halfWidth * 0.16);
    const radius = height / 2;
    ctx.save();
    ctx.fillStyle = HEALTH_TRACK;
    roundedRect(ctx, x - halfWidth, y, width, height, radius);
    ctx.fill();
    if (pct > 0) {
      ctx.fillStyle = HEALTH_FILL;
      roundedRect(ctx, x - halfWidth, y, Math.max(height, width * pct), height, radius);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawMinimap(context: RenderContext): void {
    const { ctx } = this;
    const size = Math.max(120, Math.min(190, this.width * 0.14));
    const margin = 16;
    const x = this.width - size - margin;
    const y = this.height - size - margin;

    ctx.save();
    ctx.fillStyle = 'rgba(20, 22, 27, 0.62)';
    roundedRect(ctx, x, y, size, size, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    roundedRect(ctx, x, y, size, size, 8);
    ctx.stroke();

    const toMap = (wx: number, wy: number): [number, number] => [
      x + (wx / WORLD_SIZE) * size,
      y + (wy / WORLD_SIZE) * size,
    ];

    for (const tank of context.world.tanks) {
      if (tank.id === context.selfId) continue;
      const [mx, my] = toMap(tank.x, tank.y);
      ctx.fillStyle = ENEMY_COLOR;
      ctx.beginPath();
      ctx.arc(mx, my, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    const [sx, sy] = toMap(context.cameraX, context.cameraY);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(sx, sy, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawStick(stick: TouchStick): void {
    if (!stick.active) return;
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(stick.originX, stick.originY, 52, 0, Math.PI * 2);
    ctx.stroke();

    const dx = stick.x - stick.originX;
    const dy = stick.y - stick.originY;
    const distance = Math.min(52, Math.hypot(dx, dy));
    const angle = Math.atan2(dy, dx);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.arc(
      stick.originX + Math.cos(angle) * distance,
      stick.originY + Math.sin(angle) * distance,
      20,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.restore();
  }
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

import { SPATIAL_CELL, WORLD_SIZE } from '@kmtank/shared';

export interface Circle {
  x: number;
  y: number;
  radius: number;
}

/**
 * Uniform-grid broad phase.
 *
 * Rebuilt from scratch every tick — with a few hundred entities that is far
 * cheaper than maintaining incremental cell membership, and it cannot drift
 * out of sync with the entity positions.
 */
export class SpatialHash<T extends Circle> {
  private readonly cols: number;
  private readonly cells: T[][];
  /** Reused between queries to avoid reporting the same entity twice. */
  private readonly seen = new Set<T>();

  constructor(worldSize = WORLD_SIZE, private readonly cellSize = SPATIAL_CELL) {
    this.cols = Math.ceil(worldSize / cellSize) + 1;
    this.cells = new Array(this.cols * this.cols);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
  }

  clear(): void {
    for (const cell of this.cells) if (cell.length) cell.length = 0;
  }

  private cellIndex(cx: number, cy: number): number {
    return cy * this.cols + cx;
  }

  private clampCoord(v: number): number {
    const c = Math.floor(v / this.cellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  insert(item: T): void {
    const minX = this.clampCoord(item.x - item.radius);
    const maxX = this.clampCoord(item.x + item.radius);
    const minY = this.clampCoord(item.y - item.radius);
    const maxY = this.clampCoord(item.y + item.radius);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        this.cells[this.cellIndex(cx, cy)].push(item);
      }
    }
  }

  /** Every distinct item whose cell overlaps the given circle. */
  query(x: number, y: number, radius: number, out: T[]): T[] {
    out.length = 0;
    this.seen.clear();
    const minX = this.clampCoord(x - radius);
    const maxX = this.clampCoord(x + radius);
    const minY = this.clampCoord(y - radius);
    const maxY = this.clampCoord(y + radius);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const cell = this.cells[this.cellIndex(cx, cy)];
        for (let i = 0; i < cell.length; i++) {
          const item = cell[i];
          if (this.seen.has(item)) continue;
          this.seen.add(item);
          out.push(item);
        }
      }
    }
    return out;
  }
}

export const distanceSq = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

export const circlesOverlap = (a: Circle, b: Circle): boolean => {
  const r = a.radius + b.radius;
  return distanceSq(a.x, a.y, b.x, b.y) < r * r;
};

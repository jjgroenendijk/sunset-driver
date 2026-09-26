import type { HeightfieldData } from '../types.ts';

/** A grid index held to the grid: 0 to `n - 1`. */
function clampIndex(i: number, n: number): number {
  if (i < 0) return 0;
  return i >= n ? n - 1 : i;
}

/** Bilinear sampling and slope over a square height grid. */
export class Heightfield implements HeightfieldData {
  readonly gridSize: number;
  readonly cellSize: number;
  readonly originX: number;
  readonly originY: number;
  readonly heights: Float32Array;

  constructor(data: HeightfieldData) {
    this.gridSize = data.gridSize;
    this.cellSize = data.cellSize;
    this.originX = data.originX;
    this.originY = data.originY;
    this.heights = data.heights;
  }

  static create(gridSize: number, cellSize: number): Heightfield {
    const half = ((gridSize - 1) * cellSize) / 2;
    return new Heightfield({ gridSize, cellSize, originX: -half, originY: -half, heights: new Float32Array(gridSize * gridSize) });
  }

  /** Side length of the covered area in metres. */
  get extent(): number {
    return (this.gridSize - 1) * this.cellSize;
  }

  at(ix: number, iy: number): number {
    const n = this.gridSize;
    return this.heights[clampIndex(iy, n) * n + clampIndex(ix, n)] as number;
  }

  set(ix: number, iy: number, h: number): void {
    this.heights[iy * this.gridSize + ix] = h;
  }

  sample(x: number, y: number): number {
    const fx = (x - this.originX) / this.cellSize;
    const fy = (y - this.originY) / this.cellSize;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const h00 = this.at(ix, iy);
    const h10 = this.at(ix + 1, iy);
    const h01 = this.at(ix, iy + 1);
    const h11 = this.at(ix + 1, iy + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
  }

  /** Gradient magnitude (rise over run) by central difference. */
  slope(x: number, y: number): number {
    const d = this.cellSize;
    const dx = (this.sample(x + d, y) - this.sample(x - d, y)) / (2 * d);
    const dy = (this.sample(x, y + d) - this.sample(x, y - d)) / (2 * d);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Gradient vector (∂h/∂x, ∂h/∂y). */
  gradient(x: number, y: number): { gx: number; gy: number } {
    const d = this.cellSize;
    return {
      gx: (this.sample(x + d, y) - this.sample(x - d, y)) / (2 * d),
      gy: (this.sample(x, y + d) - this.sample(x, y - d)) / (2 * d),
    };
  }

  worldX(ix: number): number {
    return this.originX + ix * this.cellSize;
  }

  worldY(iy: number): number {
    return this.originY + iy * this.cellSize;
  }

  toData(): HeightfieldData {
    return { gridSize: this.gridSize, cellSize: this.cellSize, originX: this.originX, originY: this.originY, heights: this.heights };
  }
}

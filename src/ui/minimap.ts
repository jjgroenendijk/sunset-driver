/**
 * The minimap of spec section 12: a round window on the map, in the corner,
 * following the player.
 *
 * It is drawn through `MapArt`, so it shows the same roads, sand, tram line and
 * icons the full map shows. `N` switches between rotating, where the player's
 * facing is up, and fixed-north, which the spec leaves to the player's choice.
 *
 * The canvas is redrawn only when something on it has moved: standing still
 * costs nothing, and driving costs one blit and the few hundred road segments
 * the window holds.
 */
import { MapArt, type MapDrawOptions } from './map-draw.ts';
import { rotationForHeading, unproject, type MapPois, type MapView } from './map.ts';

/** The key that switches between a rotating map and a fixed-north one. Listed in `controls.ts`. */
export const MINIMAP_NORTH_KEY = 'KeyN';

/** Pixels across the minimap. */
const SIZE = 190;

/** Metres to the pixel. A car at 120 km/h crosses the window in about six seconds. */
const SCALE = 1.1;

/** Pixels across an icon on the minimap. Small, so the shapes carry it. */
const ICON = 11;

/** The map is redrawn once the player has moved this far, in metres. */
const MOVE_STEP = 0.5;

/** Or once they have turned this far, in radians. Only a rotating map reads it. */
const TURN_STEP = 0.01;

export class Minimap {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly art: MapArt;
  private readonly dpr: number;
  /** True while the map turns with the player; false for fixed north. */
  private rotating = true;
  private drawnX = Infinity;
  private drawnY = Infinity;
  private drawnAngle = Infinity;
  private drawnWaypoint = '';

  /** The territory overlay slot of spec section 12; see `MapDrawOptions.overlay`. */
  overlay: MapDrawOptions['overlay'];

  constructor(parent: HTMLElement, art: MapArt) {
    this.art = art;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.root = document.createElement('div');
    this.root.className = 'minimap';
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE * this.dpr;
    this.canvas.height = SIZE * this.dpr;
    this.canvas.style.width = `${SIZE}px`;
    this.canvas.style.height = `${SIZE}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.root.append(this.canvas);
    parent.append(this.root);
  }

  /** The places the minimap marks. The same list the full map reads. */
  get pois(): MapPois {
    return this.art.pois;
  }

  /** Switch between a rotating map and a fixed-north one (spec section 12). */
  toggleNorth(): boolean {
    this.rotating = !this.rotating;
    this.drawnX = Infinity;
    return this.rotating;
  }

  /** True while the map turns with the player. */
  get northUp(): boolean {
    return !this.rotating;
  }

  /**
   * Draw the window around the player, if anything on it has moved. Called once
   * a frame; it returns without touching the canvas when nothing has changed.
   */
  update(player: { x: number; y: number; heading: number }, waypoint: { x: number; y: number } | null): void {
    const angle = this.rotating ? rotationForHeading(player.heading) : 0;
    const mark = waypoint ? `${waypoint.x.toFixed(1)},${waypoint.y.toFixed(1)}` : '';
    if (
      Math.abs(player.x - this.drawnX) < MOVE_STEP &&
      Math.abs(player.y - this.drawnY) < MOVE_STEP &&
      Math.abs(angle - this.drawnAngle) < TURN_STEP &&
      mark === this.drawnWaypoint
    ) {
      return;
    }
    this.drawnX = player.x;
    this.drawnY = player.y;
    this.drawnAngle = angle;
    this.drawnWaypoint = mark;

    const view: MapView = { x: player.x, y: player.y, metresPerPixel: SCALE, rotation: angle };
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, SIZE, SIZE);
    // The round window: everything the map draws is clipped to it, so the
    // roads run off the edge instead of stopping at a square corner.
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
    ctx.clip();
    this.art.draw(ctx, view, SIZE, SIZE, {
      player,
      waypoint,
      iconSize: ICON,
      labels: false,
      overlay: this.overlay,
    });
    ctx.restore();
  }

  /**
   * The world point under a pixel of the minimap, so a click on it sets a
   * waypoint the way a click on the full map does.
   */
  pointAt(px: number, py: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const view: MapView = {
      x: this.drawnX,
      y: this.drawnY,
      metresPerPixel: SCALE,
      rotation: this.drawnAngle,
    };
    return unproject(view, SIZE, SIZE, px - rect.left, py - rect.top);
  }

  /** True while the pixel is inside the round window. */
  holds(px: number, py: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    return Math.hypot(px - rect.left - SIZE / 2, py - rect.top - SIZE / 2) <= SIZE / 2;
  }

  destroy(): void {
    this.root.remove();
  }
}

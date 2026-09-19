/**
 * The minimap of spec section 12: a round window on the map, in the corner,
 * following the player.
 *
 * It is drawn through `MapArt`, so it shows the same roads, sand, tram line and
 * icons the full map shows. `N` switches between rotating, where the player's
 * facing is up, and fixed-north, which the spec leaves to the player's choice.
 *
 * A rotating map works the way a driving game's corner map does: the arrow
 * stays in the middle pointing up, the world turns under it, and a letter N on
 * the rim says where north went. While the free camera flies, the heading it is
 * handed is the camera's view, so up on the map is where the screen looks.
 *
 * The window takes the size the style sheet gives it — a phone's is smaller —
 * and the canvas follows it, so the arrow stays in the middle of the circle.
 *
 * The canvas is redrawn only when something on it has moved: standing still
 * costs nothing, and driving costs one blit and the few hundred road segments
 * the window holds.
 */
import { distanceText, MapArt, type MapDrawOptions } from './map-draw.ts';
import type { MapRoute } from './map-route.ts';
import { rotationForHeading, unproject, type MapPois, type MapView } from './map.ts';

/** The key that switches between a rotating map and a fixed-north one. Listed in `controls.ts`. */
export const MINIMAP_NORTH_KEY = 'KeyN';

/** Pixels across the minimap until the page has laid it out. */
const SIZE = 190;

/** Metres to the pixel. A car at 120 km/h crosses the window in about six seconds. */
const SCALE = 1.1;

/** Pixels across an icon on the minimap. Small, so the shapes carry it. */
const ICON = 11;

/** The map is redrawn once the player has moved this far, in metres. */
const MOVE_STEP = 0.5;

/** Or once they have turned this far, in radians. Only a rotating map reads it. */
const TURN_STEP = 0.01;

/** Pixels from the rim to the middle of the north mark. */
const NORTH_INSET = 9;

export class Minimap {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly art: MapArt;
  private readonly dpr: number;
  /** Pixels across the window, as the page lays it out. */
  private size = SIZE;
  /** True while the map turns with the player; false for fixed north. */
  private rotating = true;
  private drawnX = Infinity;
  private drawnY = Infinity;
  private drawnAngle = Infinity;
  private drawnWaypoint = '';
  private drawnRoute = -1;
  /** How far the waypoint is, under the window. */
  private readonly distance: HTMLElement;

  /** The territory overlay slot of spec section 12; see `MapDrawOptions.overlay`. */
  overlay: MapDrawOptions['overlay'];

  constructor(parent: HTMLElement, art: MapArt) {
    this.art = art;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.root = document.createElement('div');
    this.root.className = 'minimap';
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.root.append(this.canvas);
    parent.append(this.root);
    this.distance = document.createElement('div');
    this.distance.className = 'minimap-distance';
    this.distance.hidden = true;
    parent.append(this.distance);
    this.resize(this.root.clientWidth);
    // The style sheet sets the size, and `body.touch` or a turned phone can
    // change it after the window was built.
    new ResizeObserver(() => this.resize(this.root.clientWidth)).observe(this.root);
  }

  private resize(size: number): void {
    const px = size > 0 ? size : SIZE;
    if (px === this.size && this.canvas.width === Math.round(px * this.dpr)) return;
    this.size = px;
    this.canvas.width = Math.round(px * this.dpr);
    this.canvas.height = Math.round(px * this.dpr);
    this.canvas.style.width = `${px}px`;
    this.canvas.style.height = `${px}px`;
    this.drawnX = Infinity;
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
  update(
    player: { x: number; y: number; heading: number },
    waypoint: { x: number; y: number } | null,
    route: MapRoute | null = null,
    routeVersion = 0,
  ): void {
    const angle = this.rotating ? rotationForHeading(player.heading) : 0;
    const mark = waypoint ? `${waypoint.x.toFixed(1)},${waypoint.y.toFixed(1)}` : '';
    if (
      Math.abs(player.x - this.drawnX) < MOVE_STEP &&
      Math.abs(player.y - this.drawnY) < MOVE_STEP &&
      Math.abs(angle - this.drawnAngle) < TURN_STEP &&
      mark === this.drawnWaypoint &&
      routeVersion === this.drawnRoute
    ) {
      return;
    }
    this.drawnX = player.x;
    this.drawnY = player.y;
    this.drawnAngle = angle;
    this.drawnWaypoint = mark;
    this.drawnRoute = routeVersion;
    this.distance.hidden = waypoint === null;
    if (waypoint) {
      const metres = route ? route.length : Math.hypot(waypoint.x - player.x, waypoint.y - player.y);
      this.distance.textContent = distanceText(metres);
    }

    const size = this.size;
    const view: MapView = { x: player.x, y: player.y, metresPerPixel: SCALE, rotation: angle };
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, size, size);
    // The round window: everything the map draws is clipped to it, so the
    // roads run off the edge instead of stopping at a square corner.
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    this.art.draw(ctx, view, size, size, {
      player,
      waypoint,
      route,
      iconSize: ICON,
      labels: false,
      overlay: this.overlay,
    });
    if (this.rotating) drawNorth(ctx, size, angle);
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
    return unproject(view, this.size, this.size, px - rect.left, py - rect.top);
  }

  /** True while the pixel is inside the round window. */
  holds(px: number, py: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const half = this.size / 2;
    return Math.hypot(px - rect.left - half, py - rect.top - half) <= half;
  }

  destroy(): void {
    this.root.remove();
    this.distance.remove();
  }
}

/**
 * The letter N on the rim, where north lies on a map turned by `angle`. North
 * is world `-y`, which a map turned by nothing draws straight up, so the mark
 * is the top of the rim turned by the same angle.
 */
function drawNorth(ctx: CanvasRenderingContext2D, size: number, angle: number): void {
  const r = size / 2 - NORTH_INSET;
  const x = size / 2 + Math.sin(angle) * r;
  const y = size / 2 - Math.cos(angle) * r;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(18,7,15,.85)';
  ctx.fill();
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('N', x, y + 0.5);
}

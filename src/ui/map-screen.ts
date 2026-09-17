/**
 * The full map of spec section 12: the whole world, panned, zoomed and marked
 * with a waypoint.
 *
 * It draws through the same `MapArt` the minimap does, so the two agree about
 * every road and every icon. It is always fixed-north, because a map a player
 * reads at rest has no reason to turn, and it carries the district names and
 * the POI names the minimap has no room for.
 *
 * A frame is drawn only when the view has moved, so an open map that nobody is
 * dragging costs nothing.
 */
import { MapArt, type MapDrawOptions } from './map-draw.ts';
import { unproject, zoomBy, ZOOM_STEPS, type MapPois, type MapView } from './map.ts';

/** The key that opens and closes the map. Listed in `controls.ts`. */
export const MAP_KEY = 'KeyM';

/** Pixels across an icon on the full map. */
const ICON = 16;

/** Metres to the pixel the map opens at: a district and the roads around it. */
const OPEN_SCALE = 4;

export class MapScreen {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hint: HTMLElement;
  private readonly art: MapArt;
  private readonly onWaypoint: (place: { x: number; y: number } | null) => void;
  private dpr = 1;
  private view: MapView = { x: 0, y: 0, metresPerPixel: OPEN_SCALE, rotation: 0 };
  private player = { x: 0, y: 0, heading: 0 };
  private waypoint: { x: number; y: number } | null = null;
  private dragging = false;
  /** Set once a drag has moved far enough that the release is not a click. */
  private dragged = false;
  private lastX = 0;
  private lastY = 0;
  private dirty = true;

  /** The territory overlay slot of spec section 12; see `MapDrawOptions.overlay`. */
  overlay: MapDrawOptions['overlay'];

  constructor(
    parent: HTMLElement,
    art: MapArt,
    onWaypoint: (place: { x: number; y: number } | null) => void,
    touch = false,
  ) {
    this.art = art;
    this.onWaypoint = onWaypoint;
    this.root = document.createElement('div');
    this.root.className = 'map-screen';
    this.root.hidden = true;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    this.hint = document.createElement('div');
    this.hint.className = 'map-hint';
    // A phone has no wheel to zoom with and no `M` to close with, so the two
    // are buttons there. The hint names what that screen actually has.
    this.hint.textContent = touch
      ? 'Drag to pan · tap to set a waypoint'
      : 'Drag to pan · wheel or + − to zoom · click to set a waypoint · right-click to clear · M to close';
    this.root.append(this.canvas, this.hint);
    if (touch) this.root.append(this.buildKeys());
    parent.append(this.root);

    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.dragged = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      if (Math.abs(dx) > 0 || Math.abs(dy) > 0) this.dragged = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.view.x -= dx * this.view.metresPerPixel;
      this.view.y -= dy * this.view.metresPerPixel;
      this.clampToWorld();
      this.dirty = true;
    });
    this.canvas.addEventListener('pointerup', (e) => {
      this.dragging = false;
      // A drag that moved is a pan; one that did not is a click, and a click
      // sets the waypoint (spec section 12).
      if (this.dragged) return;
      const rect = this.canvas.getBoundingClientRect();
      const place = unproject(this.view, rect.width, rect.height, e.clientX - rect.left, e.clientY - rect.top);
      this.setWaypoint({ x: place.x, y: place.y });
    });
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.setWaypoint(null);
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Zoom about the pointer, so the place under it stays under it.
        const rect = this.canvas.getBoundingClientRect();
        const at = unproject(this.view, rect.width, rect.height, e.clientX - rect.left, e.clientY - rect.top);
        this.zoom(e.deltaY > 0 ? 1 : -1, at);
      },
      { passive: false },
    );
  }

  /** The zoom and close buttons a touch browser is given in place of the keys. */
  private buildKeys(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'map-keys';
    for (const key of [
      { text: '−', label: 'Zoom out', act: () => this.zoom(1) },
      { text: '+', label: 'Zoom in', act: () => this.zoom(-1) },
      { text: 'Close', label: 'Close the map', act: () => this.toggle() },
    ]) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'touch-key';
      el.textContent = key.text;
      el.setAttribute('aria-label', key.label);
      el.addEventListener('click', key.act);
      row.append(el);
    }
    return row;
  }

  /** The places the map marks. The same list the minimap reads. */
  get pois(): MapPois {
    return this.art.pois;
  }

  /** True while the map is on screen. */
  get open(): boolean {
    return !this.root.hidden;
  }

  /**
   * Show the map centred on the player, or take it away. It opens on the
   * player rather than wherever it was last panned to, because the thing a
   * player opens a map for is where they are.
   */
  toggle(): void {
    this.root.hidden = !this.root.hidden;
    if (!this.root.hidden) {
      this.view = { x: this.player.x, y: this.player.y, metresPerPixel: OPEN_SCALE, rotation: 0 };
      this.clampToWorld();
      this.dirty = true;
    }
  }

  /** Step the zoom in (`-1`) or out (`+1`), keeping `at` where it is on screen. */
  zoom(steps: number, at?: { x: number; y: number }): void {
    const before = this.view.metresPerPixel;
    const after = zoomBy(before, steps);
    if (after === before) return;
    if (at) {
      // The point under the cursor stays put: the centre moves toward it by the
      // fraction the scale changed.
      const k = after / before;
      this.view.x = at.x + (this.view.x - at.x) * k;
      this.view.y = at.y + (this.view.y - at.y) * k;
    }
    this.view.metresPerPixel = after;
    this.clampToWorld();
    this.dirty = true;
  }

  /** Mark a place, or clear the mark. The session records it; nothing is kept here. */
  setWaypoint(place: { x: number; y: number } | null): void {
    this.onWaypoint(place);
    this.dirty = true;
  }

  /**
   * Where the player is and what they have marked, handed in once a frame. The
   * map redraws only when it is open and something has moved.
   */
  update(player: { x: number; y: number; heading: number }, waypoint: { x: number; y: number } | null): void {
    if (player.x !== this.player.x || player.y !== this.player.y || player.heading !== this.player.heading) {
      this.player = { x: player.x, y: player.y, heading: player.heading };
      this.dirty = this.dirty || this.open;
    }
    const same =
      (this.waypoint === null && waypoint === null) ||
      (this.waypoint !== null && waypoint !== null && this.waypoint.x === waypoint.x && this.waypoint.y === waypoint.y);
    if (!same) {
      this.waypoint = waypoint ? { x: waypoint.x, y: waypoint.y } : null;
      this.dirty = this.dirty || this.open;
    }
    if (!this.open || !this.dirty) return;
    this.dirty = false;
    this.render();
  }

  private render(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr || dpr !== this.dpr) {
      this.dpr = dpr;
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    this.art.draw(ctx, this.view, w, h, {
      player: this.player,
      waypoint: this.waypoint,
      iconSize: ICON,
      labels: true,
      overlay: this.overlay,
    });
    ctx.restore();
  }

  /** Keep the middle of the view on the map, so the world cannot be panned away. */
  private clampToWorld(): void {
    const half = this.art.world.size / 2;
    this.view.x = Math.min(half, Math.max(-half, this.view.x));
    this.view.y = Math.min(half, Math.max(-half, this.view.y));
    const last = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;
    this.view.metresPerPixel = Math.min(last, Math.max(ZOOM_STEPS[0] as number, this.view.metresPerPixel));
  }

  destroy(): void {
    this.root.remove();
  }
}

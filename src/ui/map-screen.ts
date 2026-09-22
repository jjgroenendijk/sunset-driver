/**
 * The full map of spec section 12: the whole world, panned, zoomed and marked
 * with a waypoint.
 *
 * It draws through the same `MapArt` the minimap does, so the two agree about
 * every road and every icon. It is always fixed-north, because a map a player
 * reads at rest has no reason to turn, and it carries the district names, the
 * POI names and the legend (`map-legend.ts`) the minimap has no room for.
 *
 * The zoom is smooth. A wheel event or a key does not jump the scale; it moves
 * a target, and each frame eases the scale toward it (`easeScale` in
 * `map.ts`), keeping the place under the pointer where it is on screen. A
 * trackpad and a mouse wheel zoom the same distance for the same travel, and a
 * two-finger pinch on a touch screen follows the fingers.
 *
 * A frame is drawn only when the view has moved, so an open map that nobody is
 * dragging costs nothing.
 */
import { MapArt, type MapDrawOptions } from './map-draw.ts';
import { drawIcon } from './map-icons.ts';
import { MapLegend } from './map-legend.ts';
import type { MapRoute } from './map-route.ts';
import {
  clampScale,
  easeScale,
  POI_STYLES,
  project,
  unproject,
  wheelScale,
  type MapPois,
  type MapView,
  type PoiType,
} from './map.ts';

/** The key that opens and closes the map. Listed in `controls.ts`. */
export const MAP_KEY = 'KeyM';

/** While the map is open: pan back to the player, and fold the legend. Listed in `controls.ts`. */
export const MAP_CENTRE_KEY = 'Space';
export const MAP_LEGEND_KEY = 'KeyL';

/** Pixels across an icon on the full map. */
const ICON = 18;

/** Metres to the pixel the map opens at: a district and the roads around it. */
const OPEN_SCALE = 4;

/** The factor one press of a zoom key or button changes the scale by. */
const KEY_ZOOM = 2;

/** Pixels a press may move and still be a click rather than a drag. */
const CLICK_SLOP = 5;

/** Pixels from the waypoint within which a click takes it away rather than moving it. */
const PIN_REACH = 14;

/** The longest frame the eased zoom steps by, in seconds, so a stalled tab does not jump. */
const MAX_STEP = 0.05;

export class MapScreen {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hint: HTMLElement;
  private readonly art: MapArt;
  private readonly legend: MapLegend;
  private readonly onWaypoint: (place: { x: number; y: number } | null) => void;
  private dpr = 1;
  private view: MapView = { x: 0, y: 0, metresPerPixel: OPEN_SCALE, rotation: 0 };
  /** The scale the zoom is easing toward. */
  private target = OPEN_SCALE;
  /** The world point the zoom holds still, and the pixel it is held at. */
  private anchor: { x: number; y: number; px: number; py: number } | null = null;
  private lastFrame = 0;
  private player = { x: 0, y: 0, heading: 0 };
  private waypoint: { x: number; y: number } | null = null;
  private route: MapRoute | null = null;
  private routeVersion = -1;
  private highlight: PoiType | null = null;
  /** The pointers on the canvas, by id, where each was last seen. */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  /** Where the press began, and whether it has moved far enough to be a drag. */
  private pressX = 0;
  private pressY = 0;
  private dragged = false;
  /** The spread of two fingers and the scale when the pinch began. */
  private pinch: { spread: number; scale: number } | null = null;
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
    const stage = document.createElement('div');
    stage.className = 'map-stage';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    this.legend = new MapLegend(
      art.pois,
      (change) => {
        this.highlight = change.highlight;
        this.dirty = true;
      },
      () => this.setWaypoint(null),
    );
    this.hint = document.createElement('div');
    this.hint.className = 'map-hint';
    // A phone has no wheel to zoom with and no `M` to close with, so the two
    // are buttons there. The hint names what that screen actually has.
    this.hint.textContent = touch
      ? 'Drag to pan · pinch to zoom · tap to set a waypoint, tap it again to clear'
      : 'Drag to pan · wheel or + − to zoom · click to set a waypoint, click it or right-click to clear · Space to centre · L for the legend · M to close';
    stage.append(this.canvas, this.legend.root);
    this.root.append(stage, this.hint);
    if (touch) this.root.append(this.buildKeys());
    parent.append(this.root);
    new ResizeObserver(() => {
      this.dirty = true;
    }).observe(this.canvas);

    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.anchor = null;
      this.target = this.view.metresPerPixel;
      if (this.pointers.size === 1) {
        this.pressX = e.clientX;
        this.pressY = e.clientY;
        this.dragged = false;
      } else {
        // A second finger is a pinch, and a pinch is never a click.
        this.dragged = true;
        this.pinch = { spread: this.spread(), scale: this.view.metresPerPixel };
      }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const last = this.pointers.get(e.pointerId);
      if (last === undefined) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last.x = e.clientX;
      last.y = e.clientY;
      if (Math.hypot(e.clientX - this.pressX, e.clientY - this.pressY) > CLICK_SLOP) this.dragged = true;
      if (!this.dragged) return;
      // Two fingers pan by their middle, so dividing the step between them.
      const share = 1 / this.pointers.size;
      this.view.x -= dx * share * this.view.metresPerPixel;
      this.view.y -= dy * share * this.view.metresPerPixel;
      if (this.pinch !== null && this.pointers.size >= 2) {
        const spread = this.spread();
        const scale = clampScale((this.pinch.scale * this.pinch.spread) / Math.max(1, spread));
        const middle = this.middle();
        this.zoomTo(scale, middle.x, middle.y, true);
      }
      this.clampToWorld();
      this.dirty = true;
    });
    const release = (e: PointerEvent, click: boolean): void => {
      if (!this.pointers.delete(e.pointerId)) return;
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size > 0) return;
      // A press that did not move is a click, and a left click sets the
      // waypoint (spec section 12), or takes it away when it lands on it.
      if (!click || this.dragged || e.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (this.waypoint) {
        const pin = project(this.view, rect.width, rect.height, this.waypoint.x, this.waypoint.y);
        if (Math.hypot(pin.x - px, pin.y - py) <= PIN_REACH) {
          this.setWaypoint(null);
          return;
        }
      }
      const place = unproject(this.view, rect.width, rect.height, px, py);
      this.setWaypoint({ x: place.x, y: place.y });
    };
    this.canvas.addEventListener('pointerup', (e) => release(e, true));
    this.canvas.addEventListener('pointercancel', (e) => release(e, false));
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.setWaypoint(null);
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // A trackpad pinch arrives as a wheel event with the control key held.
        this.target = wheelScale(this.target, e.deltaY, e.deltaMode, e.ctrlKey);
        const rect = this.canvas.getBoundingClientRect();
        this.setAnchor(e.clientX - rect.left, e.clientY - rect.top);
        this.dirty = true;
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
      { text: '◎', label: 'Centre on me', act: () => this.centre() },
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
    this.pointers.clear();
    this.pinch = null;
    if (!this.root.hidden) {
      this.view = { x: this.player.x, y: this.player.y, metresPerPixel: OPEN_SCALE, rotation: 0 };
      this.target = OPEN_SCALE;
      this.anchor = null;
      this.lastFrame = 0;
      this.clampToWorld();
      this.legend.refresh();
      this.dirty = true;
    }
  }

  /** Pan back to the player, at the zoom the map has now. */
  centre(): void {
    this.view.x = this.player.x;
    this.view.y = this.player.y;
    this.anchor = null;
    this.clampToWorld();
    this.dirty = true;
  }

  /** Fold the legend away, or bring it back. */
  toggleLegend(): void {
    this.legend.fold();
  }

  /**
   * Zoom in (`-1`) or out (`+1`) by a step, easing there over a few frames and
   * holding the middle of the map still.
   */
  zoom(steps: number): void {
    this.target = clampScale(this.target * KEY_ZOOM ** steps);
    this.setAnchor(null, null);
    this.dirty = true;
  }

  /** Mark a place, or clear the mark. The session records it; nothing is kept here. */
  setWaypoint(place: { x: number; y: number } | null): void {
    this.onWaypoint(place);
    this.dirty = true;
  }

  /**
   * Where the player is, what they have marked and the route to it, handed in
   * once a frame. The map redraws only when it is open and something has moved,
   * or while the zoom is still easing.
   */
  update(
    player: { x: number; y: number; heading: number },
    waypoint: { x: number; y: number } | null,
    route: MapRoute | null = null,
    routeVersion = 0,
  ): void {
    if (player.x !== this.player.x || player.y !== this.player.y || player.heading !== this.player.heading) {
      this.player = { x: player.x, y: player.y, heading: player.heading };
      this.dirty = this.dirty || this.open;
    }
    const same =
      (this.waypoint === null && waypoint === null) ||
      (this.waypoint !== null && waypoint !== null && this.waypoint.x === waypoint.x && this.waypoint.y === waypoint.y);
    if (!same || routeVersion !== this.routeVersion) {
      this.waypoint = waypoint ? { x: waypoint.x, y: waypoint.y } : null;
      this.route = route;
      this.routeVersion = routeVersion;
      this.legend.showRoute(route, waypoint !== null);
      this.dirty = this.dirty || this.open;
    }
    if (!this.open) return;
    const now = performance.now();
    const seconds = this.lastFrame === 0 ? 1 / 60 : Math.min(MAX_STEP, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.view.metresPerPixel !== this.target) {
      const scale = easeScale(this.view.metresPerPixel, this.target, seconds);
      if (this.anchor) this.zoomTo(scale, this.anchor.px, this.anchor.py, false);
      else this.view.metresPerPixel = scale;
      this.clampToWorld();
      this.dirty = true;
    }
    this.legend.refresh();
    if (!this.dirty) return;
    this.dirty = false;
    this.render();
  }

  /**
   * Hold the world point under a pixel still while the zoom eases. A null pixel
   * holds the middle of the map. A new anchor is taken only where the last one
   * has been let go of or the pointer has moved, so a run of wheel events zooms
   * about one point.
   */
  private setAnchor(px: number | null, py: number | null): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = px ?? rect.width / 2;
    const y = py ?? rect.height / 2;
    if (this.anchor && Math.abs(this.anchor.px - x) < 2 && Math.abs(this.anchor.py - y) < 2) return;
    const at = unproject(this.view, rect.width, rect.height, x, y);
    this.anchor = { x: at.x, y: at.y, px: x, py: y };
  }

  /**
   * Set the scale, and move the middle of the view so the anchor stays under
   * its pixel. A pinch passes its own point, taken fresh each move.
   */
  private zoomTo(scale: number, px: number, py: number, fresh: boolean): void {
    const rect = this.canvas.getBoundingClientRect();
    const at = fresh ? unproject(this.view, rect.width, rect.height, px, py) : this.anchor!;
    this.view.metresPerPixel = scale;
    this.target = fresh ? scale : this.target;
    this.view.x = at.x - (px - rect.width / 2) * scale;
    this.view.y = at.y - (py - rect.height / 2) * scale;
  }

  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 1;
  }

  private middle(): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return { x: rect.width / 2, y: rect.height / 2 };
    return { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
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
      route: this.route,
      iconSize: ICON,
      labels: true,
      tram: !this.legend.hiddenLayers.has('tram'),
      scaleBar: true,
      overlay: this.legend.hiddenLayers.has('turf') ? undefined : this.overlay,
    });
    if (this.highlight) this.ringAll(ctx, this.highlight, w, h);
    ctx.restore();
  }

  /**
   * A ring around every place of one kind, for the legend row under the
   * pointer. It rings them at every zoom, even where the kind is too small to
   * be drawn, so a player can find a car park from across the city.
   */
  private ringAll(ctx: CanvasRenderingContext2D, type: PoiType, w: number, h: number): void {
    const style = POI_STYLES[type];
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = style.colour;
    for (const list of [this.art.pois.fixed, this.art.pois.extra]) {
      for (const poi of list) {
        if (poi.type !== type) continue;
        const p = project(this.view, w, h, poi.x, poi.y);
        if (p.x < -20 || p.y < -20 || p.x > w + 20 || p.y > h + 20) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, ICON * 0.95, 0, Math.PI * 2);
        ctx.stroke();
        drawIcon(ctx, style.glyph, style.colour, p.x, p.y, ICON * 0.7);
      }
    }
    ctx.restore();
  }

  /** Keep the middle of the view on the map, so the world cannot be panned away. */
  private clampToWorld(): void {
    const half = this.art.world.size / 2;
    this.view.x = Math.min(half, Math.max(-half, this.view.x));
    this.view.y = Math.min(half, Math.max(-half, this.view.y));
    this.view.metresPerPixel = clampScale(this.view.metresPerPixel);
  }

  destroy(): void {
    this.root.remove();
  }
}

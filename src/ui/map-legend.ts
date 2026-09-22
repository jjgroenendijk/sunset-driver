/**
 * The legend of the full map of spec section 12: what each icon means, and a
 * switch for each.
 *
 * It lists only the kinds of place this city has, with how many of each. A
 * click on a row hides that kind on both maps, and a second click brings it
 * back; the choice is kept in the browser, so the next session opens the same
 * way. Holding the pointer over a row rings every place of that kind on the
 * map, so a player can find the clinics without reading the icons. The tram
 * line and the territory are switched the same way.
 *
 * The panel sits over the right edge of the map and folds away to a tab.
 */
import { drawIcon } from './map-icons.ts';
import { ALWAYS_SHOWN, POI_STYLES, poiCounts, type MapPois, type PoiType } from './map.ts';
import { distanceText } from './map-draw.ts';
import type { MapRoute } from './map-route.ts';

/** Where the choices are kept between sessions. */
const STORE_KEY = 'sunset-driver.map-legend';

/** The lines that are not places, switched in the same list. */
export type MapLayer = 'tram' | 'turf';

const LAYERS: readonly { layer: MapLayer; label: string; colour: string }[] = Object.freeze([
  { layer: 'tram', label: 'Tram line', colour: '#e05ad0' },
  { layer: 'turf', label: 'Territory', colour: '#c0a0e0' },
]);

/** What the legend tells the map. */
export interface LegendChange {
  /** The kind of place the pointer is over, or null. */
  highlight: PoiType | null;
}

export class MapLegend {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly routeLine: HTMLElement;
  private readonly pois: MapPois;
  private readonly onChange: (change: LegendChange) => void;
  private readonly onClear: () => void;
  /** The layers switched off. */
  readonly hiddenLayers = new Set<MapLayer>();
  /** The kinds of place and their counts the list was last built from. */
  private built = '';

  constructor(pois: MapPois, onChange: (change: LegendChange) => void, onClear: () => void) {
    this.pois = pois;
    this.onChange = onChange;
    this.onClear = onClear;
    this.root = document.createElement('aside');
    this.root.className = 'map-legend';
    const head = document.createElement('div');
    head.className = 'map-legend-head';
    const title = document.createElement('h2');
    title.textContent = 'Legend';
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'map-legend-fold';
    fold.setAttribute('aria-label', 'Fold the legend away');
    fold.textContent = '›';
    fold.addEventListener('click', () => this.fold());
    head.append(title, fold);
    this.routeLine = document.createElement('div');
    this.routeLine.className = 'map-legend-route';
    this.routeLine.hidden = true;
    this.list = document.createElement('ul');
    this.list.className = 'map-legend-list';
    const all = document.createElement('div');
    all.className = 'map-legend-all';
    for (const [text, hide] of [
      ['Show all', false],
      ['Hide all', true],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.addEventListener('click', () => this.setAll(hide));
      all.append(button);
    }
    this.root.append(head, this.routeLine, this.list, all);
    // A pointer on the panel is not a pointer on the map under it.
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.load();
  }

  /** Fold the panel to a tab, or open it again. */
  fold(): void {
    this.root.classList.toggle('folded');
    this.store();
  }

  /**
   * Rebuild the rows if the kinds of place or their counts have changed since
   * the last build. Called when the map opens and while it is open, so a
   * dealer who moved on is counted where he stands now.
   */
  refresh(): void {
    const counts = poiCounts([this.pois.fixed, this.pois.extra]).filter((c) => !ALWAYS_SHOWN.includes(c.type));
    const key = counts.map((c) => `${c.type}:${c.count}`).join(',');
    if (key === this.built) return;
    this.built = key;
    this.list.replaceChildren();
    for (const { type, count } of counts) {
      const style = POI_STYLES[type];
      this.list.append(
        this.row(style.label, count, () => this.pois.hidden.has(type), (off) => {
          if (off) this.pois.hidden.add(type);
          else this.pois.hidden.delete(type);
        }, (ctx) => drawIcon(ctx, style.glyph, style.colour, 10, 10, 13), type),
      );
    }
    for (const { layer, label, colour } of LAYERS) {
      this.list.append(
        this.row(label, null, () => this.hiddenLayers.has(layer), (off) => {
          if (off) this.hiddenLayers.add(layer);
          else this.hiddenLayers.delete(layer);
        }, (ctx) => {
          ctx.strokeStyle = colour;
          ctx.lineWidth = 3;
          if (layer === 'tram') ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(2, 10);
          ctx.lineTo(18, 10);
          ctx.stroke();
        }, null),
      );
    }
  }

  /** Say how far the waypoint is, or nothing when none is set. */
  showRoute(route: MapRoute | null, marked: boolean): void {
    if (!marked) {
      this.routeLine.hidden = true;
      return;
    }
    this.routeLine.hidden = false;
    const text = route ? distanceText(route.length) : '';
    const minutes = route && route.time > 0 ? ` · ${Math.max(1, Math.round(route.time / 60))} min` : '';
    const span = document.createElement('span');
    span.textContent = `Waypoint · ${text}${minutes}`;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => this.onClear());
    this.routeLine.replaceChildren(span, clear);
  }

  private row(
    label: string,
    count: number | null,
    isOff: () => boolean,
    setOff: (off: boolean) => void,
    paint: (ctx: CanvasRenderingContext2D) => void,
    type: PoiType | null,
  ): HTMLElement {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const icon = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    icon.width = 20 * dpr;
    icon.height = 20 * dpr;
    const ctx = icon.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
      paint(ctx);
    }
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = label;
    button.append(icon, name);
    if (count !== null) {
      const n = document.createElement('span');
      n.className = 'count';
      n.textContent = String(count);
      button.append(n);
    }
    const sync = (): void => {
      button.classList.toggle('off', isOff());
      button.setAttribute('aria-pressed', String(!isOff()));
    };
    sync();
    button.addEventListener('click', () => {
      setOff(!isOff());
      sync();
      this.store();
      this.onChange({ highlight: isOff() ? null : type });
    });
    button.addEventListener('pointerenter', () => this.onChange({ highlight: isOff() ? null : type }));
    button.addEventListener('pointerleave', () => this.onChange({ highlight: null }));
    li.append(button);
    return li;
  }

  private setAll(hide: boolean): void {
    for (const { type } of poiCounts([this.pois.fixed, this.pois.extra])) {
      if (ALWAYS_SHOWN.includes(type)) continue;
      if (hide) this.pois.hidden.add(type);
      else this.pois.hidden.delete(type);
    }
    for (const { layer } of LAYERS) {
      if (hide) this.hiddenLayers.add(layer);
      else this.hiddenLayers.delete(layer);
    }
    this.built = '';
    this.refresh();
    this.store();
    this.onChange({ highlight: null });
  }

  private store(): void {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          hidden: [...this.pois.hidden].sort(),
          layers: [...this.hiddenLayers].sort(),
          folded: this.root.classList.contains('folded'),
        }),
      );
    } catch {
      // A browser that keeps nothing still has a legend; it only forgets.
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { hidden?: unknown; layers?: unknown; folded?: unknown };
      if (Array.isArray(saved.hidden)) {
        for (const type of saved.hidden) {
          if (typeof type === 'string' && type in POI_STYLES && !ALWAYS_SHOWN.includes(type as PoiType)) {
            this.pois.hidden.add(type as PoiType);
          }
        }
      }
      if (Array.isArray(saved.layers)) {
        for (const layer of saved.layers) {
          if (LAYERS.some((l) => l.layer === layer)) this.hiddenLayers.add(layer as MapLayer);
        }
      }
      if (saved.folded === true) this.root.classList.add('folded');
    } catch {
      // A choice that cannot be read is no choice: everything is shown.
    }
  }
}

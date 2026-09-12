/**
 * The map preview of the title screen: the world a seed builds, drawn whole
 * before the player commits to it.
 *
 * It draws through the same `MapArt` the minimap and the full map use, so what
 * the title screen shows is what the session will show. Building the world
 * blocks the frame loop for a second or two (`test/budgets.ts`, `worldGen`),
 * so a build is asked for rather than run on every key press: the screen says
 * what it is doing, lets the browser paint that, and only then generates.
 *
 * The world it built is kept, so the session that follows the title screen
 * reuses it instead of generating the same seed twice.
 */
import { generateWorld } from '../world/world.ts';
import type { WorldDescription } from '../world/types.ts';
import { MapArt } from './map-draw.ts';
import { fitWorldView, MapPois } from './map.ts';

/** Pixels across the preview canvas, before the device pixel ratio. */
const SIZE = 288;

/** Pixels across an icon on the preview: smaller than the full map, which is drawn far closer. */
const ICON = 9;

export class SeedPreview {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly status: HTMLElement;
  /** The world on screen, or null while nothing has been built yet. */
  private built: WorldDescription | null = null;
  /** Counts the builds asked for, so a build overtaken by a newer one is dropped. */
  private asked = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'title-preview';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'title-preview-map';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(SIZE * dpr);
    this.canvas.height = Math.round(SIZE * dpr);
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);

    this.status = document.createElement('p');
    this.status.className = 'title-preview-status';
    this.status.textContent = 'Press Build map to see this seed.';

    this.root.append(this.canvas, this.status);
    parent.append(this.root);
  }

  /** The world last built, or null. Its `seed` says which seed it belongs to. */
  get world(): WorldDescription | null {
    return this.built;
  }

  /**
   * Build `seed` and draw its map. A seed already on screen is drawn again
   * without being generated again, so pressing the button twice is free.
   */
  async build(seed: number): Promise<void> {
    if (this.built?.seed === seed) {
      this.draw(this.built);
      return;
    }
    const asked = ++this.asked;
    this.status.textContent = 'Building the map…';
    // The browser has to paint the line above before the main thread is taken
    // for a second or two, or the player sees nothing happen at all.
    await nextFrame();
    if (asked !== this.asked) return;

    const started = performance.now();
    const world = generateWorld(seed);
    const took = performance.now() - started;
    if (asked !== this.asked) return;

    this.built = world;
    this.draw(world);
    this.status.textContent = `${world.districts.length} districts · ${(took / 1000).toFixed(1)} s to build`;
  }

  private draw(world: WorldDescription): void {
    const art = new MapArt(world, new MapPois(world));
    this.ctx.clearRect(0, 0, SIZE, SIZE);
    art.draw(this.ctx, fitWorldView(world.size, SIZE, SIZE), SIZE, SIZE, {
      player: null,
      waypoint: null,
      iconSize: ICON,
      labels: false,
    });
  }
}

/** Resolve after the browser has painted: the second frame starts once the first is on screen. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

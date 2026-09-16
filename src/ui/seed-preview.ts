/**
 * The map preview of the title screen: the world a seed builds, drawn whole
 * before the player commits to it.
 *
 * It draws through the same `MapArt` the minimap and the full map use, so what
 * the title screen shows is what the session will show. Building the world
 * takes a second or more, so it is asked for rather than run on every key
 * press, and it is built in the worker of `world-source.ts`: the scene behind
 * the menu keeps turning while the map is built.
 *
 * The source holds the world it built, so the session that follows the title
 * screen reuses it instead of generating the same seed twice.
 */
import type { WorldSource } from '../render/world-source.ts';
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

  /** The button laid over the empty frame, until there is a map in it. */
  private readonly ask: HTMLButtonElement;
  /** Where the world of a seed is built, off the frame. */
  private readonly worlds: WorldSource;

  /** `onAsk` is what the button over the empty frame does: the title screen builds the seed in its box. */
  constructor(parent: HTMLElement, worlds: WorldSource, onAsk: () => void) {
    this.worlds = worlds;
    this.root = document.createElement('div');
    this.root.className = 'title-preview';

    const frame = document.createElement('div');
    frame.className = 'title-preview-frame';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'title-preview-map';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(SIZE * dpr);
    this.canvas.height = Math.round(SIZE * dpr);
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);

    this.ask = document.createElement('button');
    this.ask.type = 'button';
    this.ask.className = 'title-preview-ask';
    this.ask.dataset.nav = '';
    this.ask.textContent = 'Show the map';
    this.ask.addEventListener('click', onAsk);
    frame.append(this.canvas, this.ask);

    this.status = document.createElement('p');
    this.status.className = 'title-preview-status';
    this.status.textContent = 'The map takes a moment to build.';

    this.root.append(frame, this.status);
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
    this.root.classList.add('title-preview-busy');
    this.ask.hidden = true;

    const started = performance.now();
    let world: WorldDescription;
    try {
      world = await this.worlds.get(seed);
    } catch (error) {
      // A build the player overtook with another seed is given up on, and the
      // build that replaced it is the one that draws.
      if (asked !== this.asked) return;
      this.root.classList.remove('title-preview-busy');
      this.status.textContent = 'The map could not be built.';
      console.warn('the seed preview could not build its world', error);
      return;
    }
    const took = performance.now() - started;
    if (asked !== this.asked) return;

    this.built = world;
    this.root.classList.remove('title-preview-busy');
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

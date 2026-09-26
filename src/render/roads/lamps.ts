/**
 * The street lamps of a world (spec sections 10.5, 13.4).
 *
 * Two halves, because a lamp is two things:
 *
 * - {@link LampScenery} draws the masts. Every lamp of a chunk goes into one
 *   batch per cell (`batch.ts`), so a cell full of them costs one draw call, and every lens
 *   in the world lights at once off one uniform.
 * - {@link LampLights} throws the light. A light is paid for by every fragment
 *   it can reach, so only {@link LAMP_LIGHT_CAP} of them exist: the pool is
 *   aimed at the lamps nearest the player and follows them as the player moves.
 *   Every other lamp is a lit lens and no light, which is all a camera 60 m up
 *   can tell apart.
 *
 * The pool is built once and never grows or shrinks. Adding a light to a scene
 * rebuilds the shader of every material in it, so a pool that changed size at
 * dusk would stall the frame; the lights are dimmed to nothing by day instead.
 * A light at 0 costs a fragment nothing, because `lamp-light.ts` branches past it.
 */
import { Object3D, type Scene } from 'three';
import { fillsOf, tilePartOf, type BatchPart } from '../streaming/batch.ts';
import type { CellGrid } from '../streaming/cells.ts';
import type { EntityFade } from '../camera/fade.ts';
import { LampLight } from './lamp-light.ts';
import { createLampMaterials, type LampMaterials } from './lamp-material.ts';
import { buildChunkLamps, type Lamp } from './lamp-mesh.ts';
import { nearestOf } from '../frame/nearest.ts';
import type { TilePart } from '../streaming/streaming.ts';

/**
 * Street lamps that throw real light at once. The rest of the city's lamps are
 * lit lenses. This is a hard cap: a count over it is a regression, not a number
 * to raise, and it is what keeps the night inside the light budget of spec
 * section 10.5.
 */
export const LAMP_LIGHT_CAP = 8;

/** Candela of one lamp at full night, and the warm white it burns. */
const LAMP_INTENSITY = 130;
const LAMP_COLOUR = 0xffd9a0;

/**
 * The cone: how far it reaches, how wide it opens, how soft its edge is and how
 * fast it dims with distance. A `ProjectorLight` throws a rectangle rather than
 * a disc, which is the shape a real lamp lays on a road; its penumbra reads the
 * other way round from a spotlight's, so 0 is the softest edge it has.
 */
const LAMP_REACH = 40;
const LAMP_ANGLE = 0.7;
const LAMP_PENUMBRA = 0;
const LAMP_DECAY = 2;

/** Metres the player may move before the pool is aimed again. */
const RE_AIM = 6;

/** Where an unused light of the pool is parked: under the map, burning nothing. */
const PARKED = -10000;

/** The masts of a world's lamps: one material, and a batch for each cell of a chunk. */
export class LampScenery {
  private readonly materials: LampMaterials = createLampMaterials();

  /**
   * The material is dressed with the world's fade, so a mast near the draw
   * distance dithers away rather than popping (spec section 9.2).
   */
  constructor(fade: EntityFade) {
    fade.dress(this.materials.lamp);
  }

  /**
   * Put one chunk's lamps into the scene. The lamps come from the worker that
   * built the chunk (spec section 9.1), already in the places the scene works
   * in; the mast geometry is grown here, one copy per lit tier.
   *
   * The caller has already thinned the list to what the quality tier allows
   * (spec section 9.2), so the masts drawn are the lamps the light pool aims
   * at and no lamp is lit without a mast under it.
   */
  build(grid: CellGrid, lamps: readonly Lamp[]): TilePart {
    const parts: BatchPart[] = [];
    for (const tier of buildChunkLamps(lamps)) {
      for (const matrix of tier.matrices) parts.push({ geometry: tier.geometry, matrix });
    }
    // A lit lens is a bright point in the water at night, and the masts are a
    // few thousand triangles a chunk, so they are drawn in the mirror too
    // (`mirror.ts`).
    return tilePartOf(fillsOf(grid, parts, this.materials.lamp), { mirrored: true });
  }

  /** How far on the lenses are, 0 by day and 1 after dark. */
  set lamps(amount: number) {
    this.materials.lamps.value = amount;
  }

  get lamps(): number {
    return this.materials.lamps.value;
  }

  /** Release the material every chunk shared. */
  dispose(): void {
    this.materials.dispose();
  }
}

/** The fixed pool of lights the nearest lamps borrow. */
export class LampLights {
  readonly count = LAMP_LIGHT_CAP;
  private readonly lights: LampLight[] = [];
  private readonly targets: Object3D[] = [];
  private readonly scene: Scene;
  private atX = Infinity;
  private atY = Infinity;
  private stale = true;

  constructor(scene: Scene) {
    this.scene = scene;
    for (let i = 0; i < LAMP_LIGHT_CAP; i++) {
      const light = new LampLight(LAMP_COLOUR, 0, LAMP_REACH, LAMP_ANGLE, LAMP_PENUMBRA, LAMP_DECAY);
      light.position.set(PARKED, PARKED, PARKED);
      // A cone that casts is a shadow pass each; the sun's cascades are the
      // shadow budget of spec section 10.5 and these stay out of it.
      light.castShadow = false;
      const target = new Object3D();
      target.position.set(PARKED, PARKED - 1, PARKED);
      light.target = target;
      this.lights.push(light);
      this.targets.push(target);
      scene.add(light, target);
    }
  }

  /** Say that the lamps in reach have changed, so the next aim looks again. */
  invalidate(): void {
    this.stale = true;
  }

  /**
   * Hand the pool to the lamps nearest the player and burn them `amount` hard.
   * The pick is redone only when the player has moved {@link RE_AIM} metres or
   * a chunk has come or gone, because it walks every lamp in reach.
   */
  aim(x: number, y: number, tiles: readonly (readonly Lamp[])[], amount: number): void {
    const moved = (x - this.atX) ** 2 + (y - this.atY) ** 2 >= RE_AIM * RE_AIM;
    if (moved || this.stale) {
      this.atX = x;
      this.atY = y;
      this.stale = false;
      this.place(nearest(x, y, tiles));
    }
    for (const light of this.lights) {
      light.intensity = light.position.y > PARKED / 2 ? LAMP_INTENSITY * amount : 0;
    }
  }

  dispose(): void {
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i] as LampLight;
      const target = this.targets[i] as Object3D;
      this.scene.remove(light, target);
      light.dispose();
    }
  }

  /** Stand each light on a lamp, and park the ones no lamp needs. */
  private place(chosen: readonly Lamp[]): void {
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i] as LampLight;
      const target = this.targets[i] as Object3D;
      const lamp = chosen[i];
      if (lamp === undefined) {
        light.position.set(PARKED, PARKED, PARKED);
        target.position.set(PARKED, PARKED - 1, PARKED);
        continue;
      }
      light.position.set(lamp.headX, lamp.headHeight, lamp.headY);
      // Aimed across at the middle of the road rather than straight down: a
      // light pointing along its own up vector has no orientation to project
      // its rectangle in, and the lean is where a lamp throws its pool anyway.
      target.position.set(lamp.roadX, lamp.roadHeight, lamp.roadY);
    }
  }
}

/**
 * The {@link LAMP_LIGHT_CAP} lamps nearest a place, nearest first. The pick
 * itself is `nearest.ts`, which the neon of `signs.ts` shares; a lamp is
 * measured from its head, which is where its light hangs.
 */
export function nearest(x: number, y: number, tiles: readonly (readonly Lamp[])[]): Lamp[] {
  return nearestOf(x, y, tiles, LAMP_LIGHT_CAP, (lamp, atX, atY) => (lamp.headX - atX) ** 2 + (lamp.headY - atY) ** 2);
}

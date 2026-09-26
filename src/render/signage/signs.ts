/**
 * The advertising of a world in the scene (spec sections 13.1, 13.4).
 *
 * Two halves, because a neon sign is two things, and they are the two halves
 * `lamps.ts` splits a street lamp into for the same reason:
 *
 * - The **boards**. Every sign of a chunk goes into one batch per cell
 *   (`batch.ts`), so a cell full of them costs one draw call, and the boards of
 *   a whole city share the one material and the one generated atlas of
 *   `sign-material.ts`. A lit board glows off one uniform, so the high streets
 *   of the city light together at dusk.
 * - The **light they throw**. A light is paid for by every fragment it can
 *   reach, so only {@link NEON_LIGHT_CAP} of them exist: the pool is handed to
 *   the neon nearest the player and follows them as they drive. Every other
 *   sign is a glowing board and no light, which is all a camera 60 m up can
 *   tell apart.
 *
 * Only a fascia is handed a light. A billboard leans back over its roof (spec
 * section 10.7), so what it lights is the sky; it glows, and the street under it
 * is lit by the lamps.
 *
 * The pool is built once and never grows or shrinks, for the reason
 * `lamp-light.ts` gives: changing a scene's light list rebuilds the shader of
 * every material in it. A light at 0 costs a fragment nothing, because
 * `sign-light.ts` branches past it.
 *
 * Where the boards hang is `sign-mesh.ts`, and what they say is `sign-art.ts`.
 * Nothing here decides either.
 */
import { Color, type Scene } from 'three';
import { fillsOf, tilePartOf } from '../streaming/batch.ts';
import type { CellGrid } from '../streaming/cells.ts';
import type { EntityFade } from '../camera/fade.ts';
import { nearestOf } from '../frame/nearest.ts';
import { NeonLight } from './sign-light.ts';
import { createSignMaterials, type SignMaterials } from './sign-material.ts';
import { signParts, type Sign } from './sign-mesh.ts';
import type { TilePart } from '../streaming/streaming.ts';

/**
 * Neon signs that throw real light at once. The rest of the city's neon is a
 * glowing board. This is a hard cap: a count over it is a regression, not a
 * number to raise, and `sky.ts` holds it against the rest of the light budget
 * of spec section 10.5.
 */
export const NEON_LIGHT_CAP = 4;

/** Nits one sign's tube throws at full night. An area light is measured in the light off its surface. */
const NEON_INTENSITY = 45;

/** Where an unused light of the pool is parked: under the map, burning nothing. */
const PARKED = -10000;

/** Metres the player may move before the pool is aimed again. */
const RE_AIM = 6;

/** The boards of a world's signs, and the few of them that light the street. */
export class SignScenery {
  private readonly materials: SignMaterials = createSignMaterials();
  private readonly lights: NeonLights;
  /** The lit fascias of each chunk in the scene, so the pool can be handed to the nearest. */
  private readonly lit: Sign[][] = [];

  /**
   * The material is dressed with the world's fade, so a board near the draw
   * distance dithers away rather than popping (spec section 9.2).
   */
  constructor(fade: EntityFade, scene: Scene) {
    fade.dress(this.materials.sign);
    this.lights = new NeonLights(scene);
  }

  /**
   * Put one chunk's signs into the scene. They come from the worker that built
   * the chunk (spec section 9.1), already in the places the scene works in; the
   * quads are grown here, one per board.
   *
   * The lit fascias among them are kept until the tile is dropped, which is
   * what the returned part's `dispose` is wrapped for: a pool aimed at a chunk
   * that has gone would light an empty street.
   */
  build(grid: CellGrid, signs: readonly Sign[]): TilePart {
    const part = tilePartOf(fillsOf(grid, signParts(signs), this.materials.sign));
    const lit = signs.filter((sign) => sign.neon !== 0 && sign.tilt === 0);
    if (lit.length === 0) return part;
    this.lit.push(lit);
    this.lights.invalidate();
    const release = part.dispose;
    return {
      ...part,
      dispose: (): void => {
        const at = this.lit.indexOf(lit);
        if (at >= 0) this.lit.splice(at, 1);
        this.lights.invalidate();
        release();
      },
    };
  }

  /** How far on the neon is, 0 by day and 1 after dark. */
  set night(amount: number) {
    this.materials.neon.value = amount;
  }

  get night(): number {
    return this.materials.neon.value;
  }

  /** Hand the pool to the neon nearest the player, and burn it `amount` hard. */
  aim(x: number, y: number, amount: number): void {
    this.lights.aim(x, y, this.lit, amount);
  }

  /** Lights this holds, which is the whole pool whether or not it is burning. */
  get lightCount(): number {
    return this.lights.count;
  }

  /** Release the material, the texture and the pool every chunk shared. */
  dispose(): void {
    this.lit.length = 0;
    this.lights.dispose();
    this.materials.dispose();
  }
}

/** The fixed pool of lights the nearest neon signs borrow. */
class NeonLights {
  readonly count = NEON_LIGHT_CAP;
  private readonly lights: NeonLight[] = [];
  private readonly scene: Scene;
  private readonly colour = new Color();
  private atX = Infinity;
  private atY = Infinity;
  private stale = true;

  constructor(scene: Scene) {
    this.scene = scene;
    for (let i = 0; i < NEON_LIGHT_CAP; i++) {
      const light = new NeonLight(0xffffff, 0, 1, 1);
      light.position.set(PARKED, PARKED, PARKED);
      this.lights.push(light);
      scene.add(light);
    }
  }

  /** Say that the signs in reach have changed, so the next aim looks again. */
  invalidate(): void {
    this.stale = true;
  }

  /**
   * The pick is redone only when the player has moved {@link RE_AIM} metres or
   * a chunk has come or gone, because it walks every sign in reach.
   */
  aim(x: number, y: number, tiles: readonly (readonly Sign[])[], amount: number): void {
    const moved = (x - this.atX) ** 2 + (y - this.atY) ** 2 >= RE_AIM * RE_AIM;
    if (moved || this.stale) {
      this.atX = x;
      this.atY = y;
      this.stale = false;
      this.place(nearestOf(x, y, tiles, NEON_LIGHT_CAP, span));
    }
    for (const light of this.lights) {
      light.intensity = light.position.y > PARKED / 2 ? NEON_INTENSITY * amount : 0;
    }
  }

  dispose(): void {
    for (const light of this.lights) {
      this.scene.remove(light);
      light.dispose();
    }
  }

  /** Stand each light on a sign, and park the ones no sign needs. */
  private place(chosen: readonly Sign[]): void {
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i] as NeonLight;
      const sign = chosen[i];
      if (sign === undefined) {
        light.position.set(PARKED, PARKED, PARKED);
        continue;
      }
      light.position.set(sign.x, sign.height, sign.y);
      light.width = sign.width;
      light.height = sign.tall;
      light.color.copy(this.colour.setHex(sign.neon));
      // A light is aimed with `lookAt`, which points its own -z at the target;
      // for a rect area light that is the face the light comes off. The target
      // is a metre out from the board, over the pavement it is read from.
      light.lookAt(sign.x + sign.outX, sign.height, sign.y + sign.outY);
    }
  }
}

/** How far a sign stands from a place, squared, which is what the pick orders by. */
function span(sign: Sign, x: number, y: number): number {
  return (sign.x - x) ** 2 + (sign.y - y) ** 2;
}

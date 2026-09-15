/**
 * The near-camera fade of spec section 9.2.
 *
 * The streaming rings have an edge. A tree or a street lamp on the far side of
 * it does not exist; one metre nearer it is drawn whole. Driving across that
 * line pops a whole chunk of woodland into the frame at once, and the haze does
 * not cover it: the haze opens where the near ring ends, so at the lower
 * quality tiers, where the rings are pulled in, the line stands in clear air.
 *
 * The fix is to dither the last stretch away. A fragment inside
 * {@link FADE_BAND} of the draw distance is kept or thrown away depending on
 * where it falls in a 4×4 Bayer matrix laid over the screen: a surface fading
 * out loses a regular scatter of its pixels, and loses more of them the further
 * off it stands. Nothing is blended, so nothing has to be sorted back to front,
 * which is what spec section 9.2 and the addon table of spec section 22.1 ask
 * for. It costs one `discard` and no draw call.
 *
 * The distance is measured from the player and not from the camera, because the
 * rings are. The camera of spec section 10.7 stands behind and above the player
 * and leads them at speed, so a ring measured from it would sit off-centre and
 * would slide about as the car turned.
 */
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import { floor, fract, positionWorld, screenCoordinate, smoothstep, uniform, type TslNode } from './tsl.ts';

/**
 * Metres an entity fades over before it is gone. Wide enough that the dither
 * reads as a surface thinning out rather than as a hole opening, and narrow
 * enough to stand inside the ring it fades at.
 */
export const FADE_BAND = 30;

/**
 * How far entities are drawn, and where that is measured from.
 *
 * One of these serves a whole world: the plants and the street lamps read the
 * same two uniforms, so a change of quality tier moves every category at once
 * and no material is rebuilt.
 */
export class EntityFade {
  private readonly atX = uniform(0);
  private readonly atY = uniform(0);
  private readonly gone: { value: number } & TslNode;

  constructor(distance: number) {
    this.gone = uniform(distance);
  }

  /** Stand the rings on the player. Called once a frame, as the scene follows them. */
  focus(x: number, y: number): void {
    this.atX.value = x;
    this.atY.value = y;
  }

  /** Metres at which an entity is gone. The fade opens {@link FADE_BAND} before it. */
  get distance(): number {
    return this.gone.value;
  }

  set distance(metres: number) {
    this.gone.value = metres;
  }

  /**
   * Fade a material's fragments out over the band.
   *
   * `opacityNode` carries how much of the surface survives and `alphaTestNode`
   * the threshold it is measured against, because `NodeMaterial` already
   * discards a fragment whose alpha falls to or below the test. The material
   * stays opaque: every fragment that survives is written at full strength.
   *
   * The shadow pass reads neither of them, and cannot be made to: it draws the
   * whole scene through one override material shared by every object and
   * copies only the numeric `alphaTest` across. A plant inside the band would
   * therefore keep a whole shadow standing on empty ground. What keeps the two
   * in step is `shadowDistance` in `quality.ts`, which stops the sun's shadow
   * before the band starts.
   */
  dress(material: MeshStandardNodeMaterial): void {
    const dx = positionWorld.x.sub(this.atX);
    const dy = positionWorld.z.sub(this.atY);
    const span = dx.mul(dx).add(dy.mul(dy)).sqrt();
    material.opacityNode = smoothstep(this.gone.sub(FADE_BAND), this.gone, span).oneMinus();
    material.alphaTestNode = bayer4(screenCoordinate);
  }
}

/**
 * The ordered dither: a number in 0..15/16 per pixel, laid out as the 4×4 Bayer
 * matrix. Built by the recursion that defines the matrix rather than read from
 * a texture, so it needs no image and no upload:
 *
 * ```
 *  0  8  2 10
 * 12  4 14  6
 *  3 11  1  9
 * 15  7 13  5
 * ```
 *
 * The coordinate is wrapped to the tile before anything is squared. A screen
 * coordinate is thousands of pixels, and thousands squared has no fractional
 * part left in a 32-bit float, so a pattern taken from the raw coordinate comes
 * out in bands.
 */
export function bayer4(at: TslNode): TslNode {
  const tile = wrap(at, 4);
  return bayer2(tile.mul(0.5)).mul(0.25).add(bayer2(tile));
}

/** The 2×2 matrix the recursion above is built out of: 0, 2, 3, 1 over four. */
function bayer2(at: TslNode): TslNode {
  const x = floor(at.x);
  const y = floor(at.y);
  return fract(x.div(2).add(y.mul(y).mul(0.75)));
}

/** A coordinate brought back inside a tile of `size` pixels. */
function wrap(at: TslNode, size: number): TslNode {
  const whole = floor(at);
  return whole.sub(floor(whole.div(size)).mul(size));
}

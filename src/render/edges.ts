/**
 * The ink lines of the art style (spec section 10.1, `docs/art-style.md`).
 *
 * One screen-space pass draws every line in the city, on the frame the scene
 * pass left, before the bloom reads it. It reads the depth and nothing else.
 *
 * On a plane, the inverse of view depth is linear across the screen, whatever
 * way the plane faces. So its second difference over a pixel and its two
 * neighbours is zero on any flat face, however steep, and non-zero only where
 * the surface bends or breaks:
 *
 * - a large second difference is a **silhouette**: one surface stands in front
 *   of another. Both pixels of the step see it, so the line is two pixels wide;
 * - a small one is a **crease**: the surface turns a corner, as at a roof edge,
 *   a kerb or the corner of a car. It is drawn fainter, so it reads thinner.
 *
 * The width is in pixels of the frame, so it is the same near and far. Far off
 * the ink fades toward the colour behind it, as the haze takes the city.
 *
 * Seams on a flat surface have no depth to find — road slabs, lane lines,
 * window frames — so they are painted into the materials instead.
 *
 * The sky writes no depth and the water's mirror is a picture on a flat sheet,
 * so neither draws a line of its own. The See-through camera of spec section
 * 10.7 cuts holes in a building in a dither, and a hole is a depth step: every
 * sample the cut ghosts is set aside, and a ghosted pixel draws no line.
 */
import type { Camera } from 'three';
import { Color } from 'three';
import {
  float,
  getViewPosition,
  max,
  mix,
  perspectiveDepthToViewZ,
  screenSize,
  screenUV,
  smoothstep,
  step,
  uniformMatrix,
  vec2,
  vec3,
  vec4,
  type TslNode,
} from './tsl.ts';

/** The ink: a warm dark plum, never pure black. */
const INK = 0x2a2430;

/**
 * Where the second difference of inverse depth, as a share of the pixel's own,
 * turns into a line. A car stands out of the road by far more than
 * {@link SILHOUETTE}; a right angle seen from the game camera bends it by
 * about a tenth of a percent, which is past {@link CREASE}.
 */
const SILHOUETTE: readonly [number, number] = [0.003, 0.006];
const CREASE: readonly [number, number] = [0.0004, 0.0009];

/** How dark a crease is against a silhouette, which is what makes it read thinner. */
const CREASE_INK = 0.7;

/** Metres of view depth over which the ink fades toward the colour behind it. */
const FADE: readonly [number, number] = [140, 420];

/** How much ink is left at the far end of {@link FADE}. */
const FAR_INK = 0.25;

/**
 * The See-through cut (`cutaway.ts`): for a ray from the camera, how much of
 * the place a distance along it the cut ghosts, 0 to 1.
 */
export interface Ghost {
  ghostAlong(direction: TslNode): (distance: TslNode) => TslNode;
}

/** What the edge pass reads off the scene pass. */
export interface EdgeSource {
  /** The scene pass's depth texture. */
  depth: TslNode;
  /** The near and far planes of the camera the scene pass was drawn with. */
  near: TslNode;
  far: TslNode;
}

/**
 * The frame with the ink laid over it. `colour` is the scene pass's colour,
 * in exposed linear light.
 */
export function inked(colour: TslNode, source: EdgeSource, camera: Camera, ghost?: Ghost): TslNode {
  const texel = vec2(1, 1).div(screenSize);
  const projectionInverse = uniformMatrix(camera.projectionMatrixInverse);
  const world = uniformMatrix(camera.matrixWorld);

  /** The inverse view depth at a pixel's offset, and the view depth itself. */
  const sample = (dx: number, dy: number): { depth: TslNode; inverse: TslNode; distance: TslNode } => {
    const depth = source.depth.sample(screenUV.add(vec2(dx, dy).mul(texel))).r;
    const distance = perspectiveDepthToViewZ(depth, source.near, source.far).negate();
    return { depth, inverse: float(1).div(distance), distance };
  };
  const centre = sample(0, 0);

  // The cut is tested along the centre's own ray. A neighbour is a pixel off
  // it, and the cone does not turn in a pixel, so only its depth is its own.
  let ghosted: (distance: TslNode) => TslNode = () => float(0);
  if (ghost !== undefined) {
    const view = getViewPosition(screenUV, centre.depth, projectionInverse);
    const stretch = view.length().div(view.z.negate());
    const along = ghost.ghostAlong(world.mul(vec4(view, 0)).xyz.normalize());
    ghosted = (distance) => step(0.05, along(distance.mul(stretch)));
  }

  // A pair with a ghosted pixel in it measures nothing, so a hole the dither
  // cut next to this pixel is no step. Reading the ghost as the centre instead
  // leaves a first difference, which is not zero on a plane, and it drew the
  // edge of the cut as a line.
  const bend = (dx: number, dy: number): TslNode => {
    const a = sample(-dx, -dy);
    const b = sample(dx, dy);
    const kept = float(1).sub(max(ghosted(a.distance), ghosted(b.distance)));
    return a.inverse.add(b.inverse).sub(centre.inverse.mul(2)).abs().mul(kept);
  };
  const across = bend(1, 0);
  const down = bend(0, 1);
  const measure = max(across, down).div(centre.inverse);

  const silhouette = smoothstep(SILHOUETTE[0], SILHOUETTE[1], measure);
  const crease = smoothstep(CREASE[0], CREASE[1], measure).mul(CREASE_INK);
  const far = mix(float(1), float(FAR_INK), smoothstep(FADE[0], FADE[1], centre.distance));
  const line = max(silhouette, crease).mul(far).mul(float(1).sub(ghosted(centre.distance)));

  const ink = new Color(INK);
  return vec4(mix(colour.rgb, vec3(ink.r, ink.g, ink.b), line), 1);
}

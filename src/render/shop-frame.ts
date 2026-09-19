/**
 * Where the camera of the shop preview stands (spec section 16.1), as plain
 * arithmetic so a test can check it without a renderer.
 *
 * A model on the plinth turns, so the camera has to hold it at every angle it
 * turns through. A figure spins all the way round. A weapon only sways about
 * the view from its side, which is how a long gun fills a wide window: a full
 * turn would show it end on for half the time and leave the window empty.
 *
 * The fit is exact rather than a bounding sphere. The corners of the model's
 * box and the rim of the plinth are turned through the angles the model will
 * take, projected onto the view, and the camera stands just far enough back to
 * hold the widest and the tallest of them.
 */

/** How the plinth turns: all the way round, or back and forth about one view. */
export interface Motion {
  /** The angle about the vertical the model faces at rest, in radians. */
  rest: number;
  /** How far either side of `rest` it turns; a full turn is `Math.PI`. */
  swing: number;
}

/** A model that spins all the way round. */
export const SPIN: Motion = { rest: 0, swing: Math.PI };

/**
 * A weapon: turned a little towards the camera from a side view, with the
 * muzzle to the right, and swaying 0.45 rad either side of it.
 */
export const SWAY: Motion = { rest: -0.45, swing: 0.45 };

/** A box standing on the plinth, in the plinth's frame: `y` up, the plinth's axis through the origin. */
export interface Bounds {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/** The view the camera takes: its field of view, its shape and how far it looks down. */
export interface View {
  /** The vertical field of view, in degrees. */
  fov: number;
  /** Width over height. */
  aspect: number;
  /** Radians the camera looks down from level. */
  tilt: number;
  /** How much room is left round the model: 1 touches the edges. */
  margin: number;
}

/** Where the camera stands and what it looks at, both on the plinth's axis. */
export interface Aim {
  /** Height of the point looked at. */
  target: number;
  /** Distance from that point to the camera. */
  distance: number;
}

/** How many angles a turn is sampled at. A box between two samples bulges by under half a percent. */
const SAMPLES = 24;

/**
 * The points that have to stay in the window: the eight corners of the box,
 * and the rim of the plinth at its top and its foot.
 */
function points(box: Bounds, plinth: { radius: number; top: number; bottom: number }): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) out.push([x, y, z]);
    }
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 2 * Math.PI;
    const x = Math.cos(a) * plinth.radius;
    const z = Math.sin(a) * plinth.radius;
    out.push([x, plinth.top, z], [x, plinth.bottom, z]);
  }
  return out;
}

/** The angles a motion is sampled at: a full turn, or the arc it sways through. */
export function anglesOf(motion: Motion): number[] {
  const out: number[] = [];
  if (motion.swing >= Math.PI) {
    for (let i = 0; i < SAMPLES; i++) out.push(motion.rest + (i / SAMPLES) * 2 * Math.PI);
    return out;
  }
  for (let i = 0; i <= SAMPLES; i++) out.push(motion.rest - motion.swing + (i / SAMPLES) * 2 * motion.swing);
  return out;
}

/**
 * Stand the camera where it holds every point at every angle. The target is
 * then moved to the middle of what is seen, so a model is centred in the
 * window rather than on its own middle, which the perspective pushes off.
 */
export function aimAt(
  box: Bounds,
  plinth: { radius: number; top: number; bottom: number },
  motion: Motion,
  view: View,
): Aim {
  const tanV = Math.tan(((view.fov / 2) * Math.PI) / 180) / view.margin;
  const tanH = tanV * view.aspect;
  const up = [0, Math.cos(view.tilt), -Math.sin(view.tilt)] as const;
  const back = [0, Math.sin(view.tilt), Math.cos(view.tilt)] as const;
  // Every point at every angle, turned about the plinth's axis.
  const turned: [number, number, number][] = [];
  for (const angle of anglesOf(motion)) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    for (const [x, y, z] of points(box, plinth)) turned.push([c * x + s * z, y, -s * x + c * z]);
  }
  const fit = (target: number): number => {
    let distance = 0;
    for (const [x, y, z] of turned) {
      const dy = y - target;
      const high = dy * up[1] + z * up[2];
      const near = dy * back[1] + z * back[2];
      distance = Math.max(distance, Math.abs(x) / tanH + near, Math.abs(high) / tanV + near);
    }
    return distance;
  };
  let target = (box.min[1] + box.max[1]) / 2;
  for (let pass = 0; pass < 3; pass++) {
    const distance = fit(target);
    // Where the highest and the lowest point land on the screen, and the
    // height that would put their middle in the middle of the window.
    let top = -Infinity;
    let bottom = Infinity;
    for (const [, y, z] of turned) {
      const dy = y - target;
      const high = (dy * up[1] + z * up[2]) / (distance - (dy * back[1] + z * back[2]));
      top = Math.max(top, high);
      bottom = Math.min(bottom, high);
    }
    target += (((top + bottom) / 2) * distance) / up[1];
  }
  const distance = fit(target);
  return { target, distance };
}

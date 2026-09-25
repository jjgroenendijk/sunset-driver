/**
 * Where the crowd can be touched (spec sections 11.6, 13.1).
 *
 * The people on the pavement stand in no physics world: a person is a loop, a
 * fright or a casualty, evaluated at a tick. So a round, a blast or a car
 * finds them here, by geometry, rather than by a Rapier cast. A person on
 * their feet is an upright cylinder; a person lying down is a row of three
 * balls along their body; a person in the air is one ball.
 *
 * Every walk over the crowd goes in id order and then over the casualties in
 * id order, so what a round meets first is the same in a replay.
 */
import { cos, hypot, sin } from '../core/libm.ts';
import { casualtyPose, emptyCasualtyPose, upright, type Casualty, type CasualtyPose } from './casualty-motion.ts';
import { crowdPoseOf, type PedestrianPose, type PedestrianState } from './pedestrians.ts';

/** Metres round the line down a standing person's middle that a round meets them in. */
export const BODY_RADIUS = 0.3;

/** Metres of a standing person a round meets them over, from the feet up. */
const BODY_HEIGHT = 1.8;

/** Metres across each of the three balls a lying body is met in, and how far apart they are. */
const LYING_RADIUS = 0.25;
const LYING_SPACING = 0.6;

/** Metres of a ray each box of the crowd is read over. */
const RAY_CHUNK = 20;

/** What the crowd has to answer for a touch: who is near a box, and where they stand. */
export interface CrowdLookup {
  near(minX: number, minY: number, maxX: number, maxY: number, out: number[]): number[];
  poseAt(id: number, time: number, out: PedestrianPose): PedestrianPose;
}

/** A person a line met, how far along it, and where they stood. */
export interface PersonHit {
  id: number;
  /** Metres along the line. */
  t: number;
  x: number;
  y: number;
  height: number;
  heading: number;
}

/**
 * The first person a line meets, within `max` metres of its start, or
 * undefined where it meets nobody. The line runs from `(ox, oh, oy)` along the
 * unit direction `(dx, dh, dy)`, in map metres with `h` up.
 */
export function personOnRay(
  crowd: CrowdLookup,
  state: PedestrianState,
  time: number,
  ox: number,
  oh: number,
  oy: number,
  dx: number,
  dh: number,
  dy: number,
  max: number,
  ids: number[] = [],
): PersonHit | undefined {
  let best: PersonHit | undefined;
  const pose: PedestrianPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' };
  const consider = (id: number, t: number, x: number, y: number, height: number, heading: number): void => {
    if (t < 0 || t > max || (best !== undefined && t >= best.t)) return;
    best = { id, t, x, y, height, heading };
  };
  for (let from = 0; from < max; from += RAY_CHUNK) {
    const to = Math.min(max, from + RAY_CHUNK);
    const ax = ox + dx * from;
    const ay = oy + dy * from;
    const bx = ox + dx * to;
    const by = oy + dy * to;
    const pad = BODY_RADIUS + 0.1;
    crowd.near(Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.max(ax, bx) + pad, Math.max(ay, by) + pad, ids);
    for (const id of ids) {
      if (crowdPoseOf(crowd, state, id, time, pose) === undefined) continue;
      const t = rayCylinder(ox, oh, oy, dx, dh, dy, pose.x, pose.y, pose.height, BODY_RADIUS, BODY_HEIGHT);
      if (t !== undefined) consider(id, t, pose.x, pose.y, pose.height, pose.heading);
    }
  }
  const hurt = emptyCasualtyPose();
  for (const record of state.casualties) {
    if (record.gone) continue;
    const t = rayCasualty(record, time, hurt, ox, oh, oy, dx, dh, dy);
    if (t !== undefined) consider(record.id, t, hurt.x, hurt.y, hurt.height, hurt.heading);
  }
  return best;
}

/** How far along a line it meets a casualty as they are posed at a moment, or undefined. */
function rayCasualty(
  record: Casualty,
  time: number,
  pose: CasualtyPose,
  ox: number,
  oh: number,
  oy: number,
  dx: number,
  dh: number,
  dy: number,
): number | undefined {
  casualtyPose(record, time, pose);
  if (upright(pose)) return rayCylinder(ox, oh, oy, dx, dh, dy, pose.x, pose.y, pose.height, BODY_RADIUS, BODY_HEIGHT);
  if (pose.phase === 'air') return raySphere(ox, oh, oy, dx, dh, dy, pose.x, pose.height + pose.lift + 0.5, pose.y, 0.45);
  let nearest: number | undefined;
  for (let k = -1; k <= 1; k++) {
    const cx = pose.x + cos(pose.dir) * LYING_SPACING * k;
    const cy = pose.y + sin(pose.dir) * LYING_SPACING * k;
    const t = raySphere(ox, oh, oy, dx, dh, dy, cx, pose.height + LYING_RADIUS, cy, LYING_RADIUS);
    if (t !== undefined && (nearest === undefined || t < nearest)) nearest = t;
  }
  return nearest;
}

/**
 * Every person within `radius` of a place on the map, in id order and then
 * the casualties in id order. `visit` is handed where each one stands.
 */
export function peopleNear(
  crowd: CrowdLookup,
  state: PedestrianState,
  time: number,
  x: number,
  y: number,
  radius: number,
  visit: (id: number, pose: PedestrianPose, lying: boolean) => void,
  ids: number[] = [],
): void {
  const pose: PedestrianPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' };
  for (const id of crowd.near(x - radius, y - radius, x + radius, y + radius, ids)) {
    if (crowdPoseOf(crowd, state, id, time, pose) === undefined) continue;
    if (hypot(pose.x - x, pose.y - y) > radius) continue;
    visit(id, pose, false);
  }
  const hurt = emptyCasualtyPose();
  for (const record of [...state.casualties]) {
    if (record.gone) continue;
    casualtyPose(record, time, hurt);
    if (hypot(hurt.x - x, hurt.y - y) > radius) continue;
    pose.x = hurt.x;
    pose.y = hurt.y;
    pose.height = hurt.height;
    pose.heading = hurt.heading;
    visit(record.id, pose, !upright(hurt));
  }
}

/**
 * Where a line first enters an upright cylinder standing on `(cx, ch, cy)`,
 * or undefined where it misses. A line that starts inside meets it at once.
 */
function rayCylinder(
  ox: number,
  oh: number,
  oy: number,
  dx: number,
  dh: number,
  dy: number,
  cx: number,
  cy: number,
  ch: number,
  radius: number,
  height: number,
): number | undefined {
  const flat = dx * dx + dy * dy;
  const rx = ox - cx;
  const ry = oy - cy;
  let t: number;
  if (flat < 1e-9) {
    if (rx * rx + ry * ry > radius * radius) return undefined;
    t = 0;
  } else {
    const b = rx * dx + ry * dy;
    const c = rx * rx + ry * ry - radius * radius;
    const disc = b * b - flat * c;
    if (disc < 0) return undefined;
    t = c <= 0 ? 0 : (-b - Math.sqrt(disc)) / flat;
    if (t < 0) return undefined;
  }
  const h = oh + dh * t - ch;
  return h >= 0 && h <= height ? t : undefined;
}

/** Where a line first enters a ball, or undefined where it misses. */
function raySphere(
  ox: number,
  oh: number,
  oy: number,
  dx: number,
  dh: number,
  dy: number,
  cx: number,
  ch: number,
  cy: number,
  radius: number,
): number | undefined {
  const rx = ox - cx;
  const rh = oh - ch;
  const ry = oy - cy;
  const b = rx * dx + rh * dh + ry * dy;
  const c = rx * rx + rh * rh + ry * ry - radius * radius;
  if (c <= 0) return 0;
  const disc = b * b - c;
  if (disc < 0) return undefined;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : undefined;
}

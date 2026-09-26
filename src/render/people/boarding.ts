/**
 * The body getting into a vehicle and out of it, drawn (spec sections 11.2,
 * 11.5).
 *
 * `src/sim/player/boarding.ts` says that a move is running, which way, through which
 * side, and since which tick. This says where the body is at each moment of it:
 * where the feet stand and which way they face, in the vehicle's own frame, the
 * angle of every joint, and how far the door stands open. It holds no three.js,
 * so every frame of the move is read and tested headless; `world-scene.ts`
 * puts the answer on the model.
 *
 * A car is got into in four beats: the walk to the door, the hand on the
 * handle as the door swings out, the body turned and lowered into the seat
 * with the head ducked under the roof, and the reach out to pull the door shut.
 * Getting out is the door pushed open, the legs swung out and the body stood up
 * beside the car, a step clear, and the door pushed shut. A bike has no door:
 * the rider walks to its side and swings a leg over the saddle, and gets off
 * the same way. A class with no door that swings — a bus, a truck, a boat —
 * gets the car's beats with the hand on the frame and nothing opening.
 *
 * The frame is the vehicle's: forward along `+x`, up `+y`, and the driver's
 * side at `-z`. The move ends where the record puts the player, at the door
 * and facing the way the vehicle faces, so nothing jumps when it hands back to
 * the walk.
 */
import type { HoldRig } from './character-hold.ts';
import { pointArm } from './character-hold.ts';
import { poseFor, restPose, STRIDE, type CharacterPose } from './character-pose.ts';
import { ridePose } from '../vehicles/rider.ts';
import { doorOf, saddleOf, seatOf, type Door } from '../vehicles/vehicle-mesh.ts';
import { DOOR_STAND, doorAlong, type BoardingWay } from '../../sim/player/boarding.ts';
import { EXIT_CLEARANCE, WALK_SPEED } from '../../sim/player/on-foot.ts';
import type { VehicleSpec } from '../../sim/vehicles/vehicle.ts';

/** Radians a door swings out to, fully open. */
export const DOOR_OPEN = 1.15;

/** Radians a seated driver leans back from upright. */
const RECLINE = 0.3;

/** Metres of headroom kept between the top of a seated head and the roof. */
const HEADROOM = 0.06;

/** What the move is drawn for: the body, the vehicle and the moment. */
export interface BoardingInput {
  way: BoardingWay;
  /** -1 for the driver's side, +1 for the other. */
  side: number;
  /** 0 to 1: how far through the move the body is. */
  progress: number;
  /** How much of the move is the walk to the door, 0 to 1 (`walkShare`). */
  walk: number;
  spec: VehicleSpec;
  /** Metres from the soles to the hips, the height of the body and its arms. */
  hipsAt: number;
  stature: number;
  rig: HoldRig;
  /**
   * Where the feet stood when a move in began, in the vehicle's frame, and the
   * way the body faced there. Unused for a move out.
   */
  fromX: number;
  fromY: number;
  fromZ: number;
  fromYaw: number;
  /** The height of the ground under the vehicle, in its frame. */
  ground: number;
}

/** Where the body is and how it stands at one moment of a move. */
export interface BoardingFrame {
  /** Where the feet are, in the vehicle's frame: the origin of the model. */
  x: number;
  y: number;
  z: number;
  /** Radians the body is turned about up from facing the vehicle's forward. */
  yaw: number;
  pose: CharacterPose;
  /** Radians the door on the side of the move stands open. */
  door: number;
}

/** A place in the vehicle's frame, and which way the body faces there. */
interface Spot {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Slow at both ends and quick in the middle, for a share already between 0 and 1. */
function ease(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** How far `u` is through the span from `a` to `b`, held between 0 and 1. */
function span(u: number, a: number, b: number): number {
  return Math.min(1, Math.max(0, (u - a) / (b - a)));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Turn from one angle to another the short way round. */
function turn(a: number, b: number, t: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

function mixSpot(a: Spot, b: Spot, t: number): Spot {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t), yaw: turn(a.yaw, b.yaw, t) };
}

/** Every joint of one pose mixed toward another's. */
function blendPose(a: CharacterPose, b: CharacterPose, t: number): CharacterPose {
  const out = restPose();
  for (const key of Object.keys(out) as (keyof CharacterPose)[]) out[key] = lerp(a[key], b[key], t);
  return out;
}

/** A driver in the seat: thighs level, shins down, leaning back, hands on the wheel. */
function seatedPose(): CharacterPose {
  const pose = restPose();
  pose.thighL = 1.45;
  pose.thighR = 1.45;
  pose.kneeL = -1.45;
  pose.kneeR = -1.45;
  pose.lean = -RECLINE;
  pose.armL = 1.0;
  pose.armR = 1.0;
  return pose;
}

/** The yaw that faces the body along `(dx, dz)` in the vehicle's frame. */
function facing(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

/**
 * Where the rear edge of a door is with the door `angle` open: the handle
 * outside, the pull inside. The door turns about its front edge, out to the
 * side it is on.
 */
function doorEdge(door: Door, angle: number): { x: number; z: number } {
  const out = Math.sign(door.z);
  return { x: door.hingeX - door.length * Math.cos(angle), z: door.z + out * door.length * Math.sin(angle) };
}

/**
 * Point the arm nearer the vehicle at a place in the vehicle's frame, mixed in
 * by `weight`. The near arm is the right one for a body on the driver's side
 * facing forward, since the car is on their right.
 */
function reachFor(
  pose: CharacterPose,
  at: Spot,
  target: readonly [number, number, number],
  input: BoardingInput,
  right: boolean,
  weight: number,
): void {
  if (weight <= 0) return;
  const dx = target[0] - at.x;
  const dy = target[1] - (at.y + input.hipsAt + pose.bob);
  const dz = target[2] - at.z;
  const c = Math.cos(at.yaw);
  const s = Math.sin(at.yaw);
  const body: [number, number, number] = [dx * c - dz * s, dy, dx * s + dz * c];
  const shoulder: [number, number, number] = [0, input.rig.shoulderY, (right ? 1 : -1) * input.rig.shoulderX];
  const aim = pointArm(shoulder, body, pose.twist);
  if (right) {
    pose.armR = lerp(pose.armR, aim.arm, weight);
    pose.yawR = lerp(pose.yawR, aim.yaw, weight);
  } else {
    pose.armL = lerp(pose.armL, aim.arm, weight);
    pose.yawL = lerp(pose.yawL, aim.yaw, weight);
  }
}

/**
 * The walk along a path of spots, `t` of the way, with the legs keeping pace
 * with the ground. The body turns from the way it faced to the way it walks
 * over the first steps, and to `end` over the last.
 */
function walkBetween(path: readonly Spot[], t: number, end: number, stature: number): { at: Spot; pose: CharacterPose } {
  const lengths = path.slice(1).map((p, i) => Math.hypot(p.x - (path[i] as Spot).x, p.z - (path[i] as Spot).z));
  const total = lengths.reduce((a, b) => a + b, 0);
  let left = total * ease(t);
  let at = path[path.length - 1] as Spot;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i] as number;
    const a = path[i] as Spot;
    const b = path[i + 1] as Spot;
    if (left <= length || i === lengths.length - 1) {
      const share = length > 1e-6 ? Math.min(1, left / length) : 1;
      at = { ...mixSpot(a, b, share), yaw: length > 0.05 ? facing(b.x - a.x, b.z - a.z) : a.yaw };
      break;
    }
    left -= length;
  }
  at.yaw = turn((path[0] as Spot).yaw, at.yaw, ease(span(t, 0, 0.2)));
  at.yaw = turn(at.yaw, end, ease(span(t, 0.7, 1)));
  const covered = total * ease(t);
  const moving = total > 0.05 && t < 1;
  const speed = moving ? WALK_SPEED : 0;
  const pose = poseFor(moving ? 'walk' : 'stand', (covered / STRIDE) * 2 * Math.PI, {
    speed,
    grounded: true,
    vy: 0,
    depth: 0,
    stature,
  });
  return { at, pose };
}

/**
 * The path from where the player stood to `stand`: round the nose or the tail
 * first when they stood in front of the vehicle or behind it, so the walk
 * does not cut through the body. The height of the feet runs from where they
 * stood down or up to the ground by the door.
 */
function approach(input: BoardingInput, stand: Spot): Spot[] {
  const from: Spot = { x: input.fromX, y: input.fromY, z: input.fromZ, yaw: input.fromYaw };
  const path = [from];
  if (Math.abs(input.fromZ) < Math.abs(stand.z)) path.push({ ...from, y: stand.y, z: stand.z });
  path.push(stand);
  return path;
}

/** The seat for this body: the hips on it, low enough that the head clears the roof. */
function seatSpot(input: BoardingInput): Spot {
  const seat = seatOf(input.spec);
  const clear = input.spec.halfHeight - HEADROOM - (input.stature - input.hipsAt) * Math.cos(RECLINE);
  const hips = Math.min(seat.y, clear);
  return { x: seat.x, y: hips - input.hipsAt, z: seat.z, yaw: 0 };
}

/**
 * The door a move goes through. A class with a door that swings has it; one
 * without is given a door's worth of flank from where the player stands to
 * get in (`doorAlong`), which the hand takes hold of and which does not open.
 */
function doorFor(input: BoardingInput): { door: Door; swings: boolean } {
  const door = doorOf(input.spec, input.side);
  if (door !== undefined) return { door, swings: true };
  const seat = seatOf(input.spec);
  const length = 0.9;
  const z = input.side * input.spec.halfWidth;
  return { door: { hingeX: doorAlong(input.spec) + length, length, z, y: seat.y, height: 0.5 }, swings: false };
}

/** Where the body is `progress` of the way through a move. */
export function boardingFrame(input: BoardingInput): BoardingFrame {
  if (saddleOf(input.spec) !== undefined) return mountFrame(input);
  return input.way === 'in' ? climbIn(input) : climbOut(input);
}

/** The four beats of a move in: walk to the door, open it, get in, shut it. */
function climbIn(input: BoardingInput): BoardingFrame {
  const w = input.walk;
  // The beats after the walk, as shares of what is left of the move.
  const u = input.progress < w ? 0 : span(input.progress, w, 1);
  const side = input.side;
  const hw = input.spec.halfWidth;
  const { door, swings } = doorFor(input);
  const rear = doorEdge(door, 0).x;
  // Stood at the rear edge of the door, turned a little toward the car.
  const stand: Spot = {
    x: doorAlong(input.spec) - 0.15,
    y: input.ground,
    z: side * (hw + DOOR_STAND),
    yaw: facing(0.8, -side * 0.5),
  };
  const seat = seatSpot(input);
  const right = side < 0;
  const handle: [number, number, number] = [0, door.y + door.height * 0.3, 0];
  let angle = 0;
  let at: Spot;
  let pose: CharacterPose;
  if (input.progress < w) {
    // The walk to the door, round the nose or the tail when the player stood
    // in front of the car or behind it rather than beside it.
    ({ at, pose } = walkBetween(approach(input, stand), span(input.progress, 0, w), stand.yaw, input.stature));
  } else if (u < 0.27) {
    // The hand on the handle, and the door pulled out toward the body, which
    // steps back from it.
    const t = span(u, 0, 0.27);
    angle = swings ? DOOR_OPEN * ease(span(t, 0.25, 1)) : 0;
    // The body gives way as the door comes, or as a hand takes the frame of a cab that has none.
    const back = 0.12 * ease(span(t, 0.25, 1));
    at = { ...stand, x: stand.x - back, z: stand.z + side * back * 0.5 };
    pose = poseFor('stand', 0, { speed: 0, grounded: true, vy: 0, depth: 0, stature: input.stature });
    const edge = doorEdge(door, angle);
    handle[0] = edge.x;
    handle[2] = edge.z;
    reachFor(pose, at, handle, input, right, ease(span(t, 0, 0.3)));
  } else if (u < 0.73) {
    // Into the gap the door left, turned to sit, lowered onto the seat with
    // the head ducked under the roof, and the legs swung in after.
    const t = span(u, 0.27, 0.73);
    angle = swings ? DOOR_OPEN : 0;
    const gap: Spot = { x: rear + door.length * 0.4, y: input.ground, z: side * hw * 0.95, yaw: -side * 1.1 };
    const back = { ...stand, x: stand.x - 0.12, z: stand.z + side * 0.06 };
    at = t < 0.45 ? mixSpot(back, gap, ease(t / 0.45)) : mixSpot(gap, seat, ease((t - 0.45) / 0.55));
    const standing = poseFor('stand', 0, { speed: 0, grounded: true, vy: 0, depth: 0, stature: input.stature });
    pose = blendPose(standing, seatedPose(), ease(span(t, 0.15, 0.85)));
    pose.lean += 0.55 * Math.sin(Math.PI * span(t, 0.2, 0.9));
  } else {
    // Sat down, the hand reaches out for the door and pulls it shut.
    const t = span(u, 0.73, 1);
    angle = swings ? DOOR_OPEN * (1 - ease(span(t, 0.2, 0.85))) : 0;
    at = seat;
    pose = seatedPose();
    const edge = doorEdge(door, angle);
    const pull: [number, number, number] = [edge.x, door.y + door.height * 0.3, edge.z - Math.sign(door.z) * 0.05];
    reachFor(pose, at, pull, input, !right, Math.sin(Math.PI * Math.min(1, t * 1.1)));
  }
  return { ...at, pose, door: angle };
}

/**
 * The beats of a move out: the door pushed open, the legs swung out and the
 * body stood up, a step clear, and the door pushed shut. It ends where
 * `exitPlace` in `src/sim/player/on-foot.ts` stands the player: beside the middle of
 * the car, clear of it, facing its forward.
 */
function climbOut(input: BoardingInput): BoardingFrame {
  const u = input.progress;
  const side = input.side;
  const hw = input.spec.halfWidth;
  const { door, swings } = doorFor(input);
  const rear = doorEdge(door, 0).x;
  const seat = seatSpot(input);
  const clear: Spot = { x: doorAlong(input.spec), y: input.ground, z: side * (hw + EXIT_CLEARANCE), yaw: 0 };
  const right = side < 0;
  let angle = 0;
  let at: Spot;
  let pose: CharacterPose;
  if (u < 0.22) {
    const t = span(u, 0, 0.22);
    angle = swings ? DOOR_OPEN * ease(span(t, 0.3, 1)) : 0;
    at = seat;
    pose = seatedPose();
    const edge = doorEdge(door, angle);
    const push: [number, number, number] = [edge.x, door.y + door.height * 0.3, edge.z - Math.sign(door.z) * 0.05];
    reachFor(pose, at, push, input, !right, Math.sin(Math.PI * t));
  } else if (u < 0.66) {
    // The legs swing out through the gap, the head ducks under the roof, and
    // the body stands up just behind the open door.
    const t = span(u, 0.22, 0.66);
    angle = swings ? DOOR_OPEN : 0;
    const gap: Spot = { x: rear + door.length * 0.4, y: input.ground, z: side * hw * 0.95, yaw: -side * 1.1 };
    const out: Spot = { x: rear - 0.1, y: input.ground, z: side * (hw + 0.25), yaw: facing(0.8, -side * 0.5) };
    at = t < 0.6 ? mixSpot(seat, gap, ease(t / 0.6)) : mixSpot(gap, out, ease((t - 0.6) / 0.4));
    const standing = poseFor('stand', 0, { speed: 0, grounded: true, vy: 0, depth: 0, stature: input.stature });
    pose = blendPose(seatedPose(), standing, ease(span(t, 0.2, 0.8)));
    pose.lean += 0.55 * Math.sin(Math.PI * span(t, 0.1, 0.8));
  } else {
    return stepClear(input, span(u, 0.66, 1), door, swings, clear);
  }
  return { ...at, pose, door: angle };
}

/** The last beat of a move out: a step clear, turned to the door, and the door pushed shut behind. */
function stepClear(input: BoardingInput, t: number, door: Door, swings: boolean, clear: Spot): BoardingFrame {
  const side = input.side;
  const hw = input.spec.halfWidth;
  const rear = doorEdge(door, 0).x;
  const right = side < 0;
  const angle = swings ? DOOR_OPEN * (1 - ease(span(t, 0.3, 0.85))) : 0;
  const out: Spot = { x: rear - 0.1, y: input.ground, z: side * (hw + 0.25), yaw: facing(0.8, -side * 0.5) };
  const step = mixSpot(out, clear, ease(span(t, 0, 0.4)));
  const at = { ...step, yaw: turn(out.yaw, 0, ease(span(t, 0.6, 1))) };
  const walking = span(t, 0, 0.4) > 0 && span(t, 0, 0.4) < 1;
  const pose = poseFor(walking ? 'walk' : 'stand', span(t, 0, 0.4) * Math.PI, {
    speed: walking ? 1.2 : 0,
    grounded: true,
    vy: 0,
    depth: 0,
    stature: input.stature,
  });
  const edge = doorEdge(door, angle);
  reachFor(pose, at, [edge.x, door.y + door.height * 0.3, edge.z], input, right, Math.sin(Math.PI * span(t, 0.2, 0.95)));
  return { ...at, pose, door: angle };
}

/**
 * A bike: the walk to its side and a leg swung over the saddle, or the leg
 * swung back and a step clear. The far leg lifts high over the seat as it
 * goes, which is what reads as getting on from above.
 */
function mountFrame(input: BoardingInput): BoardingFrame {
  const saddle = saddleOf(input.spec);
  if (saddle === undefined) throw new Error('a bike without a saddle');
  const side = input.side;
  const beside: Spot = { x: doorAlong(input.spec) - 0.15, y: input.ground, z: side * (input.spec.halfWidth + DOOR_STAND), yaw: 0 };
  const seated: Spot = { x: saddle.x, y: saddle.y - input.hipsAt, z: 0, yaw: 0 };
  const riding = ridePose(saddle, input.rig);
  const standing = poseFor('stand', 0, { speed: 0, grounded: true, vy: 0, depth: 0, stature: input.stature });
  const clear: Spot = { x: doorAlong(input.spec), y: input.ground, z: side * (input.spec.halfWidth + EXIT_CLEARANCE), yaw: 0 };
  const u = input.progress;
  const w = input.walk;
  let at: Spot;
  let pose: CharacterPose;
  let swing: number;
  if (input.way === 'in') {
    if (u < w) {
      const walked = walkBetween(approach(input, beside), span(u, 0, w), 0, input.stature);
      return { ...walked.at, pose: walked.pose, door: 0 };
    }
    swing = span(u, w, 1);
    at = mixSpot(beside, seated, ease(swing));
    pose = blendPose(standing, riding, ease(swing));
  } else {
    swing = span(u, 0, 0.75);
    at = mixSpot(seated, clear, ease(swing));
    pose = blendPose(riding, standing, ease(swing));
  }
  // The leg away from the side of the move is the one carried over the seat.
  const lift = 1.3 * Math.sin(Math.PI * swing);
  if (side < 0) {
    pose.thighR += lift;
    pose.spreadR += lift * 0.4;
  } else {
    pose.thighL += lift;
    pose.spreadL += lift * 0.4;
  }
  return { ...at, pose, door: 0 };
}

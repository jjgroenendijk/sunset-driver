/**
 * The rider on a bike of the traffic (spec sections 11.1, 13.1).
 *
 * The player on a motorcycle is the character model of `character.ts`, seated
 * by `rider.ts`. The traffic cannot have that: every bike in the city is one
 * instance of one merged geometry, so its rider is not a model with a rig but
 * a figure of boxes built into that geometry, the way the wheels are.
 *
 * The figure is the same body on every bike, because one geometry can only
 * hold one. What keeps it honest is that it sits where the player sits: the
 * saddle, the grips and the pegs come from {@link saddleOf}, and the lean from
 * {@link RIDE}, so a bike moved in `vehicle-mesh.ts` moves both riders.
 *
 * Nothing here is three.js. A strut is a box run between two points, and
 * `traffic.ts` turns each into a geometry, so the whole figure is measured
 * headless.
 */
import { STRIDE_HEIGHT } from '../../sim/crowd/pedestrian-look.ts';
import type { VehicleSpec } from '../../sim/vehicles/vehicle.ts';
import { RIDE } from './rider.ts';
import { SEAT, saddleOf, type Saddle } from './vehicle-mesh.ts';

/** The jacket, the trousers and the helmet the traffic's riders wear. */
const RIDER_JACKET = 0x3b4252;
const RIDER_LEGS = 0x23262d;
/**
 * A pale helmet. The camera looks down from 60 m, so the crown is the face of
 * a rider it sees most of, and a dark one on a dark bike shows nothing.
 */
const RIDER_HELMET = 0xd8d2c2;

/** A point in the vehicle's own frame: along, up and across. */
type RiderPoint = readonly [number, number, number];

/** One limb, the torso or the helmet: a box run from one point to another. */
export interface RiderStrut {
  from: RiderPoint;
  to: RiderPoint;
  /** Across the strut in the plane it leans in, and across the bike. */
  thickness: number;
  width: number;
  colour: number;
}

/**
 * The body, in metres, taken from the crowd's rig (`pedestrian-rig.ts`) so a
 * rider is the size of the people on the pavement beside them.
 */
const TORSO = 0.3 * STRIDE_HEIGHT;
const THIGH = 0.24 * STRIDE_HEIGHT;
const SHIN = 0.23 * STRIDE_HEIGHT;
const HELMET = 0.15 * STRIDE_HEIGHT;
/** How far out from the middle the hips and the shoulders stand. */
const HIP_ACROSS = 0.1;
const SHOULDER_ACROSS = 0.17;

/**
 * The struts of the rider sat on `spec`, and none at all on a class nobody
 * sits astride — a car, and every parked class, comes back empty.
 */
export function riderStruts(spec: VehicleSpec): RiderStrut[] {
  const saddle = saddleOf(spec);
  if (saddle === undefined) return [];
  const hips: RiderPoint = [saddle.x, saddle.y, 0];
  const lean = RIDE.lean;
  const shoulders = along(hips, lean, TORSO);
  const struts: RiderStrut[] = [
    { from: hips, to: shoulders, thickness: 0.24, width: 0.38, colour: RIDER_JACKET },
    // The head sits on the torso but looks further up the road than it does,
    // so the helmet takes half the lean rather than all of it.
    { from: shoulders, to: along(shoulders, lean * 0.5, HELMET), thickness: 0.22, width: 0.21, colour: RIDER_HELMET },
  ];
  for (const side of [1, -1]) struts.push(...limbs(saddle, shoulders, side));
  return struts;
}

/** The leg and the arm of one side: +1 is the side at +z. */
function limbs(saddle: Saddle, shoulders: RiderPoint, side: number): RiderStrut[] {
  const hip: RiderPoint = [saddle.x, saddle.y, side * HIP_ACROSS];
  // The boot stands on the peg, so its middle is half a boot above it.
  const foot: RiderPoint = [saddle.pegX, saddle.pegY + 0.05, side * saddle.pegZ];
  const knee = bend(hip, foot, THIGH, SHIN);
  const shoulder: RiderPoint = [shoulders[0], shoulders[1], side * SHOULDER_ACROSS];
  const grip: RiderPoint = [saddle.gripX, saddle.gripY, side * saddle.gripZ];
  return [
    { from: hip, to: knee, thickness: 0.16, width: 0.16, colour: RIDER_LEGS },
    { from: knee, to: foot, thickness: 0.14, width: 0.14, colour: RIDER_LEGS },
    { from: foot, to: [foot[0] + 0.16, foot[1], foot[2]], thickness: 0.07, width: 0.12, colour: SEAT },
    // One straight arm from the shoulder to the bar, as `pointArm` gives the
    // player: a rider of a fixed size reaches a fixed grip without an elbow.
    { from: shoulder, to: grip, thickness: 0.12, width: 0.12, colour: RIDER_JACKET },
    { from: [grip[0], grip[1], grip[2] - side * 0.07], to: grip, thickness: 0.11, width: 0.11, colour: SEAT },
  ];
}

/** A point `distance` from `at`, leaning `angle` forward of straight up. */
function along(at: RiderPoint, angle: number, distance: number): RiderPoint {
  return [at[0] + Math.sin(angle) * distance, at[1] + Math.cos(angle) * distance, at[2]];
}

/**
 * Where the knee goes: the joint that reaches `foot` from `hip` with an
 * `upper` and a `lower` of their own lengths, bent forward.
 *
 * The two lengths and the gap between the ends give a triangle, and the knee
 * is its third corner. It is put on the forward side of the hip-to-foot line,
 * which on a bike is out over the tank, and that is the whole of what makes
 * the figure sit rather than stand.
 */
function bend(hip: RiderPoint, foot: RiderPoint, upper: number, lower: number): RiderPoint {
  const d: RiderPoint = [foot[0] - hip[0], foot[1] - hip[1], foot[2] - hip[2]];
  const gap = Math.hypot(d[0], d[1], d[2]);
  // A leg too short for the gap straightens rather than tearing in two.
  if (gap >= upper + lower || gap === 0) return [hip[0] + (d[0] * upper) / (gap || 1), hip[1] + (d[1] * upper) / (gap || 1), hip[2] + (d[2] * upper) / (gap || 1)];
  const u: RiderPoint = [d[0] / gap, d[1] / gap, d[2] / gap];
  const reach = (upper * upper - lower * lower + gap * gap) / (2 * gap);
  const out = Math.sqrt(Math.max(0, upper * upper - reach * reach));
  // Forward, with whatever of it runs along the leg taken back off.
  const dot = u[0];
  const side: RiderPoint = [1 - u[0] * dot, -u[1] * dot, -u[2] * dot];
  const length = Math.hypot(side[0], side[1], side[2]) || 1;
  return [
    hip[0] + u[0] * reach + (side[0] / length) * out,
    hip[1] + u[1] * reach + (side[1] / length) * out,
    hip[2] + u[2] * reach + (side[2] / length) * out,
  ];
}

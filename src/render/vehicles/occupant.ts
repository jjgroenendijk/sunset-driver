/**
 * The driver seen through the glass of a car nobody controls: the traffic and
 * a patrol car with its crew aboard. A torso and a head at the driver's seat,
 * sized so the head clears the roof, since from above and through tinted glass
 * that is all a person in a car is.
 *
 * It holds no three.js; `traffic.ts` merges the boxes into a mesh.
 */
import type { VehicleSpec } from '../../sim/vehicles/vehicle.ts';
import { hullOf } from './vehicle-hull.ts';
import { seatOf } from './vehicle-mesh.ts';
import { box, type VehicleBox } from './vehicle-parts.ts';

const SHIRT = 0x3b4a6b;
const SKIN = 0xc68a64;
/** Metres the top of the head stands under the roof. */
const HEADROOM = 0.1;

/** The driver of a car with glass to be seen through, or nothing for any other class. */
export function driverOf(spec: VehicleSpec): VehicleBox[] {
  if (spec.inline || hullOf(spec) === undefined) return [];
  const seat = seatOf(spec);
  const top = spec.halfHeight - HEADROOM;
  const head = Math.min(0.22, (top - seat.y) * 0.3);
  const torso = top - head - 0.02 - seat.y;
  return [
    box(0.24, torso, 0.36, SHIRT, seat.x - 0.04, seat.y + torso / 2, seat.z),
    box(0.2, head, 0.17, SKIN, seat.x - 0.01, top - head / 2, seat.z),
  ];
}

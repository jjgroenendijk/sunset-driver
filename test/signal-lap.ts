import { SIGNAL_CYCLE, type SignalApproach } from '../src/sim/signals.ts';
import type { AmbientTraffic, AmbientVehicle, TrafficCursor } from '../src/sim/traffic.ts';
import type { Tour } from '../src/sim/traffic-tour.ts';

/** What one lap of a vehicle did at the traffic lights. */
export interface SignalLap {
  /** Ticks it stood still. */
  stops: number;
  /** Stop lines it drove over. */
  crossings: number;
  /** Those of them it took on an amber, which only a driver who takes ambers does. */
  ambers: number;
  /** Ticks it stood at a stop on its route, which only a bus does. */
  calling: number;
  /** Every tick it stood still where no light held it, or drove over a line on amber or red. */
  faults: string[];
}

/**
 * Step one vehicle a whole lap and hold it to the lights and to its driver
 * (spec section 20.2): it stands still from one tick to the next only at a
 * light that is not green or in the moment its driver takes over a green that
 * has just started, and it drives over a stop line only from a tick that is
 * green, or amber where its driver takes ambers. Nobody crosses on red.
 */
export function signalLap(traffic: AmbientTraffic, vehicle: AmbientVehicle): SignalLap {
  const signals = traffic.signals;
  const lap: SignalLap = { stops: 0, crossings: 0, ambers: 0, calling: 0, faults: [] };
  if (signals === undefined) return lap;
  const driver = vehicle.driver;
  const cursor = traffic.cursorAt(vehicle.id, 0);
  let last = placeOf(vehicle.tour, cursor);
  for (let tick = 1; tick <= vehicle.tour.period; tick++) {
    // The tick a call ends on is the first tick of the drive out of it, and the
    // vehicle has not moved yet, so the step behind counts as well as the one
    // it is on.
    const left = cursor.step;
    traffic.advance(cursor);
    const now = placeOf(vehicle.tour, cursor);
    const approach = signals.approachOf(now.edge);
    if (now.edge === last.edge && now.along === last.along) {
      // A bus at a stop on its route is held by its passengers, not by a light.
      if (vehicle.tour.stepCall[cursor.step] === 1 || vehicle.tour.stepCall[left] === 1) {
        lap.calling++;
        last = now;
        continue;
      }
      lap.stops++;
      // A driver who is still standing more than their own reaction after the
      // green started is one the timing forgot to send on.
      const into = approach === undefined ? 0 : mod(tick - 1 - signals.greenStart(approach), SIGNAL_CYCLE);
      const pulling = approach !== undefined && into < driver.react;
      if (approach === undefined || (signals.light(approach, tick - 1) === 'green' && !pulling)) {
        lap.faults.push(`vehicle ${vehicle.id} stands still at tick ${tick} with no red light`);
      }
    } else if (approach !== undefined && now.edge === last.edge && last.along <= approach.stop && now.along > approach.stop) {
      lap.crossings++;
      const light = signals.light(approach as SignalApproach, tick - 1);
      const taken = light === 'amber' && driver.runsAmber;
      if (light !== 'green' && !taken) lap.faults.push(`vehicle ${vehicle.id} crosses its line on ${light} at tick ${tick}`);
      if (taken) lap.ambers++;
    }
    last = now;
  }
  return lap;
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

/** The edge a cursor stands on, and the metres along it. */
function placeOf(tour: Tour, cursor: TrafficCursor): { edge: number; along: number } {
  const from = tour.stepFrom[cursor.step] as number;
  const to = tour.stepTo[cursor.step] as number;
  const along = from + (cursor.into / (tour.stepTicks[cursor.step] as number)) * (to - from);
  return { edge: tour.edges[tour.stepLeg[cursor.step] as number] as number, along };
}

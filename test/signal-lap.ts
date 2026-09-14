import type { SignalApproach } from '../src/sim/signals.ts';
import type { AmbientTraffic, AmbientVehicle, TrafficCursor } from '../src/sim/traffic.ts';
import type { Tour } from '../src/sim/traffic-tour.ts';

/** What one lap of a vehicle did at the traffic lights. */
export interface SignalLap {
  /** Ticks it stood still. */
  stops: number;
  /** Stop lines it drove over. */
  crossings: number;
  /** Every tick it stood still where no light held it, or drove over a line on amber or red. */
  faults: string[];
}

/**
 * Step one vehicle a whole lap and hold it to the lights: it stands still from
 * one tick to the next only at a light that is not green, and it drives over a
 * stop line only from a tick that is green.
 */
export function signalLap(traffic: AmbientTraffic, vehicle: AmbientVehicle): SignalLap {
  const signals = traffic.signals;
  const lap: SignalLap = { stops: 0, crossings: 0, faults: [] };
  if (signals === undefined) return lap;
  const cursor = traffic.cursorAt(vehicle.id, 0);
  let last = placeOf(vehicle.tour, cursor);
  for (let tick = 1; tick <= vehicle.tour.period; tick++) {
    traffic.advance(cursor);
    const now = placeOf(vehicle.tour, cursor);
    const approach = signals.approachOf(now.edge);
    if (now.edge === last.edge && now.along === last.along) {
      lap.stops++;
      if (approach === undefined || signals.light(approach, tick - 1) === 'green') {
        lap.faults.push(`vehicle ${vehicle.id} stands still at tick ${tick} with no red light`);
      }
    } else if (approach !== undefined && now.edge === last.edge && last.along <= approach.stop && now.along > approach.stop) {
      lap.crossings++;
      const light = signals.light(approach as SignalApproach, tick - 1);
      if (light !== 'green') lap.faults.push(`vehicle ${vehicle.id} crosses its line on ${light} at tick ${tick}`);
    }
    last = now;
  }
  return lap;
}

/** The edge a cursor stands on, and the metres along it. */
function placeOf(tour: Tour, cursor: TrafficCursor): { edge: number; along: number } {
  const from = tour.stepFrom[cursor.step] as number;
  const to = tour.stepTo[cursor.step] as number;
  const along = from + (cursor.into / (tour.stepTicks[cursor.step] as number)) * (to - from);
  return { edge: tour.edges[tour.stepLeg[cursor.step] as number] as number, along };
}

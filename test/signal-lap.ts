import { SIGNAL_CYCLE, SIGNAL_GREEN, type SignalApproach } from '../src/sim/signals.ts';
import type { AmbientTraffic, AmbientVehicle, TrafficCursor } from '../src/sim/traffic.ts';
import type { Tour } from '../src/sim/traffic-tour.ts';
import { QUEUE_CLEAR } from '../src/sim/traffic-timing.ts';
import type { RoadEdge } from '../src/world/graph.ts';

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
 * green, or amber where its driver takes ambers. Nobody crosses on red, and
 * nobody waits within {@link QUEUE_CLEAR} of a node that keeps clear.
 *
 * A turn a tram crosses is held on a green as well (`tram-guard.ts`): a
 * vehicle may stand while the tram is in the junction, and while it would
 * reach the line in the tram's path however soon it pulled away, which is
 * within half the green for the last car of its queue.
 */
export function signalLap(traffic: AmbientTraffic, vehicle: AmbientVehicle): SignalLap {
  const signals = traffic.signals;
  const lap: SignalLap = { stops: 0, crossings: 0, ambers: 0, calling: 0, faults: [] };
  if (signals === undefined) return lap;
  const driver = vehicle.driver;
  const graph = traffic.roads.graph;
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
      // A queue that runs back onto the leg before a light is held by that light.
      const holding = approach ?? signals.approachOf(vehicle.tour.edges[(now.leg + 1) % vehicle.tour.edges.length] as number);
      // A bus at a stop on its route is held by its passengers, not by a light.
      if (vehicle.tour.stepCall[cursor.step] === 1 || vehicle.tour.stepCall[left] === 1) {
        lap.calling++;
        last = now;
        continue;
      }
      lap.stops++;
      // A driver who is still standing more than their own reaction after the
      // green started is one the timing forgot to send on.
      const into = holding === undefined ? 0 : mod(tick - 1 - signals.greenStart(holding), SIGNAL_CYCLE);
      const pulling = holding !== undefined && into < driver.react;
      const tram = holding !== undefined && tramHolds(traffic, vehicle, holding, now.leg, tick - 1);
      if (holding === undefined || (signals.light(holding, tick - 1) === 'green' && !pulling && !tram)) {
        lap.faults.push(`vehicle ${vehicle.id} stands still at tick ${tick} with no red light`);
      }
      // Nor does it wait in a junction with lights or a level crossing behind it.
      const edge = graph.edges[now.edge] as RoadEdge;
      if (signals.keepsClear(edge.from) && now.along < Math.min(QUEUE_CLEAR, approach?.stop ?? edge.length) - 1e-9) {
        lap.faults.push(`vehicle ${vehicle.id} waits ${now.along.toFixed(1)} m into its road at tick ${tick}, in the junction behind it`);
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

/** True while a tram crossing its turn at `holding` holds a vehicle standing on leg `leg`. */
function tramHolds(traffic: AmbientTraffic, vehicle: AmbientVehicle, holding: SignalApproach, leg: number, tick: number): boolean {
  const guard = traffic.guard;
  if (guard === undefined) return false;
  const edges = vehicle.tour.edges;
  const at = edges[leg] === holding.edge ? leg : leg + 1;
  const next = edges[(at + 1) % edges.length] as number;
  const react = vehicle.driver.react;
  return guard.blocks(holding.edge, next, tick - react, react + SIGNAL_GREEN[holding.axis] / 2 + 2);
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

/** The leg and the edge a cursor stands on, and the metres along it. */
function placeOf(tour: Tour, cursor: TrafficCursor): { leg: number; edge: number; along: number } {
  const from = tour.stepFrom[cursor.step] as number;
  const to = tour.stepTo[cursor.step] as number;
  const along = from + (cursor.into / (tour.stepTicks[cursor.step] as number)) * (to - from);
  const leg = tour.stepLeg[cursor.step] as number;
  return { leg, edge: tour.edges[leg] as number, along };
}

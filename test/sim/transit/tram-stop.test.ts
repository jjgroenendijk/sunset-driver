import { describe, expect, it } from 'vitest';
import { footprintsTouch, type AmbientPose } from '../../../src/sim/traffic/traffic.ts';
import { DWELL, TRAM_LENGTH, type WaitingPassenger } from '../../../src/sim/transit/tram.ts';
import { TRAM_ACCEL } from '../../../src/sim/transit/tram-motion.ts';
import { PLATFORM_AHEAD, PLATFORM_BEHIND, placeTramStops } from '../../../src/sim/transit/tram-stop-place.ts';
import { specOf } from '../../../src/sim/vehicles/vehicle.ts';
import type { RoadEdge } from '../../../src/world/roads/graph.ts';
import { TRAM_LANE } from '../../../src/world/roads/tiers.ts';
import { ring } from '../../support/tram-ring.ts';
import { TICK_RATE } from '../../../src/sim/clock.ts';

/** Metres from the track to the middle of the platform, and half its width. */
const MIDDLE = TRAM_LANE.platformInner + TRAM_LANE.platform / 2;
const HALF = TRAM_LANE.platform / 2;

/**
 * A tram stop (spec section 13.2): where on the loop its platform stands, the
 * traffic keeping off it, the people waiting on it and the tram easing in
 * and out of it.
 */
describe('a tram stop', () => {
  const r = ring(1);
  const { line, tram } = r;
  const graph = r.roads.graph;
  const tour = line.tour;
  if (tour === undefined) throw new Error('no tram on the ring');
  const places = line.stopPlaces();

  /** Where a point stands in a stop's own frame: metres along the platform from its middle, and across from the track. */
  const frame = (place: (typeof places)[number], x: number, y: number): { along: number; across: number } => ({
    along: (x - place.x) * Math.cos(place.heading) + (y - place.y) * Math.sin(place.heading),
    across: (x - place.x) * Math.sin(place.heading) - (y - place.y) * Math.cos(place.heading),
  });

  it('stands every platform clear of the junctions either side of it', () => {
    const placed = placeTramStops(graph, tram.edges, tram.stops, TRAM_LENGTH);
    const starts: number[] = [];
    let total = 0;
    for (const id of tram.edges) {
      starts.push(total);
      total += (graph.edges[id] as RoadEdge).length;
    }
    const junctions = tram.edges.flatMap((id, leg) => ((graph.nodes[(graph.edges[id] as RoadEdge).from]?.runs.length ?? 2) !== 2 ? [starts[leg] as number] : []));
    expect(junctions.length).toBeGreaterThan(0);
    for (const place of placed) {
      if (place === undefined) throw new Error('a stop was not placed');
      const front = (starts[place.leg] as number) + place.halt;
      for (const junction of junctions) {
        for (const at of [junction - total, junction, junction + total]) {
          const clear = at >= front ? at - front >= PLATFORM_AHEAD - 1e-6 : front - TRAM_LENGTH - at >= PLATFORM_BEHIND - 1e-6;
          expect(clear, `junction at ${at.toFixed(1)}, front at ${front.toFixed(1)}`).toBe(true);
        }
      }
    }
  });

  it('keeps every vehicle of the traffic off every platform', () => {
    const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
    const touches: string[] = [];
    for (let tick = 0; tick < 3 * 60 * TICK_RATE; tick += 15) {
      for (const vehicle of r.traffic.vehicles) {
        r.traffic.poseAt(vehicle.id, tick, pose);
        const spec = specOf(vehicle.cls);
        for (const place of places) {
          // The platform is a box turned to its stop, across from the track and as long as a tram.
          const side = { x: place.x + Math.sin(place.heading) * MIDDLE, y: place.y - Math.cos(place.heading) * MIDDLE };
          const platform = { x: side.x, y: side.y, heading: place.heading, halfLength: TRAM_LENGTH / 2, halfWidth: HALF };
          const car = { x: pose.x, y: pose.y, heading: pose.heading, halfLength: spec.halfLength, halfWidth: spec.halfWidth };
          if (footprintsTouch(car, platform, 0)) touches.push(`vehicle ${vehicle.id} at tick ${tick}, stop ${place.stop}`);
        }
      }
    }
    expect(touches).toEqual([]);
  });

  it('spreads the people waiting over the platform rather than lining them up', () => {
    const call = line.calls[1];
    const place = places[1];
    if (call === undefined || place === undefined) throw new Error('no stop 1');
    const out: WaitingPassenger[] = [];
    // Just before a tram comes, with the stop as full as it gets.
    const tick = call.arrive - line.loopTick(0, 0) - 1;
    const count = line.passengers(place.x - 60, place.y - 60, place.x + 60, place.y + 60, tick, out);
    expect(count).toBeGreaterThan(2);
    const spots = out.slice(0, count).map((person) => frame(place, person.pose.x, person.pose.y));
    for (const spot of spots) {
      expect(Math.abs(spot.along)).toBeLessThanOrEqual(TRAM_LENGTH / 2);
      expect(Math.abs(spot.across - MIDDLE)).toBeLessThanOrEqual(HALF);
    }
    // Not one line: they stand at different distances from the track.
    const across = spots.map((spot) => spot.across);
    expect(Math.max(...across) - Math.min(...across)).toBeGreaterThan(0.2);
    // And nobody stands in anybody else.
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const a = spots[i] as { along: number; across: number };
        const b = spots[j] as { along: number; across: number };
        expect(Math.hypot(a.along - b.along, a.across - b.across)).toBeGreaterThan(0.5);
      }
    }
  });

  it('walks the people to the doors once a tram stands there, and has them all aboard before it leaves', () => {
    const call = line.calls[1];
    const place = places[1];
    if (call === undefined || place === undefined) throw new Error('no stop 1');
    const tickOf = (loop: number): number => loop - line.loopTick(0, 0);
    const out: WaitingPassenger[] = [];
    const box = [place.x - 60, place.y - 60, place.x + 60, place.y + 60] as const;
    const before = line.passengers(...box, tickOf(call.arrive), out);
    expect(before).toBeGreaterThan(0);
    const walking = line.passengers(...box, tickOf(call.arrive + 3 * TICK_RATE), out);
    expect(out.slice(0, walking).some((person) => person.pose.speed > 0)).toBe(true);
    // They step towards the tram: nearer the track than their spots.
    for (const person of out.slice(0, walking)) expect(frame(place, person.pose.x, person.pose.y).across).toBeLessThan(MIDDLE + HALF);
    expect(line.passengers(...box, tickOf(call.arrive + DWELL - 2 * TICK_RATE), out)).toBe(0);
  });

  it('eases the tram into every stop and out of it, never faster than a tram can change speed', () => {
    const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
    let last = line.carPose(0, 0, 0, pose).speed;
    let hardest = 0;
    for (let tick = 1; tick < tour.period; tick++) {
      const speed = line.carPose(0, 0, tick, pose).speed;
      hardest = Math.max(hardest, Math.abs(speed - last) * TICK_RATE);
      last = speed;
    }
    // The timing leaves room for every ramp. A drive of a few metres is rounded to whole
    // ticks, which can make its ramp a little harder, but never a jolt.
    expect(hardest).toBeLessThanOrEqual(2.5 * TRAM_ACCEL);
    for (const call of line.calls) {
      expect(line.carPose(0, 0, call.arrive - line.loopTick(0, 0), pose).speed).toBeCloseTo(0, 6);
    }
  });
});

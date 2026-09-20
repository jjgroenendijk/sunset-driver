import { describe, expect, it } from 'vitest';
import { SIGNAL_AMBER, SIGNAL_CLEAR, SIGNAL_CYCLE, SIGNAL_GREEN, type SignalApproach, TrafficSignals } from '../src/sim/signals.ts';
import type { RoadEdge } from '../src/world/graph.ts';
import { AmbientTraffic } from '../src/sim/traffic.ts';
import { sweepSeeds } from './helpers.ts';
import { signalLap } from './signal-lap.ts';
import { GRID_SPACING, gridTraffic, gridTrafficRoads } from './traffic-grid.ts';

const SEEDS = sweepSeeds(process.env.SWEEP_SEEDS ? 6 : 2);

/** Vehicles each seed follows round a whole lap, tick by tick. */
const FOLLOWED = process.env.SWEEP_SEEDS ? 40 : 20;

function signalsOf(traffic: AmbientTraffic): TrafficSignals {
  if (traffic.signals === undefined) throw new Error('no signals');
  return traffic.signals;
}

describe('traffic lights (spec section 13.1)', () => {
  it('stands where the arterial meets a street, and not where it meets the highway or the alley', () => {
    const signals = signalsOf(gridTraffic(SEEDS[0] as number));
    const places = signals.junctions.map((j) => `${j.x},${j.y}`).sort();
    expect(places).toEqual([-1, 1, 2].map((i) => `${i * GRID_SPACING},0`).sort());
    for (const junction of signals.junctions) {
      const axes = junction.approaches.map((a) => (signals.approaches[a] as SignalApproach).axis);
      expect(axes).toContain(0);
      expect(axes).toContain(1);
    }
  });

  it('lights the level crossing where the tram crosses a highway, so the traffic is held (issue #302)', () => {
    const seed = SEEDS[0] as number;
    const roads = gridTrafficRoads();
    const map = roads.junctions as NonNullable<typeof roads.junctions>;
    // The arterial row and the highway column of the grid meet here.
    const node = roads.graph.nodes.find((n) => n.x === 0 && n.y === 0);
    if (node === undefined) throw new Error('no node where the arterial meets the highway');
    const without = new TrafficSignals(seed, roads.roads, roads.graph, map, roads.heightAt);
    expect(without.junctions.some((j) => j.node === node.id)).toBe(false);

    const with_ = new TrafficSignals(seed, roads.roads, roads.graph, map, roads.heightAt, [node.id]);
    const junction = with_.junctions.find((j) => j.node === node.id);
    if (junction === undefined) throw new Error('the level crossing takes no light');
    const approaches = junction.approaches.map((a) => with_.approaches[a] as SignalApproach);
    // The highway arrives across the arterial the tram runs down, so it is held
    // on the arterial's green and the tram crosses on a road nobody else is on.
    const across = approaches.filter((a) => (roads.graph.edges[a.edge] as RoadEdge).tier === 'highway');
    expect(across.length).toBeGreaterThan(0);
    const along = approaches.find((a) => a.axis === 0) as SignalApproach;
    const tick = with_.greenStart(along);
    expect(with_.light(along, tick)).toBe('green');
    for (const a of across) expect(with_.light(a, tick)).toBe('red');
  });

  it('runs green, amber and red on each axis in turn, and never shows two axes green', () => {
    const signals = signalsOf(gridTraffic(SEEDS[1] as number));
    const junction = signals.junctions[0];
    if (junction === undefined) throw new Error('no junction');
    const one = (axis: 0 | 1): SignalApproach =>
      junction.approaches.map((a) => signals.approaches[a] as SignalApproach).find((a) => a.axis === axis) as SignalApproach;
    const counts: [Record<string, number>, Record<string, number>] = [
      { green: 0, amber: 0, red: 0 },
      { green: 0, amber: 0, red: 0 },
    ];
    for (let tick = 0; tick < SIGNAL_CYCLE; tick++) {
      const a = signals.light(one(0), tick);
      const b = signals.light(one(1), tick);
      counts[0][a] = (counts[0][a] ?? 0) + 1;
      counts[1][b] = (counts[1][b] ?? 0) + 1;
      expect(a === 'red' || b === 'red', `tick ${tick}`).toBe(true);
      expect(signals.light(one(0), tick + 7 * SIGNAL_CYCLE)).toBe(a);
      // A pedestrian crosses the roads of an axis only while that axis is held.
      if (signals.crossingOpen(0, 0, tick)) expect(a).toBe('red');
      if (signals.crossingOpen(0, 1, tick)) expect(b).toBe('red');
    }
    for (const axis of [0, 1] as const) {
      const green = SIGNAL_GREEN[axis];
      expect(counts[axis]).toEqual({ green, amber: SIGNAL_AMBER, red: SIGNAL_CYCLE - green - SIGNAL_AMBER });
      expect(signals.light(one(axis), signals.greenStart(one(axis)))).toBe('green');
      expect(signals.light(one(axis), signals.greenStart(one(axis)) - 1)).toBe('red');
    }
    // Both red for a moment before either green, so the junction clears.
    expect(signals.light(one(1), signals.greenStart(one(0)) - SIGNAL_CLEAR)).toBe('red');
    expect(signals.light(one(0), signals.greenStart(one(1)) - SIGNAL_CLEAR)).toBe('red');
  });

  it('stops traffic on red: a vehicle waits only while its light is not green, and crosses its line only on green', () => {
    for (const seed of SEEDS) {
      const traffic = gridTraffic(seed);
      const timed = traffic.vehicles.filter((v) => v.tour.sync >= 0);
      // The grid has a few dozen vehicles that meet a light; the full tier follows most of them.
      expect(timed.length, `seed ${seed}`).toBeGreaterThan(FOLLOWED);
      let stops = 0;
      let crossings = 0;
      const stride = Math.floor(timed.length / FOLLOWED);
      for (let i = 0; i < timed.length; i += stride) {
        const lap = signalLap(traffic, timed[i] as (typeof timed)[number]);
        expect(lap.faults, `seed ${seed}`).toEqual([]);
        stops += lap.stops;
        crossings += lap.crossings;
      }
      expect(stops, `seed ${seed}`).toBeGreaterThan(0);
      expect(crossings, `seed ${seed}`).toBeGreaterThan(FOLLOWED);
    }
  });

  it('runs a queue that does not fit its road back onto the road before, held by the same light', () => {
    let seen = 0;
    for (const seed of SEEDS) {
      const traffic = gridTraffic(seed);
      const signals = signalsOf(traffic);
      // A wait on a road with no light of its own, before a road that has one:
      // the back of a queue for that light (issue #357).
      const spilt = traffic.vehicles.filter((v) => {
        const t = v.tour;
        for (let step = 0; step < t.stepTicks.length; step++) {
          if (t.stepFrom[step] !== t.stepTo[step] || t.stepCall[step] === 1) continue;
          const leg = t.stepLeg[step] as number;
          const next = t.edges[(leg + 1) % t.edges.length] as number;
          if (signals.approachOf(t.edges[leg] as number) === undefined && signals.approachOf(next) !== undefined) return true;
        }
        return false;
      });
      for (const vehicle of spilt) expect(signalLap(traffic, vehicle).faults, `seed ${seed}`).toEqual([]);
      seen += spilt.length;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('is the same lights and the same waits for the same seed', () => {
    const seed = SEEDS[0] as number;
    const a = gridTraffic(seed);
    const b = new AmbientTraffic(seed, gridTrafficRoads());
    expect(signalsOf(a).junctions).toEqual(signalsOf(b).junctions);
    for (let id = 0; id < a.vehicles.length; id += 17) {
      expect(a.vehicles[id]?.phase).toBe(b.vehicles[id]?.phase);
      expect(a.vehicles[id]?.tour.stepTicks).toEqual(b.vehicles[id]?.tour.stepTicks);
    }
  });
});

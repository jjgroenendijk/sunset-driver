import { describe, expect, it } from 'vitest';
import { rngFor, Subsystem } from '../src/core/rng.ts';
import { drawDriver, driverNamed, PERSONALITIES, STEADY, type Personality } from '../src/sim/driver.ts';
import { SIGNAL_CYCLE, type SignalApproach, type TrafficSignals } from '../src/sim/signals.ts';
import { timeTour, type Tour } from '../src/sim/traffic-timing.ts';
import { walkTour } from '../src/sim/traffic-tour.ts';
import { AmbientTraffic } from '../src/sim/traffic.ts';
import { sweepSeeds } from './helpers.ts';
import { signalLap } from './signal-lap.ts';
import { gridTraffic, gridTrafficRoads } from './traffic-grid.ts';

const SEEDS = sweepSeeds(2);

/** Vehicles each seed is followed over for what their drivers did at the lights. */
const FOLLOWED = 60;

function signalsOf(traffic: AmbientTraffic): TrafficSignals {
  if (traffic.signals === undefined) throw new Error('no signals');
  return traffic.signals;
}

describe('the driver behind the wheel (spec section 20.2)', () => {
  it('reads as a roster of whole drivers, no two alike', () => {
    const names = PERSONALITIES.map((row) => row.personality);
    expect(new Set(names).size, 'two rows share a name').toBe(names.length);
    for (const row of PERSONALITIES) {
      expect(row.share, row.personality).toBeGreaterThan(0);
      // Nobody drives at half the limit, and nobody drives at twice it: the
      // spread is narrow on purpose, since no vehicle reads the one in front.
      expect(row.cruise, row.personality).toBeGreaterThan(0.75);
      expect(row.cruise, row.personality).toBeLessThanOrEqual(1);
      // A gap shorter than a car would queue two vehicles inside each other.
      expect(row.gap, row.personality).toBeGreaterThan(4);
      expect(row.react, row.personality).toBeGreaterThan(0);
      // A reaction longer than the shortest green would hold a driver through it.
      expect(row.react, row.personality).toBeLessThan(SIGNAL_CYCLE / 8);
    }
    expect(STEADY.personality).toBe('steady');
    expect(driverNamed('tailgater').gap).toBeLessThan(driverNamed('careful').gap);
    expect(driverNamed('tailgater').react).toBeLessThan(driverNamed('hesitant').react);
    expect(driverNamed('tailgater').cruise).toBeGreaterThan(driverNamed('hesitant').cruise);
  });

  it('draws every personality from one stream, in the roster proportions', () => {
    const rng = rngFor(1, 0, Subsystem.Traffic, 99);
    const drawn = new Map<Personality, number>();
    const rounds = 4000;
    for (let i = 0; i < rounds; i++) {
      const driver = drawDriver(rng);
      drawn.set(driver.personality, (drawn.get(driver.personality) ?? 0) + 1);
    }
    let total = 0;
    for (const row of PERSONALITIES) total += row.share;
    for (const row of PERSONALITIES) {
      const share = (drawn.get(row.personality) ?? 0) / rounds;
      expect(share, row.personality).toBeGreaterThan((row.share / total) * 0.75);
      expect(share, row.personality).toBeLessThan((row.share / total) * 1.25);
    }
  });

  it('takes exactly one number off the stream, so the tours behind it do not shift', () => {
    const a = rngFor(7, 0, Subsystem.Traffic, 3);
    drawDriver(a);
    const b = rngFor(7, 0, Subsystem.Traffic, 3);
    b.float();
    expect(a.float()).toBe(b.float());
  });

  it('puts more than one personality on the city streets, and the same ones for the same seed', () => {
    for (const seed of SEEDS) {
      const traffic = gridTraffic(seed);
      const found = new Set(traffic.vehicles.map((v) => v.driver.personality));
      expect(found.size, `seed ${seed}`).toBeGreaterThan(2);
      const again = new AmbientTraffic(seed, gridTrafficRoads());
      for (let id = 0; id < traffic.vehicles.length; id += 13) {
        expect(again.vehicles[id]?.driver, `seed ${seed} vehicle ${id}`).toEqual(traffic.vehicles[id]?.driver);
      }
    }
  });

  it('drives one route slower for a hesitant driver than for a tailgater', () => {
    const roads = gridTrafficRoads();
    const walk = rngFor(3, 0, Subsystem.Traffic, 11);
    const route = walkTour(roads.graph, 0, walk, () => true);
    const slow = timeTour(roads.graph, route, undefined, 0, driverNamed('hesitant'));
    const quick = timeTour(roads.graph, route, undefined, 0, driverNamed('tailgater'));
    expect(slow.length).toBe(quick.length);
    expect(slow.period).toBeGreaterThan(quick.period);
    // The steady driver is the traffic as it drove before there were drivers.
    const steady = timeTour(roads.graph, route, undefined, 0);
    expect(steady.period).toBe(timeTour(roads.graph, route, undefined, 0, STEADY).period);
    expect(steady.period).toBeLessThan(slow.period);
    expect(steady.period).toBeGreaterThan(quick.period);
  });

  it('stands a tailgater closer to the line than a careful driver in the same queue', () => {
    const roads = gridTrafficRoads();
    const traffic = new AmbientTraffic(SEEDS[0] as number, roads);
    const signals = signalsOf(traffic);
    // The back of the queue, so the place has room to differ; the same route
    // and the same place, so the gap is the only thing that moved.
    const walk = rngFor(5, 0, Subsystem.Traffic, 23);
    const route = walkTour(roads.graph, signals.approaches[0]?.edge ?? 0, walk, () => true);
    const near = queuedBack(timeTour(roads.graph, route, signals, 1, driverNamed('tailgater')), signals);
    const far = queuedBack(timeTour(roads.graph, route, signals, 1, driverNamed('careful')), signals);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(far);
  });

  it('takes an amber only with a driver who takes ambers, and never a red', () => {
    let ambers = 0;
    let waited = 0;
    for (const seed of SEEDS) {
      const traffic = gridTraffic(seed);
      const timed = traffic.vehicles.filter((v) => v.tour.sync >= 0);
      const stride = Math.max(1, Math.floor(timed.length / FOLLOWED));
      for (let i = 0; i < timed.length; i += stride) {
        const vehicle = timed[i] as (typeof timed)[number];
        const lap = signalLap(traffic, vehicle);
        expect(lap.faults, `seed ${seed}`).toEqual([]);
        if (!vehicle.driver.runsAmber) expect(lap.ambers, `${vehicle.driver.personality} vehicle ${vehicle.id}`).toBe(0);
        ambers += lap.ambers;
        waited += lap.stops;
      }
    }
    // Somebody in the city chances an amber, and somebody waits at a red.
    expect(ambers).toBeGreaterThan(0);
    expect(waited).toBeGreaterThan(0);
  });
});

/**
 * Metres back from the stop line a tour's vehicle waits at the anchor it is
 * timed from. The anchor is the leg the tour closes on, and that closing wait
 * is its last step, so where it stands is where that step sits on the leg.
 */
function queuedBack(tour: Tour, signals: TrafficSignals): number {
  const last = tour.stepTicks.length - 1;
  const edge = tour.edges[tour.stepLeg[last] as number] as number;
  const approach = signals.approachOf(edge) as SignalApproach;
  return approach.stop - (tour.stepFrom[last] as number);
}

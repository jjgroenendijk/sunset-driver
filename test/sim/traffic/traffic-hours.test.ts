import { describe, expect, it } from 'vitest';
import { EVENTS, eventOn, rushHourAt } from '../../../src/sim/city/city-events.ts';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../../../src/sim/clock.ts';
import { TRAFFIC_HOURS, trafficAtHour } from '../../../src/sim/traffic/traffic-hours.ts';
import type { AmbientTraffic, TrafficCursor } from '../../../src/sim/traffic/traffic.ts';
import { gridTraffic } from '../../support/traffic-grid.ts';

const SEED = 5;

/** The ids of the vehicles out at a tick. */
function outAt(traffic: AmbientTraffic, tick: number): number[] {
  return traffic.vehicles.filter((v) => traffic.outAt(v.id, tick)).map((v) => v.id);
}

describe('traffic hours (spec sections 13.1, 20.5)', () => {
  it('puts every vehicle out at rush hour and fewer at any other hour', () => {
    for (let hour = 0; hour < 24; hour++) {
      const tick = hour * TICKS_PER_HOUR;
      expect(trafficAtHour(tick), `hour ${hour}`).toBe(TRAFFIC_HOURS[hour]);
      if (rushHourAt(tick)) expect(TRAFFIC_HOURS[hour], `hour ${hour}`).toBe(1);
      else expect(TRAFFIC_HOURS[hour], `hour ${hour}`).toBeLessThan(1);
    }
  });

  it('thickens the traffic at rush hour and thins it at night, the same way for the same seed', () => {
    const traffic = gridTraffic(SEED);
    const day = 2 * TICKS_PER_DAY;
    const rush = outAt(traffic, day + 8 * TICKS_PER_HOUR);
    const noon = outAt(traffic, day + 12 * TICKS_PER_HOUR);
    const night = outAt(traffic, day + 3 * TICKS_PER_HOUR);
    expect(rush).toHaveLength(traffic.vehicles.length);
    expect(noon.length).toBeLessThan(rush.length);
    expect(night.length).toBeLessThan(noon.length * 0.5);
    // A bus keeps its timetable at night.
    for (const v of traffic.vehicles) if (v.cls === 'bus') expect(night).toContain(v.id);
    expect(outAt(gridTraffic(SEED), day + 3 * TICKS_PER_HOUR)).toEqual(night);
  });

  it('brings a vehicle out or home only where it turns onto another leg', () => {
    const traffic = gridTraffic(SEED);
    // Across the end of the evening rush hour, when a quarter of the traffic goes home.
    const from = 19 * TICKS_PER_HOUR - 600;
    const cursor: TrafficCursor = { id: 0, step: 0, into: 0 };
    let changes = 0;
    for (const v of traffic.vehicles.filter((_, i) => i % 3 === 0)) {
      traffic.cursorAt(v.id, from, cursor);
      let out = traffic.outAt(v.id, from);
      let leg = v.tour.stepLeg[cursor.step];
      for (let tick = from + 1; tick < from + 1200; tick++) {
        traffic.cursorAt(v.id, tick, cursor);
        const now = traffic.outAt(v.id, tick);
        const nowLeg = v.tour.stepLeg[cursor.step];
        if (now !== out) {
          changes++;
          expect(nowLeg, `vehicle ${v.id} at tick ${tick}`).not.toBe(leg);
        }
        out = now;
        leg = nowLeg;
      }
    }
    expect(changes).toBeGreaterThan(0);
  });

  it('keeps every vehicle off the street a parade shuts while it marches', () => {
    const traffic = gridTraffic(SEED);
    const venue = { x: 0, y: 0, heading: 0 };
    const venues = { parade: venue };
    let day = 0;
    while (eventOn(SEED, 'parade', day, venues) === undefined) day++;
    const parade = eventOn(SEED, 'parade', day, venues);
    if (parade === undefined) throw new Error('no parade');
    const graph = traffic.roads.graph;
    const radius = EVENTS.parade.radius;
    const near = (tick: number, v: { id: number }): boolean => {
      const edge = traffic.edgeOf(traffic.cursorAt(v.id, tick));
      return graph.edgePoints(edge).some((p) => Math.hypot(p.x - venue.x, p.y - venue.y) <= radius);
    };
    const middle = Math.floor((parade.from + parade.to) / 2);
    const before = traffic.vehicles.filter((v) => traffic.outAt(v.id, middle) && near(middle, v));
    expect(before.length).toBeGreaterThan(0);

    traffic.hours.close(venues);
    for (const tick of [parade.from, middle, parade.to - 1]) {
      const on = traffic.vehicles.filter((v) => traffic.outAt(v.id, tick) && near(tick, v));
      expect(on.map((v) => v.id), `tick ${tick}`).toEqual([]);
    }
    // The street opens again the next day.
    const after = middle + TICKS_PER_DAY;
    expect(traffic.vehicles.some((v) => traffic.outAt(v.id, after) && near(after, v))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { tramBoxes, tramCarPlan, type TramDesign, type TramModule } from '../src/render/tram-mesh.ts';
import { SIGNAL_CYCLE, TrafficSignals } from '../src/sim/signals.ts';
import { laneOffset, type AmbientPose } from '../src/sim/traffic.ts';
import { QUEUE_CLEAR } from '../src/sim/traffic-timing.ts';
import { ARRIVAL_TICKS, BOARD_TICKS, CAR_GAP, CAR_HALF_HEIGHT, CAR_HALF_WIDTH, CAR_LENGTH, DWELL, STOP_CAP, TRAM_CARS, TRAM_CLEAR, TRAM_TRACK, TramLine } from '../src/sim/tram.ts';
import type { RoadEdge } from '../src/world/graph.ts';
import { TIERS, TRAM_LANE } from '../src/world/tiers.ts';
import { COUNTDOWN_CAP } from '../src/sim/tram.ts';
import { CELL_HEIGHT, CELL_WIDTH, countdownCell, destinationCell, stopNameCell, tramSignAtlas } from '../src/render/tram-sign-art.ts';
import { RING, ring } from './tram-ring.ts';

describe('the tram (spec section 13.2)', () => {
  const r = ring(1);
  const { line, tram, traffic } = r;
  const graph = r.roads.graph;
  const signals = traffic.signals as TrafficSignals;
  const tour = line.tour;
  if (tour === undefined) throw new Error('no tram on the ring');
  const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };

  it('runs a loop of whole signal cycles, and is where it was one lap later', () => {
    expect(line.trams).toBeGreaterThan(0);
    expect(tour.period % SIGNAL_CYCLE).toBe(0);
    for (const tick of [0, 1234, 98_765]) {
      const a = line.carPose(0, 1, tick, { ...pose });
      const b = line.carPose(0, 1, tick + tour.period, { ...pose });
      expect(b).toEqual(a);
    }
  });

  it('gives a light to every level crossing, an alley included', () => {
    const lit = signals.junctions.map((junction) => junction.node);
    expect(tram.crossings.length).toBe(4);
    for (const crossing of tram.crossings) expect(lit, `node ${crossing.node}`).toContain(crossing.node);
    // Without the tram the alley's junction takes no light.
    const without = new TrafficSignals(1, r.roads.roads, graph, r.roads.junctions as NonNullable<typeof r.roads.junctions>, r.roads.heightAt);
    expect(without.junctions.length).toBe(3);
  });

  it('crosses a light only on its green, with time left to clear the junction', () => {
    // A tram pulls away from a halt on a bell step. At a light that step starts on
    // the green of the tram's own road and the green lasts until it is across.
    let checked = 0;
    for (let step = 0; step < tour.stepTicks.length; step++) {
      const leg = tour.stepLeg[step] as number;
      const approach = signals.approachOf(tour.edges[leg] as number);
      const leaving = step > 0 && tour.stepFrom[step] === tour.stepTo[step - 1] && (tour.stepTo[step] as number) > (tour.stepFrom[step] as number);
      if (approach === undefined || !leaving || tour.stepLeg[step - 1] !== leg) continue;
      for (let lap = 0; lap < 3; lap++) {
        const tick = (tour.stepStart[step] as number) + tour.sync + lap * tour.period;
        expect(signals.light(approach, tick), `step ${step}`).toBe('green');
        expect(signals.light(approach, tick + TRAM_CLEAR - 1), `step ${step}`).toBe('green');
      }
      checked++;
    }
    expect(checked).toBe(4);
  });

  it('stands at every stop for its dwell, and rings its bell as it pulls away', () => {
    for (const stop of tram.stops) {
      const call = line.calls[stop.id];
      if (call === undefined) throw new Error(`no call at stop ${stop.id}`);
      expect(call.depart - call.arrive).toBeGreaterThanOrEqual(DWELL);
      const at = (tick: number): number => line.frontAt(0, tick - line.loopTick(0, 0));
      const standing = at(call.arrive);
      for (const into of [1, DWELL / 2, call.depart - call.arrive - 1]) expect(at(call.arrive + into)).toBeCloseTo(standing, 9);
      // The stop is at a corner of the ring, and the front halts short of it.
      const front = line.carPose(0, 0, call.arrive - line.loopTick(0, 0), { ...pose });
      expect(Math.hypot(front.x - stop.x, front.y - stop.y)).toBeLessThan(40);
      const depart = mod(call.depart, tour.period) - line.loopTick(0, 0);
      expect(line.bells(depart).map((bell) => bell.tram)).toContain(0);
      expect(line.bells(depart + 1)).toEqual([]);
    }
  });

  it('runs its cars nose to tail on the right-hand track of the reserved lane', () => {
    for (let tick = 0; tick < tour.period; tick += 997) {
      const cars = [0, 1, 2].map((car) => line.carPose(0, car, tick, { ...pose }));
      for (const car of cars) {
        // Off the middle of the nearest side of the ring by the track, away from the corners.
        const side = Math.abs(Math.abs(car.x) - RING) < Math.abs(Math.abs(car.y) - RING) ? Math.abs(car.x) : Math.abs(car.y);
        const along = side === Math.abs(car.x) ? Math.abs(car.y) : Math.abs(car.x);
        if (along > RING - 20) continue;
        expect(Math.abs(side - RING), `tick ${tick}`).toBeCloseTo(TRAM_TRACK, 6);
      }
      for (let i = 0; i + 1 < TRAM_CARS; i++) {
        const a = cars[i] as AmbientPose;
        const b = cars[i + 1] as AmbientPose;
        expect(Math.hypot(a.x - b.x, a.y - b.y), `tick ${tick}`).toBeLessThanOrEqual(CAR_LENGTH + CAR_GAP + 1e-6);
        // Round a corner the straight line between two cars is shorter than the track between them.
        if (Math.abs(a.heading - b.heading) < 1e-6) expect(Math.hypot(a.x - b.x, a.y - b.y), `tick ${tick}`).toBeGreaterThan(CAR_LENGTH);
      }
    }
  });

  it('keeps the traffic out of the reserved lane of the roads it runs down', () => {
    const arterial = { tier: 'arterial' as const, lanes: TIERS.arterial.lanes };
    expect(laneOffset(arterial, 0, true) - 1).toBeGreaterThanOrEqual(TRAM_LANE.halfWidth);
    expect(laneOffset(arterial, arterial.lanes - 1, true) + 1).toBeLessThanOrEqual(TIERS.arterial.width / 2);
    expect(TRAM_TRACK + CAR_HALF_WIDTH).toBeLessThanOrEqual(TRAM_LANE.halfWidth);
    // A vehicle down a side of the ring drives clear of the tram's lane.
    let seen = 0;
    for (const vehicle of traffic.vehicles) {
      for (const tick of [0, 3001, 6007]) {
        const cursor = traffic.cursorAt(vehicle.id, tick);
        if ((graph.edges[traffic.edgeOf(cursor)] as RoadEdge).tier !== 'arterial') continue;
        const at = traffic.pose(cursor, { ...pose });
        const across = Math.min(Math.abs(Math.abs(at.x) - RING), Math.abs(Math.abs(at.y) - RING));
        if (Math.max(Math.abs(at.x), Math.abs(at.y)) > RING + 20 || Math.min(Math.abs(at.x), Math.abs(at.y)) > RING - 30) continue;
        if (Math.min(Math.abs(at.x), Math.abs(at.y)) < 30) continue;
        expect(across, `vehicle ${vehicle.id} at tick ${tick}`).toBeGreaterThanOrEqual(TRAM_LANE.halfWidth);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('keeps a queue at a red light out of the junction behind it, where a tram may be crossing', () => {
    let waits = 0;
    for (const vehicle of traffic.vehicles) {
      const t = vehicle.tour;
      for (let step = 0; step < t.stepTicks.length; step++) {
        if (t.stepFrom[step] !== t.stepTo[step] || t.stepCall[step] === 1) continue;
        waits++;
        // A queue may run back through a node that keeps nothing clear, onto
        // the leg before; it stops short of every node that does.
        const edge = graph.edges[t.edges[t.stepLeg[step] as number] as number] as RoadEdge;
        if (!signals.keepsClear(edge.from)) continue;
        const reach = signals.approachOf(edge.id)?.stop ?? edge.length;
        expect(t.stepFrom[step], `vehicle ${vehicle.id}`).toBeGreaterThanOrEqual(Math.min(QUEUE_CLEAR, reach) - 1e-9);
      }
    }
    expect(waits).toBeGreaterThan(0);
  });

  it('gathers people at a stop between trams and boards them while one stands there', () => {
    const call = line.calls[1];
    if (call === undefined) throw new Error('no call at stop 1');
    const tickOf = (loop: number): number => loop - line.loopTick(0, 0);
    // Just after a tram leaves nobody is left; by the next one the stop is as
    // full as the headway lets it get.
    const headway = tour.period / line.trams;
    expect(line.waiting(1, tickOf(call.depart))).toBe(0);
    expect(line.waiting(1, tickOf(call.depart + 3 * ARRIVAL_TICKS + 1))).toBe(3);
    // The trams are spread over whole signal cycles, so the gap before one
    // arrives is the headway give or take a cycle: the queue it finds is what
    // that gap gathered, never more than the cap.
    const full = line.waiting(1, tickOf(call.arrive));
    expect(full).toBeGreaterThan(0);
    expect(full).toBeLessThanOrEqual(Math.min(STOP_CAP, Math.ceil(headway / ARRIVAL_TICKS)));
    expect(line.waiting(1, tickOf(call.arrive + BOARD_TICKS / 2))).toBeLessThan(full);
    expect(line.waiting(1, tickOf(call.arrive + BOARD_TICKS))).toBe(0);
    const out: Parameters<TramLine['passengers']>[5] = [];
    const stop = tram.stops[1] as (typeof tram.stops)[number];
    expect(line.passengers(stop.x - 60, stop.y - 60, stop.x + 60, stop.y + 60, tickOf(call.arrive), out)).toBe(full);
    for (const person of out.slice(0, full)) {
      expect(person.pose.gait).toBe('stand');
      expect(Math.hypot(person.pose.x - stop.x, person.pose.y - stop.y)).toBeLessThan(60);
    }
  });

  it('is the same line for the same seed, and none for a world without a loop', () => {
    const again = ring(1).line;
    for (const tick of [0, 5000, 77_777]) expect(again.carPose(0, 2, tick, { ...pose })).toEqual(line.carPose(0, 2, tick, { ...pose }));
    const empty = new TramLine(1, r.roads, { route: [], edges: [], corridors: [], stops: [], crossings: [], length: 0 }, r.districts, signals);
    expect(empty.trams).toBe(0);
    expect(empty.bells(10)).toEqual([]);
    expect(empty.waiting(0, 10)).toBe(0);
  });

  it('draws every module of both fleets inside the box the physics gives a car', () => {
    for (const design of ['modern', 'heritage'] as TramDesign[]) {
      for (const module of ['end', 'middle'] as TramModule[]) {
        for (const box of tramBoxes(design, module)) {
          if (!box.outlined) continue;
          expect(Math.abs(box.x) + box.length / 2).toBeLessThanOrEqual(CAR_LENGTH / 2);
          expect(Math.abs(box.z) + box.width / 2).toBeLessThanOrEqual(CAR_HALF_WIDTH);
          expect(box.y + box.height / 2).toBeLessThanOrEqual(2 * CAR_HALF_HEIGHT);
        }
      }
    }
  });

  it('turns the rear module of a modern tram about, and leaves a heritage car either way round', () => {
    expect(tramCarPlan('modern', 0, 3)).toEqual({ module: 'end', reversed: false });
    expect(tramCarPlan('modern', 1, 3)).toEqual({ module: 'middle', reversed: false });
    expect(tramCarPlan('modern', 2, 3)).toEqual({ module: 'end', reversed: true });
    for (const car of [0, 1, 2]) expect(tramCarPlan('heritage', car, 3)).toEqual({ module: 'middle', reversed: false });
  });

  it('runs both fleets off the zone of the stop each tram starts from', () => {
    for (let tram = 0; tram < line.trams; tram++) expect(['modern', 'heritage']).toContain(line.design(tram));
  });
});

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

describe('the lettering of the tram (spec section 13.2)', () => {
  const r = ring(1);
  const line = r.line;
  const names = line.calls.map((_, stop) => line.stopName(stop));

  it('names every stop it calls at', () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name.length).toBeGreaterThan(0);
  });

  it('gives every line of text a cell of its own', () => {
    const atlas = tramSignAtlas(names);
    expect(atlas.width).toBe(CELL_WIDTH);
    expect(atlas.height).toBe(CELL_HEIGHT * atlas.cells);
    expect(atlas.data.length).toBe(atlas.width * atlas.height * 4);
    const taken = new Set<number>();
    for (let stop = 0; stop < names.length; stop++) {
      for (const design of ['heritage', 'modern'] as const) taken.add(destinationCell(stop, design));
      taken.add(stopNameCell(names.length, stop));
    }
    for (let minutes = 0; minutes <= COUNTDOWN_CAP; minutes++) taken.add(countdownCell(names.length, minutes));
    // Every cell is used, and no two lines of text share one.
    expect(taken.size).toBe(atlas.cells);
    for (const cell of taken) expect(cell).toBeLessThan(atlas.cells);
  });

  it('caps a countdown rather than running off the end of the atlas', () => {
    expect(countdownCell(names.length, 1000)).toBe(countdownCell(names.length, COUNTDOWN_CAP));
    expect(countdownCell(names.length, -5)).toBe(countdownCell(names.length, 0));
  });

  it('shows a tram the stop it is running towards, and reads 0 while it stands there', () => {
    const tour = line.tour;
    if (tour === undefined) throw new Error('no tram on the ring');
    for (const call of line.calls) {
      const stop = line.calls.indexOf(call);
      // At the tick it arrives, some tram is at the stop, so the countdown is 0.
      expect(line.minutesTo(stop, call.arrive)).toBe(0);
    }
    // A board always names a call of this loop, and one it is within the cap of.
    for (let time = 0; time < tour.period; time += Math.floor(tour.period / 17)) {
      const call = line.nextCall(0, time);
      expect(call).toBeGreaterThanOrEqual(0);
      expect(call).toBeLessThan(line.calls.length);
      expect(line.minutesTo(call, time)).toBeLessThanOrEqual(COUNTDOWN_CAP);
    }
  });
});

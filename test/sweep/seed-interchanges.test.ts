import { expect, it } from 'vitest';
import { type RoadEdge, type RoadGraph } from '../../src/world/roads/graph.ts';
import { footprintHalfWidth, TIERS } from '../../src/world/roads/tiers.ts';
import { type Point, type RoadCurve, type WorldDescription } from '../../src/world/types.ts';
import { distanceToSegment, nodePoints, placeOn, polylineLength } from './seed-probes.ts';
import { seeds, worlds, graphOf } from './seed-fixture.ts';
import { sweepSuite } from './seed-suite.ts';

/**
 * The most roads a world may pass under highway slots per kilometre of highway,
 * and the least highway a world must hold to be counted. One road at most
 * passes under each stretch between two interchanges, which stand
 * `INTERCHANGE_SPACING` (700 m) apart, and over 12 sweep seeds the worst world
 * runs at 1.1 per kilometre. The bound is tighter than the one on every grade
 * separation (`seed-roads.test.ts`), which counts the overpasses of the
 * diamonds and the decks over them as well.
 */
const SLOT_CROSSINGS_PER_KM = 1.5;
const SLOT_KM_FLOOR = 2;

/** Takes a fault in words. A check keeps only the first one it is given. */
type Fault = (text: string) => void;

/** Runs a check that reports faults, and returns the first of them. */
function firstFault(check: (fault: Fault) => void): string | undefined {
  let complaint: string | undefined;
  check((text) => {
    complaint ??= text;
  });
  return complaint;
}

type Foot = { exits: number; entries: number; arterial: number };
type Met = ReturnType<typeof nodePoints>;

/** Checks that one ramp links a highway and an arterial, and counts it at its foot. */
function checkRamp(w: WorldDescription, met: Met, road: RoadCurve, feet: Map<number, Foot>, fault: Fault): void {
  if ((road.tier === 'ramp') !== (road.ramp !== undefined)) fault(`${road.tier} ${road.id} is a ramp in one way only`);
  const ramp = road.ramp;
  if (ramp === undefined) return;
  const where = `ramp ${road.id}`;
  const highway = w.roads[ramp.highway] as RoadCurve;
  const arterial = w.roads[ramp.arterial] as RoadCurve;
  if (highway.tier !== 'highway' || arterial.tier !== 'arterial') fault(`${where} links a ${highway.tier} and a ${arterial.tier}`);
  const last = road.points.length - 1;
  const [onHighway, onFoot] = ramp.exit ? [0, last] : [last, 0];
  const at = (k: number) => met.get(road.nodes[k] ?? -1) ?? [];
  if (!at(onHighway).some((o) => o.road.id === highway.id && o.at > 0 && o.at < highway.points.length - 1)) {
    fault(`${where} does not land inside highway ${highway.id}`);
  }
  if (!at(onFoot).some((o) => o.road.id === arterial.id)) fault(`${where} does not reach arterial ${arterial.id}`);
  for (let k = 1; k < last; k++) if (at(k).length > 0) fault(`${where} meets a road at its point ${k}`);
  const node = road.nodes[onFoot] as number;
  const foot = feet.get(node) ?? { exits: 0, entries: 0, arterial: arterial.id };
  if (ramp.exit) foot.exits++;
  else foot.entries++;
  feet.set(node, foot);
}

/** Checks that each foot has one ramp off and one on, and each arterial two feet at most. */
function checkFeet(feet: Map<number, Foot>, fault: Fault): void {
  const perArterial = new Map<number, number>();
  for (const [node, foot] of feet) {
    if (foot.exits !== 1 || foot.entries !== 1) fault(`the foot at node ${node} has ${foot.exits} off-ramps and ${foot.entries} on-ramps`);
    perArterial.set(foot.arterial, (perArterial.get(foot.arterial) ?? 0) + 1);
  }
  for (const [arterial, count] of perArterial) if (count > 2) fault(`arterial ${arterial} has ${count} feet`);
}

/** Checks that each ramp is one edge driven forward, and every other road runs both ways. */
function checkDirections(w: WorldDescription, graph: RoadGraph, fault: Fault): void {
  for (const edge of graph.edges) {
    const road = w.roads[edge.curve] as RoadCurve;
    if (road.tier !== 'ramp') {
      if (edge.twin < 0) fault(`${road.tier} ${road.id} runs one way`);
      continue;
    }
    if (edge.twin >= 0 || edge.end < edge.start) fault(`ramp ${road.id} runs against its own direction`);
  }
}

/** The count of nodes reached from node 0 along the edges, or against them when `forward` is false. */
function reach(graph: RoadGraph, forward: boolean): number {
  const seen = new Uint8Array(graph.nodes.length);
  const into: number[][] = graph.nodes.map(() => []);
  for (const edge of graph.edges) (into[edge.to] as number[]).push(edge.id);
  const stack = [0];
  seen[0] = 1;
  let count = 1;
  while (stack.length > 0) {
    const at = stack.pop() as number;
    const out = forward ? graph.edgesFrom(at) : (into[at] as number[]);
    for (const e of out) {
      const edge = graph.edges[e] as RoadEdge;
      const next = forward ? edge.to : edge.from;
      if (seen[next] === 1) continue;
      seen[next] = 1;
      count++;
      stack.push(next);
    }
  }
  return count;
}

/** Checks the roads under the slots: one per stretch, and few per kilometre of highway. */
function checkSlots(w: WorldDescription, graph: RoadGraph, fault: Fault): void {
  let km = 0;
  for (const road of w.roads) if (road.tier === 'highway') km += polylineLength(road.points) / 1000;
  const stretches = new Map<string, number>();
  let count = 0;
  for (const crossing of graph.crossings) {
    const over = w.roads[(graph.edges[crossing.over] as RoadEdge).curve] as RoadCurve;
    const segment = placeOn(over, crossing)?.segment ?? -1;
    if (over.tier !== 'highway' || !(over.slots ?? []).includes(segment)) continue;
    const under = w.roads[(graph.edges[crossing.under] as RoadEdge).curve] as RoadCurve;
    if (under.tier === 'highway') continue;
    count++;
    const stretch = `${over.id}:${over.interchanges.filter((i) => i <= segment).length}`;
    const before = stretches.get(stretch);
    if (before !== undefined && before !== under.id) fault(`${under.tier} ${under.id} and road ${before} both pass under stretch ${stretch}`);
    stretches.set(stretch, under.id);
  }
  if (km >= SLOT_KM_FLOOR && count / km > SLOT_CROSSINGS_PER_KM) fault(`${count} slot crossings over ${km.toFixed(1)} km of highway`);
}

/** The first place a ramp lies on the carriageway of another road, away from the ramp's two ends. */
function rampOverlap(ramp: RoadCurve, other: RoadCurve): string | undefined {
  const ends = [ramp.points[0] as Point, ramp.points[ramp.points.length - 1] as Point];
  const clear = (TIERS.ramp.width + TIERS[other.tier].width) / 2;
  // Near an end the two roads meet, and there they may share ground.
  const free = clear + footprintHalfWidth(other.tier);
  for (const p of ramp.points) {
    if (ends.some((e) => Math.hypot(e.x - p.x, e.y - p.y) < free)) continue;
    for (let j = 0; j + 1 < other.points.length; j++) {
      if (other.bridges.includes(j) || other.tunnels.includes(j)) continue;
      const d = distanceToSegment(p, other.points[j] as Point, other.points[j + 1] as Point);
      if (d < clear) return `ramp ${ramp.id} lies ${d.toFixed(1)} m from ${other.tier} ${other.id} at ${p.x.toFixed(0)},${p.y.toFixed(0)}`;
    }
  }
  return undefined;
}

/**
 * The seed sweep of spec section 3, on the interchanges of spec section 6.2: a
 * highway has on and off ramps, and an arterial reaches it over them and never
 * at grade (`diamonds.ts`).
 */
sweepSuite('interchanges', () => {
  it('links each foot of a diamond to the highway with one off-ramp and one on-ramp', () => {
    // An off-ramp runs from a highway to the foot on its arterial, an on-ramp
    // from the foot back to a highway. Half a diamond has one foot and the
    // whole one has two, one each side of the overpass.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const met = nodePoints(w.roads);
      const complaint = firstFault((fault) => {
        const feet = new Map<number, Foot>();
        for (const road of w.roads) checkRamp(w, met, road, feet, fault);
        checkFeet(feet, fault);
      });
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('drives every ramp one way, and leaves every node reachable from every other', () => {
    // A ramp is one edge with no twin, from its first point to its last. The
    // two-way roads join into one network, and each foot has a way on and a way
    // off, so a car can get from any node to any other.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const graph = graphOf(seed);
      const complaint = firstFault((fault) => {
        checkDirections(w, graph, fault);
        if (graph.nodes.length === 0) return;
        const there = reach(graph, true);
        const back = reach(graph, false);
        if (there !== graph.nodes.length || back !== graph.nodes.length) {
          fault(`${graph.nodes.length} nodes, ${there} reached from node 0 and ${back} reaching it`);
        }
      });
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('passes one road at most under the slots of each stretch of highway between two interchanges', () => {
    // A road that passes under a highway can never turn onto it. Where one
    // already passes, the next one reaches the highway at an interchange.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const graph = graphOf(seed);
      const complaint = firstFault((fault) => checkSlots(w, graph, fault));
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('lays no ramp over the carriageway of another road away from its two ends', () => {
    // A ramp shares ground only where it leaves the foot and where it lands.
    // Elsewhere its carriageway keeps clear of every road on the ground.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      let complaint: string | undefined;
      for (const ramp of w.roads) {
        if (ramp.ramp === undefined) continue;
        for (const other of w.roads) if (other.id !== ramp.id) complaint ??= rampOverlap(ramp, other);
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('climbs every ramp no harder than the arterial it leaves', () => {
    expect(TIERS.ramp.maxGrade).toBe(TIERS.arterial.maxGrade);
  });
});

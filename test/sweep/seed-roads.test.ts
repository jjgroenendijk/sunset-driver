import { expect, it } from 'vitest';
import { MINOR_BY_ZONE } from '../../src/world/roads/fill.ts';
import { type GradeCrossing, type RoadEdge, type RoadGraph, type RoadNode, type RoadRoute } from '../../src/world/roads/graph.ts';
import { HEADROOM_SLACK } from '../../src/world/junctions/crossing-plan.ts';
import { DECK_SOFFIT } from '../../src/world/decks/decks.ts';
import { deckRuns, overWater } from '../../src/world/decks/piers.ts';
import { WATER_CLEARANCE } from '../../src/world/decks/water-lift.ts';
import { CLEARANCE as OVERPASS_CLEARANCE } from '../../src/world/junctions/overpass.ts';
import { Heightfield } from '../../src/world/terrain/heightfield.ts';
import { RiverWater } from '../../src/world/decks/river-decks.ts';
import { coastNoise, islandAt } from '../../src/world/terrain/terrain.ts';
import { mayCross, TIERS } from '../../src/world/roads/tiers.ts';
import { type Point, type RoadCurve, type RoadTier, type WorldDescription, type Zone } from '../../src/world/types.ts';
import { blockSamples, piecesOf } from './seed-blocks.ts';
import { PointGrid } from './seed-index.ts';
import {
  WET_SAMPLE,
  nodePoints,
  nodeVisits,
  CLEARANCE,
  gradeOf,
  profileUnder,
  wetFraction,
  spansCrossing,
  median,
  polylineLength,
  liftAtCrossing,
  placeOn,
} from './seed-probes.ts';
import { seeds, worlds, bedsOf, graphOf } from './seed-fixture.ts';
import { sweepSuite } from './seed-suite.ts';

/**
 * The most grade separations a world may carry per kilometre of highway, and
 * the least highway a world must hold to be counted. Over 500 seeds the rate
 * is 0.7 per kilometre and the worst world runs at 1.6; a world with only a
 * few kilometres of highway swings widest, which is what the floor is for.
 * The bound is a guard against the tangle of issue #269 — one grade
 * separation per 81 m of highway, over 12 per kilometre — coming back, not a
 * target.
 */
const HIGHWAY_SEPARATIONS_PER_KM = 3;
const HIGHWAY_KM_FLOOR = 2;

/**
 * The least share of the decks over water that stand the full
 * {@link WATER_CLEARANCE} clear of the sea. The rest are the decks with the
 * end of their line, a bore or a junction already laid at an abutment, which
 * leaves the ramp nowhere to come down and so no lift to take
 * (`water-lift.ts`). The floor is a guard against the lift being lost, not a
 * target.
 */
const WATER_DECKS_LIFTED = 0.5;

/** The first fault of one seed: a test asserts once a seed, not once a segment. */
class Faults {
  first: string | undefined;
  add(text: string | undefined): void {
    this.first ??= text;
  }
}

/** A point of a curve that stands on a node, with the index it sits at. */
interface NodePoint {
  road: RoadCurve;
  at: number;
}

/**
 * The seed sweep of spec section 3, on the road network of spec section 6: one
 * component, one graph, and the rules two roads meet under.
 */
sweepSuite('roads', () => {
  it('joins every road of every tier into one network', () => {
    // Dirt roads are not in this list: on the smallest maps the outskirts ring
    // falls almost entirely in the water, and there is no wilderness to thread.
    // Where that ground does exist, the block sizes below ask for dirt roads.
    const tiers: RoadTier[] = ['highway', 'arterial', 'street', 'alley'];
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      expect(w.roads.length, `seed ${seed}`).toBeGreaterThan(0);
      for (const tier of tiers) {
        expect(w.roads.some((r) => r.tier === tier), `seed ${seed} has no ${tier}`).toBe(true);
      }

      const faults = new Faults();
      w.roads.forEach((road, i) => curveFaults(road, i, faults));
      nodePlaceFaults(w.roads, faults);
      expect(faults.first, `seed ${seed}`).toBeUndefined();
      // Curves that share a node are one road network. Every curve is traced
      // from a road already laid or into one, so there is only ever one.
      const networks = networkCount(w.roads);
      expect(networks, `seed ${seed}: ${networks} road networks`).toBe(1);
    }
  });

  it('builds one road graph that holds the whole curve network', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const graph = graphOf(seed);
      expect(graph.nodes.length, `seed ${seed}`).toBeGreaterThan(0);

      // Every curve is on the graph, and every node has a road leaving it.
      const faults = new Faults();
      const covered = new Uint8Array(w.roads.length);
      for (const edge of graph.edges) covered[edge.curve] = 1;
      for (const road of w.roads) if (covered[road.id] !== 1) faults.add(`curve ${road.id} has no edge`);
      for (const node of graph.nodes) if (graph.degree(node.id) <= 0) faults.add(`node ${node.id} has no road leaving it`);
      expect(faults.first, `seed ${seed}`).toBeUndefined();

      // The curves are one network, so the graph is one component too.
      expect(reachedFromFirst(graph), `seed ${seed}: the graph is not one network`).toBe(graph.nodes.length);

      // Pathfinding crosses that network: the core to the node furthest from it.
      const start = graph.nearestNode(w.core.x, w.core.y) as number;
      const far = furthestNode(graph, w.core);
      const route = graph.shortestPath(start, far);
      expect(route, `seed ${seed}: no route from the core to node ${far}`).toBeDefined();
      const taken = route as NonNullable<typeof route>;
      expect(taken.nodes[0]).toBe(start);
      expect(taken.nodes[taken.nodes.length - 1]).toBe(far);
      // A drive is never shorter than the straight line it covers.
      const head = graph.nodes[start] as RoadNode;
      const tail = graph.nodes[far] as RoadNode;
      expect(taken.length, `seed ${seed}`).toBeGreaterThanOrEqual(Math.hypot(head.x - tail.x, head.y - tail.y) - 1e-6);
      routeFaults(graph, taken, faults);
      expect(faults.first, `seed ${seed}`).toBeUndefined();

      // The nearest point of the network to a node is that node's own ground.
      const probe = graph.nodes[graph.nodes.length >> 1] as RoadNode;
      const hit = graph.nearestEdge(probe.x, probe.y);
      expect(hit?.distance, `seed ${seed}`).toBeLessThan(1);
    }
  });

  it('makes no junction where one road is carried over another', () => {
    // Spec section 6.2: an overpass is not a junction. Both runs know about the
    // crossing, and no node stands on it, so no car can turn there.
    for (const seed of seeds) {
      const graph = graphOf(seed);
      const faults = new Faults();
      for (let k = 0; k < graph.crossings.length; k++) {
        const crossing = graph.crossings[k] as GradeCrossing;
        const where = `crossing ${k} at ${crossing.x.toFixed(0)},${crossing.y.toFixed(0)}`;
        const node = graph.nodes[graph.nearestNode(crossing.x, crossing.y) as number] as RoadNode;
        if (Math.hypot(node.x - crossing.x, node.y - crossing.y) <= 0.001) faults.add(`${where} is a junction`);
        const over = graph.edges[crossing.over] as RoadEdge;
        const under = graph.edges[crossing.under] as RoadEdge;
        if (over.curve === under.curve) faults.add(`${where} joins a road to itself`);
        if (!over.crossings.includes(k)) faults.add(`${where} is not marked on the road above`);
        if (!under.crossings.includes(k)) faults.add(`${where} is not marked on the road below`);
      }
      expect(faults.first, `seed ${seed}`).toBeUndefined();
    }
  });

  it('leaves no crossing flat: two roads that cross meet, or one stands a clearance over the other', () => {
    // Spec section 6.2: a crossing is decided when its second road is added,
    // never afterwards. The two roads take a junction there, which is a node
    // and no crossing at all, or one is carried over the other. The headroom
    // is measured on the surface each road drives, `RoadBeds` of `bed.ts`, and
    // never on the lift of one of them: the two roads have different points,
    // so a lift of the clearance over the ground under one of them left the
    // two surfaces as little as 1.5 m apart (issue #290). Where neither road
    // clears the other the road is shortened or refused, so no refusal leaves
    // a crossing flat.
    //
    // Which road the graph calls the one above says nothing about the height:
    // between two decks it goes by the segment they were laid in. So this asks
    // that the two stand apart, not which way round. A crossing under a deck
    // already standing keeps the `HEADROOM_SLACK` the plan allows it.
    //
    // The surfaces are the finished ones, junction planes and all, which is
    // what a lorry meets. A junction is one plane and carries every road that
    // meets it out to its cut, so a crossing inside that reach drives off its
    // own bed; the plan measures that reach where it decides the crossing and
    // keeps a junction laid later out of it (`plane-lift.ts`, issue #533).
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const graph = graphOf(seed);
      const beds = bedsOf(seed);
      let complaint: string | undefined;
      for (const crossing of graph.crossings) {
        const over = w.roads[(graph.edges[crossing.over] as RoadEdge).curve] as RoadCurve;
        const under = w.roads[(graph.edges[crossing.under] as RoadEdge).curve] as RoadCurve;
        const one = placeOn(over, crossing);
        const other = placeOn(under, crossing);
        if (one === undefined || other === undefined) {
          complaint ??= `crossing at ${crossing.x.toFixed(0)},${crossing.y.toFixed(0)} stands on neither road`;
          continue;
        }
        const apart = Math.abs(beds.heightAt(over.id, one.segment, one.t) - beds.heightAt(under.id, other.segment, other.t));
        if (apart >= OVERPASS_CLEARANCE - HEADROOM_SLACK) continue;
        const where = `at ${crossing.x.toFixed(0)},${crossing.y.toFixed(0)}`;
        complaint ??= `${over.tier} ${over.id} crosses ${under.tier} ${under.id} ${where} with ${apart.toFixed(2)} m of headroom`;
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('junctions a highway only at an interchange, and never with a minor road', () => {
    // Spec section 6.2: a highway has junctions only at interchanges and no
    // pedestrians on it. So a street, an alley or a dirt road never shares a
    // point with one — where they cross, the graph makes it an overpass. A
    // highway meets one only at a point it lists, and a ramp only as its own.
    // An arterial never meets one at grade: where it reaches an interchange it
    // takes a diamond (`diamonds.ts`), and it shares a point with a highway
    // only where the highway ends on it. The one exception is an island link
    // that ends on an interchange with no ground for the foot of a diamond
    // between the highway and its deck (`RoadNetwork.addWithDiamond`), and
    // another arterial that ends on that junction.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const faults = new Faults();
      // Every curve point on each node, with the index the point sits at.
      const met = nodePoints(w.roads);
      for (const road of w.roads) {
        if (road.tier !== 'highway') {
          if (road.interchanges.length > 0) faults.add(`${road.tier} ${road.id} lists interchanges`);
          continue;
        }
        interchangeListFaults(road, faults);
        meetingFaults(road, met, faults);
      }
      expect(faults.first, `seed ${seed}`).toBeUndefined();
    }
  });

  it('crosses a highway only under the level deck of one of its slots', () => {
    // Spec section 6.2: a highway is planned with its decks when it is laid,
    // and a road laid later passes under a slot or reaches the highway at an
    // interchange. Every other crossing is refused while the road is traced,
    // so none is left for `overpass.ts` to raise between two junctions. The one
    // road raised over a highway is the arterial of a whole diamond, which
    // crosses the interchange on an overpass between the feet of its ramps.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const graph = graphOf(seed);
      const faults = new Faults();
      for (const road of w.roads) slotFaults(road, faults);
      for (const crossing of graph.crossings) faults.add(highwayCrossingFault(w, graph, crossing));
      expect(faults.first, `seed ${seed}`).toBeUndefined();
    }
  });

  it('keeps every minor road off a highway, and grade separation scarce (issue #269)', () => {
    // A grade separation is a severance: a place two roads pass and can never
    // turn onto each other. `mayCross` says which pairs are worth one. A
    // street, an alley or a dirt road is not: it stops short of the highway
    // and takes a cul-de-sac, so only a highway or an arterial crosses one.
    //
    // The bound is per kilometre of highway, since a highway is what the
    // crossings are counted against. A world laid before the policy carried
    // one grade separation per 81 m of highway — over 12 per kilometre.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const graph = graphOf(seed);
      let complaint: string | undefined;
      const highwayKm = highwayLength(w.roads);
      let separations = 0;
      for (const crossing of graph.crossings) {
        const over = curveOf(w, graph, crossing.over);
        const under = curveOf(w, graph, crossing.under);
        if (!mayCross(over.tier, under.tier)) {
          complaint ??= `${over.tier} ${over.id} crosses ${under.tier} ${under.id} at ${crossing.x.toFixed(0)},${crossing.y.toFixed(0)}`;
        }
        if (over.tier === 'highway' || under.tier === 'highway') separations++;
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
      if (highwayKm >= HIGHWAY_KM_FLOOR) expect(separations / highwayKm, `seed ${seed}`).toBeLessThan(HIGHWAY_SEPARATIONS_PER_KM);
    }
  });

  it('cuts each zone into blocks of about the size it asks for', () => {
    // Half the width of a block, near enough: the median distance from the
    // ground of a zone to the nearest road. Blocks tighten toward downtown
    // because the fill spaces its roads by the density of the district.
    //
    // The floor reads every sample of the zone and the ceiling only the
    // ground the fill was asked to cover. Ground it was never asked to cover
    // — an outer island no bridge reaches, a hilly arm of the mainland no
    // district stands on, a shelf behind a cliff — only ever puts the median
    // up, never down, so a floor may read all of it and a ceiling may not.
    // What the fill was asked to cover is the land the core stands on, inside
    // {@link CATCHMENT} of a district of that zone, that a road of the zone's
    // minor tier can climb to from the core. The rings of spec section 8.2
    // are concentric circles over the whole map, and the fill is seeded from
    // the district sites, so the two are not the same ground. An airfield is
    // ground the fill was told to keep off.
    //
    // The ceilings are the spacing the fill asks for, with room for the
    // ground that refuses a road: a mesh of streets `across` apart leaves a
    // median half-block of a quarter of `across`, which is 30 m for the
    // inner ring's widest 120 m. The outer zones keep the looser ceilings
    // they were given, since their fill works around far more refused ground.
    // The floors catch the opposite fault, a fill collapsed into a mesh far
    // tighter than the zone asks for. These are here to catch a fill that has
    // gone wrong, not to pin the figure down.
    const RANGE: Record<Zone, [number, number]> = {
      core: [3, 20],
      inner: [5, 30],
      industrial: [7, 200],
      suburban: [7, 200],
      outskirts: [14, 400],
      wilderness: [25, 800],
    };
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const { samples, filled } = blockSamples(w, hf);
      for (const zone of Object.keys(RANGE) as Zone[]) {
        const found = samples[zone] ?? [];
        const covered = filled[zone] ?? [];
        const [lo, hi] = RANGE[zone];
        // A zone can be a sliver on one seed; too few samples say nothing. A
        // piece of a zone smaller than one block of its own widest spacing has
        // no block to measure either: the two wilderness corners of one small
        // map were 31 samples, and one road along a row of them halved the
        // median. Two such corners are no bigger a block for being two
        // (seed 3749529874), so the floor reads only the pieces a block fits in.
        const spacing = MINOR_BY_ZONE[zone];
        const block = (spacing.across[1] * spacing.along[1]) / (8 * hf.cellSize) ** 2;
        const whole = piecesOf(found, block);
        if (whole.length >= 20) expect(median(whole), `seed ${seed}: ${zone} blocks`).toBeGreaterThanOrEqual(lo);
        if (covered.length >= 20) expect(median(covered), `seed ${seed}: ${zone} blocks`).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('caps the dead ends of streets, alleys and dirt roads', () => {
    // A minor road that met no other road on one side is trimmed to a
    // cul-de-sac, so a free end always stands near the network it hangs off:
    // within the trim, plus the spacing its seed stood off its parent. The caps
    // are in metres, and the loosest spacing of the tier's zones sets them. A
    // road that has to work around steep ground reaches further before it ends,
    // so the street and dirt caps are looser than the trim alone would ask for.
    // The street cap rose with the zone rings of spec section 8.2, which put
    // the street fill on hills the suburbs used to stop short of. It rose again
    // when the tracer began to keep roads off each other's carriageways: a road
    // that may not merge along another one ends as a cul-de-sac more often, and
    // the worst of 200 seeds reaches 328 m. A suburban seed stands up to 270 m
    // off its parent and the trim adds 162 m, so neither is past what the fill
    // lays by construction. It rose once more when the highways left the core
    // for a ring: an inner street seeded at the edge of the built-up ground,
    // with no arterial between it and its parent, stands up to the inner
    // zone's 570 m along spacing off it. The worst of 200 seeds reaches 517 m.
    // It rose a last time for the street that leaves the city. The street fill
    // keeps to paved ground, so such a street ends where that ground ends, and
    // the nearest road past it is a dirt road of the wilderness fill, which
    // stands up to `MINOR_BY_ZONE.wilderness.across` — 430 m — from the edge.
    // The trim adds up to 1.2 of the street's own widest spacing, 120 m in the
    // inner ring, so 574 m is what the fill lays by construction there, and the
    // cap is 580. Seed 2699365466 reads 564 m (issue #389).
    // The alley cap is loose for a different reason:
    // an alley stands half a block off the street that seeded it, and it is
    // trimmed to a cul-de-sac at each end that met nothing.
    //
    // A boardwalk is not asked at all. It has no seed and no parent: it is
    // laid along the line behind a dune, and it is laid when one of its two
    // ends reaches the network, so the other end stops where the sand stops
    // (issue #401).
    const CAP: Partial<Record<RoadTier, number>> = { street: 580, alley: 220, dirt: 900 };
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const grid = new PointGrid(w.size, 100, w.roads);
      const on = nodePoints(w.roads);
      const boardwalks = new Set(w.beaches.map((beach) => beach.boardwalkRoad));
      const faults = new Faults();
      for (const road of w.roads) {
        const cap = CAP[road.tier];
        if (cap === undefined || boardwalks.has(road.id)) continue;
        for (const i of [0, road.points.length - 1]) faults.add(deadEndFault(road, i, cap, on, grid));
      }
      expect(faults.first, `seed ${seed}`).toBeUndefined();
    }
  });

  it('reaches every island that carries a district with an arterial', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const noise = coastNoise(w.seed);
      const island = (p: Point): number => islandAt(w.water.islands, w.size, noise, p.x, p.y);
      const inhabited = new Set(w.districts.map((d) => island(d)));
      const served = new Set<number>();
      for (const road of w.roads) {
        if (road.tier !== 'arterial') continue;
        for (const p of road.points) if (hf.sample(p.x, p.y) >= w.water.seaLevel) served.add(island(p));
      }
      inhabited.forEach((i) => expect(served.has(i), `island ${i} of seed ${seed} has a district but no arterial`).toBe(true));
    }
  });

  it('keeps roads out of the water except on a bridge over a strait crossing or a river', () => {
    // As in the grade test below: one assertion a seed, so a hundred thousand
    // segments do not each pay for one.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const rivers = new RiverWater(w.water.rivers, hf, w.water.seaLevel);
      const faults = new Faults();
      for (const road of w.roads) waterFaults(w, hf, rivers, road, faults);
      expect(faults.first, `seed ${seed}`).toBeUndefined();
    }
  });

  it('stands the underside of a deck over water clear of the sea', () => {
    // Spec sections 6.1 and 7.2. Both abutments of a strait crossing stand at
    // the shore, so without a lift the deck is a straight line about a metre
    // over the water and its underside, `DECK_SOFFIT` below the surface it is
    // driven on, is under it: a boat could not pass and the piers below could
    // not be seen (issue #304). `water-lift.ts` carries the deck up and ramps
    // it back down each side. A deck whose line cannot hold a ramp keeps the
    // height its shores give it, so what is held here is every deck that had
    // the room, and the share of all of them that clears.
    let wet = 0;
    let lifted = 0;
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const beds = bedsOf(seed);
      const sea = w.water.seaLevel;
      let complaint: string | undefined;
      for (const road of w.roads) {
        for (const run of deckRuns(road, (a, b) => overWater(hf, sea, a, b), true)) {
          const clearance = lowestSurface(beds, road, run) - DECK_SOFFIT - sea;
          wet++;
          if (clearance >= WATER_CLEARANCE - 1e-6) lifted++;
          if (!deckPinned(road, run) && clearance <= 0) {
            complaint ??= `${road.tier} ${road.id} spans water with its underside ${(-clearance).toFixed(2)} m under it`;
          }
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
    expect(wet, 'no seed of the sweep crosses water on a deck').toBeGreaterThan(0);
    expect(lifted / wet).toBeGreaterThanOrEqual(WATER_DECKS_LIFTED);
  });

  it('never lays a road over ground its tier may not climb', () => {
    // Spec section 6.1: a segment steeper than its tier's maximum is rerouted,
    // bridged or tunnelled. So every segment on the ground is inside the limit,
    // and every segment outside it stands off the ground on a deck or in a bore.
    // There are a hundred thousand segments here, so the loop collects the first
    // complaint of each seed and asserts once rather than a hundred thousand times.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const faults = new Faults();
      for (const road of w.roads) {
        boreFaults(road, faults);
        for (let i = 0; i + 1 < road.points.length; i++) faults.add(segmentGradeFault(w, hf, road, i));
      }
      expect(faults.first, `seed ${seed}`).toBeUndefined();
    }
  });
});

/** The kilometres of highway among the curves. */
function highwayLength(roads: readonly RoadCurve[]): number {
  let km = 0;
  for (const road of roads) {
    if (road.tier !== 'highway') continue;
    km += polylineLength(road.points) / 1000;
  }
  return km;
}

/** The curve an edge of the graph runs along. */
function curveOf(w: WorldDescription, graph: RoadGraph, edge: number): RoadCurve {
  return w.roads[(graph.edges[edge] as RoadEdge).curve] as RoadCurve;
}

/** Faults in the shape of one curve: its id, its points, its decks and the nodes at its ends. */
function curveFaults(road: RoadCurve, i: number, faults: Faults): void {
  if (road.id !== i) faults.add(`curve ${i} carries id ${road.id}`);
  if (road.points.length < 2) faults.add(`curve ${i} has ${road.points.length} points`);
  for (const at of road.bridges) {
    if (at >= road.points.length - 1) faults.add(`curve ${i} bridges segment ${at}, past its end`);
  }
  if (road.nodes.length !== road.points.length) faults.add(`curve ${i} has ${road.nodes.length} nodes for ${road.points.length} points`);
  if ((road.nodes[0] ?? -1) < 0 || (road.nodes[road.nodes.length - 1] ?? -1) < 0) faults.add(`curve ${i} has an end that is no node`);
}

/** A node is one place: every point that stands on it stands there. */
function nodePlaceFaults(roads: readonly RoadCurve[], faults: Faults): void {
  for (const [node, here] of nodePoints(roads)) {
    const first = here[0]?.road.points[here[0].at] as Point;
    for (const { road, at } of here) {
      const p = road.points[at] as Point;
      if (p.x !== first.x || p.y !== first.y) faults.add(`node ${node} stands at two places, on ${road.tier} ${road.id}`);
    }
  }
}

/** How many networks the curves make, joining two curves that share a node. */
function networkCount(roads: readonly RoadCurve[]): number {
  const parent = roads.map((_, i) => i);
  const rootOf = (i: number): number => {
    const up = parent[i] as number;
    if (up !== i) parent[i] = rootOf(up);
    return parent[i] as number;
  };
  const owner = new Map<number, number>();
  for (let i = 0; i < roads.length; i++) {
    for (const node of (roads[i] as RoadCurve).nodes) {
      if (node < 0) continue;
      const met = owner.get(node);
      if (met === undefined) owner.set(node, i);
      else parent[rootOf(met)] = rootOf(i);
    }
  }
  return new Set(roads.map((_, i) => rootOf(i))).size;
}

/** How many nodes of the graph a walk from node 0 reaches. */
function reachedFromFirst(graph: RoadGraph): number {
  const seen = new Uint8Array(graph.nodes.length);
  const queue = [0];
  seen[0] = 1;
  for (let i = 0; i < queue.length; i++) {
    for (const e of graph.edgesFrom(queue[i] as number)) {
      const to = (graph.edges[e] as RoadEdge).to;
      if (seen[to] === 1) continue;
      seen[to] = 1;
      queue.push(to);
    }
  }
  return queue.length;
}

/** The node furthest from a place; the first of them on a tie. */
function furthestNode(graph: RoadGraph, from: Point): number {
  let far = 0;
  let farD = -1;
  for (const node of graph.nodes) {
    const d = Math.hypot(node.x - from.x, node.y - from.y);
    if (d <= farD) continue;
    farD = d;
    far = node.id;
  }
  return far;
}

/** Faults where a route's edges do not run from one of its nodes to the next. */
function routeFaults(graph: RoadGraph, taken: RoadRoute, faults: Faults): void {
  for (let i = 0; i < taken.edges.length; i++) {
    const edge = graph.edges[taken.edges[i] as number] as RoadEdge;
    if (edge.from !== taken.nodes[i] || edge.to !== taken.nodes[i + 1]) faults.add(`route breaks at edge ${edge.id}`);
  }
}

/** Faults in the interchanges a highway lists: none, out of order, or past its end. */
function interchangeListFaults(road: RoadCurve, faults: Faults): void {
  if (road.interchanges.length === 0) faults.add(`highway ${road.id} has no interchange`);
  for (let k = 1; k < road.interchanges.length; k++) {
    if ((road.interchanges[k] as number) <= (road.interchanges[k - 1] as number)) faults.add(`highway ${road.id} lists its interchanges out of order`);
  }
  for (const at of road.interchanges) {
    if (at < 0 || at >= road.points.length) faults.add(`highway ${road.id} puts an interchange past its end at ${at}`);
  }
}

/** Faults where another road meets a highway at a point it may not. */
function meetingFaults(road: RoadCurve, met: Map<number, NodePoint[]>, faults: Faults): void {
  for (let i = 0; i < road.points.length; i++) {
    const here = met.get(road.nodes[i] ?? -1) ?? [];
    for (const other of here) {
      if (other.road.id !== road.id) faults.add(highwayMeetingFault(road, i, other, here));
    }
  }
}

/** True where an island link, which carries a deck, ends on an interchange of a highway. */
function linkEnd(link: RoadCurve, at: number, highway: RoadCurve, i: number): boolean {
  return link.bridges.length > 0 && (at === 0 || at === link.points.length - 1) && highway.interchanges.includes(i);
}

/** What is wrong where another road meets point `i` of a highway, or undefined. */
function highwayMeetingFault(road: RoadCurve, i: number, other: NodePoint, here: readonly NodePoint[]): string | undefined {
  const where = `highway ${road.id} meets ${other.road.tier} ${other.road.id} at point ${i}`;
  if (other.road.tier === 'highway') return road.interchanges.includes(i) ? undefined : `${where}, away from any interchange`;
  if (other.road.tier === 'ramp') return other.road.ramp?.highway === road.id ? undefined : `${where}, a ramp of another highway`;
  if (other.road.tier !== 'arterial') return where;
  const end = i === 0 || i === road.points.length - 1;
  if (end || linkEnd(other.road, other.at, road, i)) return undefined;
  // Another arterial may end on the junction a link made there.
  const otherEnd = other.at === 0 || other.at === other.road.points.length - 1;
  if (here.some((o) => linkEnd(o.road, o.at, road, i)) && otherEnd) return undefined;
  return `${where}, at grade`;
}

/** Faults where a road that is no highway lists slots, or a slot is off a level deck. */
function slotFaults(road: RoadCurve, faults: Faults): void {
  const slots = road.slots ?? [];
  if (road.tier !== 'highway' && slots.length > 0) faults.add(`${road.tier} ${road.id} lists slots`);
  for (const at of slots) {
    const level = (road.lift?.[at] ?? 0) >= OVERPASS_CLEARANCE - 1e-6 && (road.lift?.[at + 1] ?? 0) >= OVERPASS_CLEARANCE - 1e-6;
    if (!road.bridges.includes(at) || !level) faults.add(`highway ${road.id} has slot ${at} off its level deck`);
  }
}

/** What is wrong with a crossing of a highway, or undefined: it is at a slot or a whole diamond. */
function highwayCrossingFault(w: WorldDescription, graph: RoadGraph, crossing: GradeCrossing): string | undefined {
  const pair = [crossing.over, crossing.under].map((e) => curveOf(w, graph, e));
  if (!pair.some((road) => road.tier === 'highway')) return undefined;
  const where = `${(pair[0] as RoadCurve).tier} ${(pair[0] as RoadCurve).id} crosses ${(pair[1] as RoadCurve).tier} ${(pair[1] as RoadCurve).id} at ${crossing.x.toFixed(0)},${crossing.y.toFixed(0)}`;
  const above = pair.find((road) => (road.slots ?? []).includes(placeOn(road, crossing)?.segment ?? -1));
  if (above === undefined) {
    const [over, under] = pair as [RoadCurve, RoadCurve];
    const diamond = over.tier === 'arterial' && under.tier === 'highway' && w.roads.some((r) => r.ramp?.arterial === over.id);
    if (!diamond) return `${where}, at no slot`;
    return liftAtCrossing(under, crossing) > 0 ? `${where}, over a highway off the ground` : undefined;
  }
  // The road underneath stays on the ground, or it would climb into the deck.
  const below = pair[0] === above ? (pair[1] as RoadCurve) : (pair[0] as RoadCurve);
  return liftAtCrossing(below, crossing) > 0 ? `${where}, and climbs into the deck` : undefined;
}

/** How far the end at point `i` of a road stands from any other road, in words, if it is further than `cap`. */
function deadEndFault(road: RoadCurve, i: number, cap: number, on: Map<number, NodePoint[]>, grid: PointGrid): string | undefined {
  // Only a free end, one that met no other road, is a dead end.
  if (nodeVisits(on, road, i) > 1) return undefined;
  const end = road.points[i] as Point;
  const away = grid.nearest(end.x, end.y, road.id);
  return away > cap ? `${road.tier} ${road.id} dead-ends ${away.toFixed(0)} m from any road` : undefined;
}

/** Faults where a road runs through water, or a deck over water spans no crossing. */
function waterFaults(w: WorldDescription, hf: Heightfield, rivers: RiverWater, road: RoadCurve, faults: Faults): void {
  const sea = w.water.seaLevel;
  for (let i = 0; i + 1 < road.points.length; i++) {
    const a = road.points[i] as Point;
    const b = road.points[i + 1] as Point;
    const where = `${road.tier} ${road.id} segment ${i}`;
    if (!road.bridges.includes(i)) {
      if (lowestAlong(hf, a, b) < sea) faults.add(`${where} runs through water`);
      continue;
    }
    // A deck lands on dry ground at both ends. One over water spans a
    // strait crossing or a river; one over land carries the road over
    // a dip, and the grade test is what vets that one.
    if (hf.sample(a.x, a.y) < sea) faults.add(`${where} starts in the water`);
    if (hf.sample(b.x, b.y) < sea) faults.add(`${where} ends in the water`);
    if (wetFraction(hf, a, b, sea) > 0) {
      const spans = w.water.crossings.some((c) => spansCrossing(a, b, c.from, c.to)) || rivers.spans(a, b);
      if (!spans) faults.add(`${where} is a bridge at no crossing`);
    }
  }
}

/** The lowest ground along a segment, sampled every {@link WET_SAMPLE} metres. */
function lowestAlong(hf: Heightfield, a: Point, b: Point): number {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / WET_SAMPLE));
  let lowest = Infinity;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    lowest = Math.min(lowest, hf.sample(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
  }
  return lowest;
}

/** A run of deck segments along a curve, first to last. */
type DeckRun = ReturnType<typeof deckRuns>[number];

/** The lowest surface a run of decks is driven on, over all its points. */
function lowestSurface(beds: ReturnType<typeof bedsOf>, road: RoadCurve, run: DeckRun): number {
  let surface = Infinity;
  for (let i = run.from; i <= run.to + 1; i++) surface = Math.min(surface, beds.pointHeight(road.id, i));
  return surface;
}

/**
 * True where a run of decks has an abutment no ramp may be laid back from: the
 * end of the line, a bore, an interchange, or a junction the network already
 * had there when the deck was laid. A deck held by none of them had the room,
 * so it stands clear of the water.
 */
function deckPinned(road: RoadCurve, run: DeckRun): boolean {
  return (
    run.from === 0 ||
    run.to + 1 === road.points.length - 1 ||
    road.tunnels.includes(run.from - 1) ||
    road.tunnels.includes(run.to + 1) ||
    [run.from, run.to + 1].some((i) => (road.nodes[i] ?? -1) >= 0 || road.interchanges.includes(i))
  );
}

/** Faults where a bore runs past the end of its curve, or is a deck too. */
function boreFaults(road: RoadCurve, faults: Faults): void {
  for (const at of road.tunnels) {
    if (at >= road.points.length - 1) faults.add(`${road.tier} ${road.id} bores past its end at ${at}`);
    if (road.bridges.includes(at)) faults.add(`${road.tier} ${road.id} segment ${at} is deck and bore at once`);
  }
}

/** What is wrong with segment `i` of a road against the ground under it, or undefined. */
function segmentGradeFault(w: WorldDescription, hf: Heightfield, road: RoadCurve, i: number): string | undefined {
  const a = road.points[i] as Point;
  const b = road.points[i + 1] as Point;
  const where = `${road.tier} ${road.id} segment ${i}`;
  if (road.tunnels.includes(i)) {
    return profileUnder(hf, a, b).above <= CLEARANCE ? `${where} is a bore through nothing` : undefined;
  }
  if (road.bridges.includes(i)) {
    // A deck over dry land is only worth building over a dip, or to carry the
    // road over another one (`overpass.ts`), which is what the lift says it does.
    const dry = wetFraction(hf, a, b, w.water.seaLevel) === 0;
    const carried = (road.lift?.[i] ?? 0) > 0 || (road.lift?.[i + 1] ?? 0) > 0;
    return dry && !carried && profileUnder(hf, a, b).below <= CLEARANCE ? `${where} is a deck over nothing` : undefined;
  }
  const limit = TIERS[road.tier].maxGrade;
  const grade = gradeOf(hf, a, b);
  return grade > limit ? `${where} climbs ${(grade * 100).toFixed(0)}%, over the ${(limit * 100).toFixed(0)}% of its tier` : undefined;
}

import { expect, it } from 'vitest';
import { layoutZones, zoneAt } from '../src/world/districts.ts';
import { MINOR_BY_ZONE } from '../src/world/fill.ts';
import { type GradeCrossing, type RoadEdge, type RoadNode } from '../src/world/graph.ts';
import { CLEARANCE as OVERPASS_CLEARANCE } from '../src/world/overpass.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { LandMasses } from '../src/world/landmass.ts';
import { coastNoise, islandAt } from '../src/world/terrain.ts';
import { mayCross, TIERS } from '../src/world/tiers.ts';
import { type District, type Point, type RoadCurve, type RoadTier, type WorldDescription, type Zone } from '../src/world/types.ts';
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
  standAt,
} from './seed-probes.ts';
import { seeds, worlds, graphOf } from './seed-fixture.ts';
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

      // Curves that share a node are one road network. Every curve is traced
      // from a road already laid or into one, so there is only ever one.
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      const parent = w.roads.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] as number)));
      const owner = new Map<number, number>();
      for (let i = 0; i < w.roads.length; i++) {
        const road = w.roads[i] as RoadCurve;
        if (road.id !== i) fault(`curve ${i} carries id ${road.id}`);
        if (road.points.length < 2) fault(`curve ${i} has ${road.points.length} points`);
        for (const at of road.bridges) {
          if (at >= road.points.length - 1) fault(`curve ${i} bridges segment ${at}, past its end`);
        }
        if (road.nodes.length !== road.points.length) fault(`curve ${i} has ${road.nodes.length} nodes for ${road.points.length} points`);
        if ((road.nodes[0] ?? -1) < 0 || (road.nodes[road.nodes.length - 1] ?? -1) < 0) fault(`curve ${i} has an end that is no node`);
        for (const node of road.nodes) {
          if (node < 0) continue;
          const met = owner.get(node);
          if (met === undefined) owner.set(node, i);
          else parent[find(met)] = find(i);
        }
      }
      // A node is one place: every point that stands on it stands there.
      for (const [node, here] of nodePoints(w.roads)) {
        const first = here[0]?.road.points[here[0].at] as Point;
        for (const { road, at } of here) {
          const p = road.points[at] as Point;
          if (p.x !== first.x || p.y !== first.y) fault(`node ${node} stands at two places, on ${road.tier} ${road.id}`);
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
      const roots = new Set(w.roads.map((_, i) => find(i)));
      expect(roots.size, `seed ${seed}: ${roots.size} road networks`).toBe(1);
    }
  });

  it('builds one road graph that holds the whole curve network', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const graph = graphOf(seed);
      expect(graph.nodes.length, `seed ${seed}`).toBeGreaterThan(0);

      // Every curve is on the graph, and every node has a road leaving it.
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      const covered = new Uint8Array(w.roads.length);
      for (const edge of graph.edges) covered[edge.curve] = 1;
      for (const road of w.roads) if (covered[road.id] !== 1) fault(`curve ${road.id} has no edge`);
      for (const node of graph.nodes) if (graph.degree(node.id) <= 0) fault(`node ${node.id} has no road leaving it`);
      expect(complaint, `seed ${seed}`).toBeUndefined();

      // The curves are one network, so the graph is one component too.
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
      expect(queue.length, `seed ${seed}: the graph is not one network`).toBe(graph.nodes.length);

      // Pathfinding crosses that network: the core to the node furthest from it.
      const start = graph.nearestNode(w.core.x, w.core.y) as number;
      let far = 0;
      let farD = -1;
      for (const node of graph.nodes) {
        const d = Math.hypot(node.x - w.core.x, node.y - w.core.y);
        if (d <= farD) continue;
        farD = d;
        far = node.id;
      }
      const route = graph.shortestPath(start, far);
      expect(route, `seed ${seed}: no route from the core to node ${far}`).toBeDefined();
      const taken = route as NonNullable<typeof route>;
      expect(taken.nodes[0]).toBe(start);
      expect(taken.nodes[taken.nodes.length - 1]).toBe(far);
      // A drive is never shorter than the straight line it covers.
      const head = graph.nodes[start] as RoadNode;
      const tail = graph.nodes[far] as RoadNode;
      expect(taken.length, `seed ${seed}`).toBeGreaterThanOrEqual(Math.hypot(head.x - tail.x, head.y - tail.y) - 1e-6);
      for (let i = 0; i < taken.edges.length; i++) {
        const edge = graph.edges[taken.edges[i] as number] as RoadEdge;
        if (edge.from !== taken.nodes[i] || edge.to !== taken.nodes[i + 1]) fault(`route breaks at edge ${edge.id}`);
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();

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
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      for (let k = 0; k < graph.crossings.length; k++) {
        const crossing = graph.crossings[k] as GradeCrossing;
        const where = `crossing ${k} at ${crossing.x.toFixed(0)},${crossing.y.toFixed(0)}`;
        const node = graph.nodes[graph.nearestNode(crossing.x, crossing.y) as number] as RoadNode;
        if (Math.hypot(node.x - crossing.x, node.y - crossing.y) <= 0.001) fault(`${where} is a junction`);
        const over = graph.edges[crossing.over] as RoadEdge;
        const under = graph.edges[crossing.under] as RoadEdge;
        if (over.curve === under.curve) fault(`${where} joins a road to itself`);
        if (!over.crossings.includes(k)) fault(`${where} is not marked on the road above`);
        if (!under.crossings.includes(k)) fault(`${where} is not marked on the road below`);
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('leaves no crossing flat: two roads that cross meet, or one stands a clearance over the other', () => {
    // Spec section 6.2: a crossing is decided when its second road is added,
    // never afterwards. The two roads take a junction there, which is a node
    // and no crossing at all, or one is carried over the other: a lift of the
    // clearance over a road on the ground, or a deck or a bore whose bed
    // stands a clearance off the other road's. Where none of those holds the
    // road is shortened or refused, so no refusal leaves a crossing flat.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const graph = graphOf(seed);
      const hf = new Heightfield(w.terrain);
      let complaint: string | undefined;
      for (const crossing of graph.crossings) {
        const over = w.roads[(graph.edges[crossing.over] as RoadEdge).curve] as RoadCurve;
        const under = w.roads[(graph.edges[crossing.under] as RoadEdge).curve] as RoadCurve;
        const one = standAt(hf, over, crossing);
        const other = standAt(hf, under, crossing);
        if (one === undefined || other === undefined) {
          complaint ??= `crossing at ${crossing.x.toFixed(0)},${crossing.y.toFixed(0)} stands on neither road`;
          continue;
        }
        const lifted = (one.lift >= OVERPASS_CLEARANCE - 1e-6 && other.ground) || (other.lift >= OVERPASS_CLEARANCE - 1e-6 && one.ground);
        const structure = !(one.ground && other.ground) && Math.abs(one.bed - other.bed) >= OVERPASS_CLEARANCE;
        if (lifted || structure) continue;
        complaint ??= `${over.tier} ${over.id} crosses ${under.tier} ${under.id} flat at ${crossing.x.toFixed(0)},${crossing.y.toFixed(0)}`;
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('junctions a highway only at an interchange, and never with a minor road', () => {
    // Spec section 6.2: a highway has junctions only at interchanges and no
    // pedestrians on it. So a street, an alley or a dirt road never shares a
    // point with one — where they cross, the graph makes it an overpass — and a
    // highway or an arterial ramp meets one only at a point it lists.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      // Every curve point on each node, with the index the point sits at.
      const met = nodePoints(w.roads);
      for (const road of w.roads) {
        if (road.tier !== 'highway') {
          if (road.interchanges.length > 0) fault(`${road.tier} ${road.id} lists interchanges`);
          continue;
        }
        if (road.interchanges.length === 0) fault(`highway ${road.id} has no interchange`);
        for (let k = 1; k < road.interchanges.length; k++) {
          if ((road.interchanges[k] as number) <= (road.interchanges[k - 1] as number)) fault(`highway ${road.id} lists its interchanges out of order`);
        }
        for (const at of road.interchanges) {
          if (at < 0 || at >= road.points.length) fault(`highway ${road.id} puts an interchange past its end at ${at}`);
        }
        for (let i = 0; i < road.points.length; i++) {
          const here = met.get(road.nodes[i] ?? -1) ?? [];
          for (const other of here) {
            if (other.road.id === road.id) continue;
            const where = `highway ${road.id} meets ${other.road.tier} ${other.road.id} at point ${i}`;
            if (other.road.tier !== 'highway' && other.road.tier !== 'arterial') fault(where);
            else if (!road.interchanges.includes(i)) fault(`${where}, away from any interchange`);
          }
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('crosses a highway only under the level deck of one of its slots', () => {
    // Spec section 6.2: a highway is planned with its decks when it is laid,
    // and a road laid later passes under a slot or joins the highway at an
    // interchange. Every other crossing is refused while the road is traced,
    // so none is left for `overpass.ts` to raise between two junctions.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const graph = graphOf(seed);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      for (const road of w.roads) {
        const slots = road.slots ?? [];
        if (road.tier !== 'highway' && slots.length > 0) fault(`${road.tier} ${road.id} lists slots`);
        for (const at of slots) {
          const level = (road.lift?.[at] ?? 0) >= OVERPASS_CLEARANCE - 1e-6 && (road.lift?.[at + 1] ?? 0) >= OVERPASS_CLEARANCE - 1e-6;
          if (!road.bridges.includes(at) || !level) fault(`highway ${road.id} has slot ${at} off its level deck`);
        }
      }
      for (const crossing of graph.crossings) {
        const pair = [crossing.over, crossing.under].map((e) => w.roads[(graph.edges[e] as RoadEdge).curve] as RoadCurve);
        if (!pair.some((road) => road.tier === 'highway')) continue;
        const where = `${(pair[0] as RoadCurve).tier} ${(pair[0] as RoadCurve).id} crosses ${(pair[1] as RoadCurve).tier} ${(pair[1] as RoadCurve).id} at ${crossing.x.toFixed(0)},${crossing.y.toFixed(0)}`;
        const above = pair.find((road) => (road.slots ?? []).includes(placeOn(road, crossing)?.segment ?? -1));
        if (above === undefined) {
          fault(`${where}, at no slot`);
          continue;
        }
        // The road underneath stays on the ground, or it would climb into the deck.
        const below = pair[0] === above ? (pair[1] as RoadCurve) : (pair[0] as RoadCurve);
        if (liftAtCrossing(below, crossing) > 0) fault(`${where}, and climbs into the deck`);
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
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
      let highwayKm = 0;
      for (const road of w.roads) {
        if (road.tier !== 'highway') continue;
        highwayKm += polylineLength(road.points) / 1000;
      }
      let separations = 0;
      for (const crossing of graph.crossings) {
        const pair = [crossing.over, crossing.under].map((e) => w.roads[(graph.edges[e] as RoadEdge).curve] as RoadCurve);
        const [over, under] = pair as [RoadCurve, RoadCurve];
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
    // the district sites, so the two are not the same ground.
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
      const zones = layoutZones(w.size, w.core, w.water);
      const grid = new PointGrid(w.size, 40, w.roads);
      const land = new LandMasses(hf, w.water, w.water.seaLevel + 1);
      const mainland = land.massAt(w.core.x, w.core.y);
      const climbable: Partial<Record<RoadTier, Uint8Array>> = {
        street: climbableFrom(hf, w, 'street'),
        dirt: climbableFrom(hf, w, 'dirt'),
      };
      // Every sample of a zone, and the ones on the ground its fill was asked
      // to cover. Ground the fill was never asked to cover only ever puts the
      // median up, so the floor reads all of it and the ceiling the rest.
      const samples: Partial<Record<Zone, number[]>> = {};
      const filled: Partial<Record<Zone, number[]>> = {};
      for (let iy = 0; iy < hf.gridSize; iy += 8) {
        for (let ix = 0; ix < hf.gridSize; ix += 8) {
          const x = hf.worldX(ix);
          const y = hf.worldY(iy);
          // Dry ground only, and not the strip along the edge that roads keep off.
          if (hf.at(ix, iy) < w.water.seaLevel + 1) continue;
          if (Math.abs(x) > w.size / 2 - 120 || Math.abs(y) > w.size / 2 - 120) continue;
          if (land.massAt(x, y) !== mainland) continue;
          const zone = zoneAt(zones, x, y);
          const half = grid.nearest(x, y);
          (samples[zone] ??= []).push(half);
          const reach = climbable[MINOR_BY_ZONE[zone].tier] as Uint8Array;
          if (reach[iy * hf.gridSize + ix] !== 1) continue;
          if (!nearADistrict(w, zone, x, y, (d) => onClimbable(hf, reach, d.x, d.y))) continue;
          (filled[zone] ??= []).push(half);
        }
      }
      for (const zone of Object.keys(RANGE) as Zone[]) {
        const found = samples[zone] ?? [];
        const covered = filled[zone] ?? [];
        const [lo, hi] = RANGE[zone];
        // A zone can be a sliver on one seed; too few samples say nothing.
        if (found.length >= 20) expect(median(found), `seed ${seed}: ${zone} blocks`).toBeGreaterThanOrEqual(lo);
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
      let complaint: string | undefined;
      for (const road of w.roads) {
        const cap = CAP[road.tier];
        if (cap === undefined || boardwalks.has(road.id)) continue;
        for (const i of [0, road.points.length - 1]) {
          const end = road.points[i] as Point;
          if (nodeVisits(on, road, i) > 1) continue;
          const away = grid.nearest(end.x, end.y, road.id);
          if (away > cap) complaint ??= `${road.tier} ${road.id} dead-ends ${away.toFixed(0)} m from any road`;
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
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

  it('keeps roads out of the water except on a bridge over a strait crossing', () => {
    // As in the grade test below: one assertion a seed, so a hundred thousand
    // segments do not each pay for one.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      for (const road of w.roads) {
        for (let i = 0; i + 1 < road.points.length; i++) {
          const a = road.points[i] as Point;
          const b = road.points[i + 1] as Point;
          const where = `${road.tier} ${road.id} segment ${i}`;
          if (road.bridges.includes(i)) {
            // A deck lands on dry ground at both ends. One over water spans a
            // strait crossing; one over land carries the road over a dip, and
            // the grade test below is what vets that one.
            if (hf.sample(a.x, a.y) < w.water.seaLevel) fault(`${where} starts in the water`);
            if (hf.sample(b.x, b.y) < w.water.seaLevel) fault(`${where} ends in the water`);
            if (wetFraction(hf, a, b, w.water.seaLevel) > 0) {
              const spans = w.water.crossings.some((c) => spansCrossing(a, b, c.from, c.to));
              if (!spans) fault(`${where} is a bridge at no crossing`);
            }
            continue;
          }
          const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / WET_SAMPLE));
          let lowest = Infinity;
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            lowest = Math.min(lowest, hf.sample(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
          }
          if (lowest < w.water.seaLevel) fault(`${where} runs through water`);
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
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
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      for (const road of w.roads) {
        const limit = TIERS[road.tier].maxGrade;
        for (const at of road.tunnels) {
          if (at >= road.points.length - 1) fault(`${road.tier} ${road.id} bores past its end at ${at}`);
          if (road.bridges.includes(at)) fault(`${road.tier} ${road.id} segment ${at} is deck and bore at once`);
        }
        for (let i = 0; i + 1 < road.points.length; i++) {
          const a = road.points[i] as Point;
          const b = road.points[i + 1] as Point;
          const where = `${road.tier} ${road.id} segment ${i}`;
          if (road.tunnels.includes(i)) {
            if (profileUnder(hf, a, b).above <= CLEARANCE) fault(`${where} is a bore through nothing`);
            continue;
          }
          if (road.bridges.includes(i)) {
            // A deck over dry land is only worth building over a dip, or to
            // carry the road over another one (`overpass.ts`), which is what
            // the lift says it does.
            const dry = wetFraction(hf, a, b, w.water.seaLevel) === 0;
            const carried = (road.lift?.[i] ?? 0) > 0 || (road.lift?.[i + 1] ?? 0) > 0;
            if (dry && !carried && profileUnder(hf, a, b).below <= CLEARANCE) {
              fault(`${where} is a deck over nothing`);
            }
            continue;
          }
          const grade = gradeOf(hf, a, b);
          if (grade > limit) fault(`${where} climbs ${(grade * 100).toFixed(0)}%, over the ${(limit * 100).toFixed(0)}% of its tier`);
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });
});

/**
 * How far from a district site of its own zone the ground still belongs to that
 * district's fill, as a multiple of the zone's widest `along` spacing. The
 * minor fill is seeded at the district sites and grows outward, so ground
 * further out than this is ground the fill was never asked to cover.
 */
const CATCHMENT = 2;

/**
 * True where a district of a zone stands within the zone's catchment of a
 * place, on ground a road can climb to. A site on a knoll no road reaches
 * (issue #399) seeds no fill, so the ground around it is nobody's blocks.
 */
function nearADistrict(w: WorldDescription, zone: Zone, x: number, y: number, served: (d: District) => boolean): boolean {
  const reach = CATCHMENT * (MINOR_BY_ZONE[zone].along[1] as number);
  return w.districts.some((d) => d.zone === zone && Math.hypot(d.x - x, d.y - y) <= reach && served(d));
}

/** True where a place stands on ground of a climbable flag grid. */
function onClimbable(hf: Heightfield, reach: Uint8Array, x: number, y: number): boolean {
  const ix = Math.round((x - hf.originX) / hf.cellSize);
  const iy = Math.round((y - hf.originY) / hf.cellSize);
  if (ix < 0 || iy < 0 || ix >= hf.gridSize || iy >= hf.gridSize) return false;
  return reach[iy * hf.gridSize + ix] === 1;
}

/**
 * The ground a road of a tier could be laid on: every terrain node joined to
 * the core by steps over dry land no steeper than the tier climbs. Ground
 * outside it — a knoll, a ledge, a shelf behind a cliff — carries no road
 * whatever the fill does, so it says nothing about how the fill spaces them.
 */
function climbableFrom(hf: Heightfield, w: WorldDescription, tier: RoadTier): Uint8Array {
  const n = hf.gridSize;
  const rise = TIERS[tier].maxGrade * hf.cellSize;
  const dry = w.water.seaLevel + 1;
  const reached = new Uint8Array(n * n);
  const queue = new Int32Array(n * n);
  const cx = Math.round((w.core.x - hf.originX) / hf.cellSize);
  const cy = Math.round((w.core.y - hf.originY) / hf.cellSize);
  let tail = 0;
  if (cx >= 0 && cy >= 0 && cx < n && cy < n) {
    reached[cy * n + cx] = 1;
    queue[tail++] = cy * n + cx;
  }
  for (let head = 0; head < tail; head++) {
    const at = queue[head] as number;
    const ix = at % n;
    const iy = (at - ix) / n;
    const h = hf.at(ix, iy);
    for (let k = 0; k < 4; k++) {
      const jx = ix + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const jy = iy + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (jx < 0 || jy < 0 || jx >= n || jy >= n) continue;
      const to = jy * n + jx;
      const g = hf.at(jx, jy);
      if (reached[to] === 1 || g < dry || Math.abs(g - h) > rise) continue;
      reached[to] = 1;
      queue[tail++] = to;
    }
  }
  return reached;
}

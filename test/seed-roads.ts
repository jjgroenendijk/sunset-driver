import { describe, expect, it } from 'vitest';
import { FreeEnds, shallow } from '../src/world/connect.ts';
import { groundRule } from '../src/world/roads.ts';
import { layoutZones, zoneAt } from '../src/world/districts.ts';
import { type GradeCrossing, type RoadEdge, type RoadNode } from '../src/world/graph.ts';
import { CLEARANCE as OVERPASS_CLEARANCE } from '../src/world/overpass.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { LandMasses } from '../src/world/landmass.ts';
import { coastNoise, islandAt } from '../src/world/terrain.ts';
import { mayJoin, TIERS } from '../src/world/tiers.ts';
import { type Point, type RoadCurve, type RoadTier, type WorldDescription, type Zone } from '../src/world/types.ts';
import { PointGrid } from './seed-index.ts';
import {
  WET_SAMPLE,
  nodePoints,
  nodeVisits,
  pointsAt,
  type Spot,
  CLEARANCE,
  gradeOf,
  profileUnder,
  wetFraction,
  segmentUnder,
  nearestPointOf,
  nearer,
  refusedPlace,
  sharedNear,
  spansCrossing,
  median,
  sharedDistances,
  liftAtCrossing,
  canRaise,
  placeOn,
  withUnderDecks,
} from './seed-probes.ts';
import { seeds, worlds, graphOf } from './seed-fixture.ts';

/**
 * The seed sweep of spec section 3, on the road network of spec section 6: one
 * component, one graph, and the rules two roads meet under.
 *
 * `seed-sweep.test.ts` declares these inside the one suite that generates the
 * worlds; a file of its own would generate them all again.
 */
export function roadChecks(): void {
  describe('roads', () => {
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

    it('meets any road it crosses on the ground, unless the junction is refused', () => {
      // Spec section 6.2: two roads that cross on the ground meet there. The
      // tracer only ever ends a road on a point of another one, so `connect.ts`
      // gives both curves a point at every crossing the tiers allow a junction
      // at. What is left is a crossing beside the junction it was given, or one
      // the ground refuses: a junction cuts a segment in two, and the halves can
      // climb harder than the whole did.
      for (const seed of seeds) {
        const w = worlds.get(seed) as WorldDescription;
        const graph = graphOf(seed);
        const ground = groundRule(new Heightfield(w.terrain), w.water.seaLevel);
        const byId: RoadCurve[] = [];
        for (const road of w.roads) byId[road.id] = road;
        const on = nodePoints(w.roads);
        // The points the curves other than one run on to from a spot, read off
        // the node it stands on.
        const othersAt = (place: Spot, curve: number): Point[] =>
          pointsAt(on, place)
            .filter(({ road }) => road.id !== curve)
            .flatMap(({ road, at }) => [road.points[at - 1], road.points[at + 1]].filter((p): p is Point => p !== undefined));
        // A point that turns a road onto the line of a third road meeting it
        // there, or at the places beside it, is refused as `connect.ts` does.
        const bends = (curve: number, spot: Spot, around: readonly Spot[]): boolean =>
          shallow(spot, around, othersAt(spot, curve)) || around.some((place) => shallow(place, [spot], othersAt(place, curve)));
        const ends = new FreeEnds(w.roads);
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };

        for (const crossing of graph.crossings) {
          const at = { x: crossing.x, y: crossing.y };
          const over = byId[(graph.edges[crossing.over] as RoadEdge).curve] as RoadCurve;
          const under = byId[(graph.edges[crossing.under] as RoadEdge).curve] as RoadCurve;
          if (!mayJoin(over.tier, under.tier, false) || !mayJoin(under.tier, over.tier, false)) continue;
          const first = segmentUnder(over, at);
          const second = segmentUnder(under, at);
          if (first === undefined || second === undefined) continue;
          // A deck and a bore are not on the ground, so crossing one is no meeting.
          if (over.bridges.includes(first) || over.tunnels.includes(first)) continue;
          if (under.bridges.includes(second) || under.tunnels.includes(second)) continue;

          const where = `${over.tier} ${over.id} crosses ${under.tier} ${under.id} at ${at.x.toFixed(0)},${at.y.toFixed(0)}`;
          if (sharedNear(over, under, at) !== undefined) continue;
          // Each place a junction would have taken is refused: by the road
          // standing there, by a half it cuts a road into that is more than the
          // ground allows, or by an angle no junction can be built at. The
          // place `connect.ts` would put the junction at first: the nearest
          // point either road already has within a snap of the crossing.
          // Where that place fails, the crossing itself is tried.
          const snapped = nearer(nearestPointOf(over, at), nearestPointOf(under, at), at);
          const refusedAt = (spot: Spot): boolean => {
            // A place a road of either tier may not take a point at is no place
            // for a junction: bending a street onto a point of a highway would
            // meet the highway, which spec section 6.2 refuses.
            if (refusedPlace(on, spot, over.tier) || refusedPlace(on, spot, under.tier)) return true;
            const halves = [
              [over, first],
              [under, second],
            ] as const;
            const around: Spot[][] = [];
            const spotOf = (road: RoadCurve, at: number): Spot | undefined => {
              const p = road.points[at];
              return p === undefined ? undefined : { x: p.x, y: p.y, road, at };
            };
            for (const [road, segment] of halves) {
              const a = spotOf(road, segment) as Spot;
              const b = spotOf(road, segment + 1) as Spot;
              // A place the road already stands on bends it nowhere new; there
              // it leaves along the points either side, as `connect.ts` measures.
              const i = spot.road === road ? (spot.at as number) : -1;
              if (i >= 0) {
                around.push([spotOf(road, i - 1), spotOf(road, i + 1)].filter((p): p is Spot => p !== undefined));
                continue;
              }
              if (!ground(a, spot, road.tier) || !ground(spot, b, road.tier)) return true;
              // Nor a place that bends the road over the free end of a third one.
              if (ends.buried(road, spot, [a, b])) return true;
              around.push([a, b]);
            }
            // A point that turns the two roads onto each other's line under
            // MIN_MEET is no junction either.
            if (shallow(spot, around[0] as Spot[], around[1] as Spot[])) return true;
            return bends(over.id, spot, around[0] as Spot[]) || bends(under.id, spot, around[1] as Spot[]);
          };
          if (!(snapped === undefined ? [at] : [snapped, at]).every(refusedAt)) fault(`${where} without meeting it`);
        }
        expect(complaint, `seed ${seed}`).toBeUndefined();
      }
    });

    it('carries a road over the one it crosses, or is refused for a reason', () => {
      // Spec section 6.2: an overpass carries a road over a road. `overpass.ts`
      // raises the road the graph calls `over`, or the other one where that road
      // cannot be raised. It is refused where a junction of the road stands
      // inside the ramps, where the road passes under a highway's deck there,
      // where the road is bored or already on a deck there, and where the road
      // runs out before it is down again. Nothing else may leave a crossing
      // flat, so the check mirrors those four and no more.
      for (const seed of seeds) {
        const w = worlds.get(seed) as WorldDescription;
        const graph = graphOf(seed);
        const shared = withUnderDecks(w.roads, graph, sharedDistances(w.roads));
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };
        for (let k = 0; k < graph.crossings.length; k++) {
          const crossing = graph.crossings[k] as GradeCrossing;
          const over = w.roads[(graph.edges[crossing.over] as RoadEdge).curve] as RoadCurve;
          const under = w.roads[(graph.edges[crossing.under] as RoadEdge).curve] as RoadCurve;
          const where = `crossing ${k} at ${crossing.x.toFixed(0)},${crossing.y.toFixed(0)}`;
          const above = liftAtCrossing(over, crossing);
          const below = liftAtCrossing(under, crossing);
          if (Math.max(above, below) >= OVERPASS_CLEARANCE - 0.001) continue;
          // Short of the clearance the roads still meet on the map, so the raise
          // must have been refused. A crossing standing on the ramp of another
          // one is lifted a little; that is a refusal too, not a separation.
          if (canRaise(over, under, crossing, shared) || canRaise(under, over, crossing, shared)) {
            fault(`${where} is ${Math.max(above, below).toFixed(1)} m clear, and nothing stops it being carried over`);
          }
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

    it('cuts each zone into blocks of about the size it asks for', () => {
      // Half the width of a block, near enough: the median distance from the
      // ground of a zone to the nearest road. Blocks tighten toward downtown
      // because the fill spaces its roads by the density of the district. The
      // wilderness range is wide because an island no district stands on is
      // reached by no bridge, so its ground is far from every road. Its floor
      // came down when the highways became a ring with radials: a radial and its
      // branch run further into the wilderness than the two trunks did, and one
      // seed in 200 reads 34 m.
      //
      // The three zones on the fringe are looser than the built-up ones because
      // ground too steep for a road now goes without one (spec section 6.1).
      //
      // The suburban, industrial and outskirts ceilings are loose for the same
      // reason. The rings of spec section 8.2 now cover most of the map, so a
      // hilly arm of the mainland that no road enters falls inside them rather
      // than in the wilderness. Over 96 seeds the suburban and industrial
      // medians read 11 m to 29 m and the outskirts 21 m to 76 m; one seed in
      // 200 reads 173 m and 287 m, and that is such an arm. The suburban floor
      // came down for the opposite case: a seed whose mainland is small keeps
      // its suburbs on the dense ground near the core, and one in 200 reads
      // 9.0 m. These are here to catch a fill that has collapsed, not to pin the
      // figure down.
      //
      // Only the land the core stands on is asked. The rings of spec section 8.2
      // are concentric circles on the whole map, so since they were widened they
      // also fall on the outer islands, and an outer island no bridge reaches
      // carries no road at all. Its ground says nothing about how the fill
      // spaces its roads; it would only say that the zone ring reached it.
      const RANGE: Record<Zone, [number, number]> = {
        core: [3, 20],
        inner: [5, 20],
        industrial: [7, 200],
        suburban: [7, 200],
        outskirts: [14, 400],
        wilderness: [30, 800],
      };
      for (const seed of seeds) {
        const w = worlds.get(seed) as WorldDescription;
        const hf = new Heightfield(w.terrain);
        const zones = layoutZones(w.size, w.core, w.water);
        const grid = new PointGrid(w.size, 40, w.roads);
        const land = new LandMasses(hf, w.water, w.water.seaLevel + 1);
        const mainland = land.massAt(w.core.x, w.core.y);
        const samples: Partial<Record<Zone, number[]>> = {};
        for (let iy = 0; iy < hf.gridSize; iy += 8) {
          for (let ix = 0; ix < hf.gridSize; ix += 8) {
            const x = hf.worldX(ix);
            const y = hf.worldY(iy);
            // Dry ground only, and not the strip along the edge that roads keep off.
            if (hf.at(ix, iy) < w.water.seaLevel + 1) continue;
            if (Math.abs(x) > w.size / 2 - 120 || Math.abs(y) > w.size / 2 - 120) continue;
            if (land.massAt(x, y) !== mainland) continue;
            const zone = zoneAt(zones, x, y);
            (samples[zone] ??= []).push(grid.nearest(x, y));
          }
        }
        for (const zone of Object.keys(RANGE) as Zone[]) {
          const found = samples[zone] ?? [];
          // A zone can be a sliver on one seed; too few samples say nothing.
          if (found.length < 20) continue;
          const [lo, hi] = RANGE[zone];
          const half = median(found);
          expect(half, `seed ${seed}: ${zone} blocks`).toBeGreaterThanOrEqual(lo);
          expect(half, `seed ${seed}: ${zone} blocks`).toBeLessThanOrEqual(hi);
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
      // The alley cap is loose for a different reason:
      // an alley stands half a block off the street that seeded it, and it is
      // trimmed to a cul-de-sac at each end that met nothing.
      const CAP: Partial<Record<RoadTier, number>> = { street: 560, alley: 220, dirt: 900 };
      for (const seed of seeds) {
        const w = worlds.get(seed) as WorldDescription;
        const grid = new PointGrid(w.size, 100, w.roads);
        const on = nodePoints(w.roads);
        let complaint: string | undefined;
        for (const road of w.roads) {
          const cap = CAP[road.tier];
          if (cap === undefined) continue;
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
}

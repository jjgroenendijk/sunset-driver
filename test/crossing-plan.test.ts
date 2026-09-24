import { describe, expect, it } from 'vitest';
import { buildRoadGraph } from '../src/world/graph.ts';
import { planHighway } from '../src/world/highway-plan.ts';
import { HEADROOM_SLACK } from '../src/world/crossing-plan.ts';
import { CLEARANCE } from '../src/world/overpass.ts';
import { RoadNetwork, type NetworkGround, type RoadDraft } from '../src/world/road-network.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { Point, RoadCurve, RoadTier } from '../src/world/types.ts';

/**
 * Every crossing is decided when its second road is added (spec section 6.2):
 * a junction, a crossing under a level deck already there, a raise laid into the
 * new road, or a road shortened back from the crossing. These pin each on roads
 * built by hand.
 */

/** A straight road along x at `y`, with a point every 20 m from `fromX` to `toX`. */
function alongX(fromX: number, toX: number, y = 0, tier: RoadTier = 'street'): RoadDraft {
  const points: Point[] = [];
  for (let x = fromX; x <= toX; x += 20) points.push({ x, y });
  return { tier, points, bridges: [], tunnels: [], interchanges: [] };
}

/** A straight road along y at `x`, through the given places. */
function alongY(x: number, ys: readonly number[], tier: RoadTier = 'street'): RoadDraft {
  return { tier, points: ys.map((y) => ({ x, y })), bridges: [], tunnels: [], interchanges: [] };
}

/** From `from` to `to` in steps of 20 m, both included. */
function steps(from: number, to: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to; v += 20) out.push(v);
  return out;
}

/** Level, dry ground that refuses any span shorter than 12 m, so no junction can split a segment near its end. */
const noShortSpans: NetworkGround = { canRun: (a, b) => Math.hypot(b.x - a.x, b.y - a.y) >= 12, heightAt: () => 0 };

const network = (ground?: NetworkGround): RoadNetwork => new RoadNetwork(4000, () => 0, undefined, ground);

/** The lift of a curve at its point nearest a place. */
function liftNear(road: RoadCurve, p: Point): number {
  let best = 0;
  let bestD = Infinity;
  road.points.forEach((q, i) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d >= bestD) return;
    bestD = d;
    best = road.lift?.[i] ?? 0;
  });
  return best;
}

describe('a road that crosses a road already laid', () => {
  it('meets it there: both take a point at the crossing, and the graph makes it one node', () => {
    const roads = network();
    const laid = roads.add(alongX(-100, 100)) as RoadCurve;
    const crossing = roads.add(alongY(10, steps(-95, 105))) as RoadCurve;
    expect(laid.points).toContainEqual({ x: 10, y: 0 });
    expect(crossing.points).toContainEqual({ x: 10, y: 0 });
    const graph = buildRoadGraph(roads.curves);
    expect(graph.crossings).toHaveLength(0);
    expect(graph.degree(graph.nearestNode(10, 0) as number)).toBe(4);
  });

  it('meets it on a point it already has nearby, rather than a junction beside that point', () => {
    const roads = network();
    const laid = roads.add(alongX(-100, 100)) as RoadCurve;
    const crossing = roads.add(alongY(18, steps(-95, 105))) as RoadCurve;
    // The laid road has a point 2 m away, so the new road bends onto it.
    expect(laid.points).toHaveLength(11);
    expect(crossing.points).toContainEqual({ x: 20, y: 0 });
    expect(buildRoadGraph(roads.curves).crossings).toHaveLength(0);
  });

  it('moves the structures and the nodes of the laid road with the point it takes', () => {
    const roads = network();
    const draft = alongX(-100, 100);
    draft.tunnels = [0];
    draft.bridges = [9];
    const laid = roads.add(draft) as RoadCurve;
    const crossing = roads.add(alongY(10, steps(-95, 105))) as RoadCurve;
    expect(laid.points).toHaveLength(12);
    expect(laid.tunnels).toEqual([0]);
    expect(laid.bridges).toEqual([10]);
    expect(laid.nodes[6]).toBe(crossing.nodes[crossing.points.findIndex((p) => p.x === 10 && p.y === 0)]);
    expect(roads.nearest(10, 0, 1, 1)).toMatchObject({ curve: 0, index: 6 });
    expect(roads.nearest(100, 0, 1)).toMatchObject({ curve: 0, index: 11 });
  });

  it('is carried over it where no junction is allowed, and no later road joins it on the raise', () => {
    const roads = network(noShortSpans);
    roads.add(alongX(-100, 100));
    const carried = roads.add(alongY(10, steps(-95, 105))) as RoadCurve;
    expect(liftNear(carried, { x: 10, y: 0 })).toBeCloseTo(CLEARANCE, 6);
    const graph = buildRoadGraph(roads.curves);
    expect(graph.crossings).toHaveLength(1);
    // The raised points stand off the ground, so a street may not end on one.
    expect(roads.nearest(10, 2, 15, 0, 'street')).toBeUndefined();
  });

  it('climbs over the surface of the road below, not over the ground under its own points (issue #290)', () => {
    // The laid road has a point each side of a narrow valley, so its bed runs
    // straight over the valley 6 m above the ground in it. The new road drives
    // along the valley floor, and a lift of the clearance over the ground under
    // its own points would leave the two beds half a metre apart.
    const valley: NetworkGround = { canRun: noShortSpans.canRun, heightAt: (x) => Math.min(0, (Math.abs(x - 10) - 10) * 0.6) };
    const roads = network(valley);
    roads.add(alongX(-100, 100));
    const carried = roads.add(alongY(10, steps(-295, 305))) as RoadCurve;
    expect(liftNear(carried, { x: 10, y: 0 })).toBeCloseTo(CLEARANCE + 6, 6);
    // The ramps are longer for it, and no steeper than the tier allows.
    const lift = carried.lift as number[];
    for (let i = 0; i + 1 < carried.points.length; i++) {
      const run = Math.abs((carried.points[i + 1] as Point).y - (carried.points[i] as Point).y);
      expect(Math.abs((lift[i + 1] as number) - (lift[i] as number)) / run).toBeLessThanOrEqual(TIERS.street.maxGrade + 1e-9);
    }
  });

  it('is shortened back from a crossing it can neither meet nor be carried over', () => {
    const roads = network(noShortSpans);
    roads.add(alongX(-100, 100));
    roads.add(alongX(-90, 110, 100));
    // Too little road below the crossing for a ramp, and no junction allowed:
    // the part that reaches the road at y = 100 is kept, clear of the crossing.
    const cut = roads.add(alongY(10, [-35, -15, 5, 25, 45, 65, 85, 100])) as RoadCurve;
    expect(cut.points[0]).toEqual({ x: 10, y: 25 });
    expect(cut.points[cut.points.length - 1]).toEqual({ x: 10, y: 100 });
    expect(buildRoadGraph(roads.curves).crossings).toHaveLength(0);
  });

  it('is refused rather than shortened where it is asked for whole', () => {
    const roads = network(noShortSpans);
    roads.add(alongX(-100, 100));
    roads.add(alongX(-90, 110, 100));
    expect(roads.add(alongY(10, [-35, -15, 5, 25, 45, 65, 85, 100]), true)).toBeUndefined();
    expect(roads.curves).toHaveLength(2);
  });

  it('keeps a deck off a road on the ground it cannot stand a clearance over', () => {
    const roads = network();
    roads.add(alongX(-100, 100));
    // The deck is not on the ground, so it cannot meet the road, and on level
    // ground it stands no higher than the road does.
    expect(roads.deckApart({ x: 10, y: -50 }, { x: 10, y: 50 }, 'arterial')).toBe(false);
    expect(roads.deckApart({ x: 10, y: 50 }, { x: 10, y: 150 }, 'arterial')).toBe(true);
    const deck = alongY(10, [-50, 50]);
    deck.bridges = [0];
    expect(roads.add(deck)).toBeUndefined();
  });

  it('spends the headroom slack on a deck already standing, and no more', () => {
    // A deck reads the ground under its own two heads, so its bed stands a
    // little off what the ground at the crossing says. Centimetres of that are
    // headroom no vehicle can tell apart; half a metre of it is a deck a lorry
    // would meet (issue #290).
    const shelf = (height: number): NetworkGround => ({ canRun: () => true, heightAt: (_x, y) => (Math.abs(y) >= 40 ? height : 0) });
    for (const [height, apart] of [
      [CLEARANCE, true],
      [CLEARANCE - HEADROOM_SLACK / 2, true],
      [CLEARANCE - HEADROOM_SLACK * 2, false],
    ] as const) {
      const roads = network(shelf(height));
      roads.add(alongX(-100, 100));
      expect(roads.deckApart({ x: 10, y: -50 }, { x: 10, y: 50 }, 'arterial'), `a deck ${height} m up`).toBe(apart);
    }
  });

  it('clears the surface a junction plane leaves the road below, not its bed (issue #533)', () => {
    // The ground is a ridge along x. The road below runs over it, so its bed
    // falls away each side of the top, and the road up the ridge meets it
    // there. The junction is one plane, and the two mouths along the ridge
    // disagree about the grade, so the plane is level: the road below stands
    // above its own bed out to its cut and over the blend past it. The deck
    // has to clear that, not the bed.
    const ridge: NetworkGround = { canRun: noShortSpans.canRun, heightAt: (x) => -Math.abs(x - 60) * 0.1 };
    const roads = network(ridge);
    const below = roads.add(alongX(-200, 200)) as RoadCurve;
    roads.add(alongY(60, steps(0, 100)));
    expect(below.points).toContainEqual({ x: 60, y: 0 });
    const carried = roads.add(alongY(50, steps(-295, 305))) as RoadCurve;
    expect(liftNear(carried, { x: 50, y: 0 })).toBeGreaterThan(CLEARANCE);
    expect(buildRoadGraph(roads.curves).crossings).toHaveLength(1);
  });

  it('refuses a road that would join a node and take a crossing its headroom (issue #533)', () => {
    // The same ridge, and the deck laid before the road up it. A point standing
    // on a point of the network joins its node whatever the crossing plan says,
    // so the road that would raise the ground under the deck is refused. Only
    // the ones that would: on level ground a plane lifts nothing, and a
    // junction beside a crossing is no trouble at all.
    const ridge: NetworkGround = { canRun: noShortSpans.canRun, heightAt: (x) => -Math.abs(x - 60) * 0.1 };
    const roads = network(ridge);
    roads.add(alongX(-300, 300));
    roads.add(alongY(50, steps(-295, 305)));
    expect(buildRoadGraph(roads.curves).crossings).toHaveLength(1);
    expect(roads.add(alongY(60, steps(0, 100)))).toBeUndefined();
    // Out of the plane's reach the same road takes its junction.
    expect(roads.add(alongY(200, steps(0, 100)))).toBeDefined();
    const far = buildRoadGraph(roads.curves);
    expect(far.degree(far.nearestNode(200, 0) as number)).toBe(3);
  });

  it('never bends a segment that passes under a deck onto a snapped junction (issue #676, B1)', () => {
    // The new road is one long segment. It passes under a deck far along, and
    // crosses a street 2.5 m from a point the street already has. Snapping the
    // junction onto that point would swing the whole segment, and move the
    // place it passes under the deck to one nothing measured the headroom of.
    const roads = network({ canRun: () => true, heightAt: () => 0 });
    roads.add(alongX(-300, 300));
    roads.add({ ...alongY(60, steps(100, 300)), bridges: [3, 4, 5, 6], lift: [0, 2, 4, 7, 7, 7, 7, 7, 4, 2, 0] });
    const road = roads.add({ tier: 'street', points: [{ x: 39, y: -41 }, { x: 61.75, y: 225.5 }], bridges: [], tunnels: [], interchanges: [] }) as RoadCurve;
    // The junction stands where the two really cross, on the new road's line.
    expect(road.points[1]).toEqual({ x: 42.5, y: 0 });
    expect(buildRoadGraph(roads.curves).crossings).toHaveLength(1);
  });

  it('is refused where no piece of it reaches the network', () => {
    const roads = network(noShortSpans);
    roads.add(alongX(-100, 100));
    expect(roads.add(alongY(10, steps(-35, 45)))).toBeUndefined();
    expect(roads.curves).toHaveLength(1);
  });

  it('passes an arterial under a highway at a slot, and shortens it where the highway is on the ground', () => {
    const points: Point[] = [];
    for (let x = 0; x <= 1500; x += 30) points.push({ x, y: 0 });
    const plan = planHighway(points, [], [], [0, points.length - 1], [], () => true);
    const roads = network();
    roads.add({ tier: 'highway', points, bridges: plan.bridges, tunnels: [], interchanges: [0, points.length - 1], slots: plan.slots, lift: plan.lift });
    roads.add(alongX(-300, 1800, 200));
    const at = ((plan.slots[plan.slots.length >> 1] as number) + 0.5) * 30;
    const under = roads.add(alongY(at, steps(-95, 205), 'arterial')) as RoadCurve;
    // It meets the road at y = 200, and nothing else.
    expect(under.points).toHaveLength(17);
    expect(buildRoadGraph(roads.curves).crossings).toHaveLength(1);
    // At x = 45 the highway stands on the ground by its interchange.
    const cut = roads.add(alongY(45, steps(-95, 205), 'arterial')) as RoadCurve;
    expect(Math.min(...cut.points.map((p) => p.y))).toBeGreaterThan(0);
    expect(buildRoadGraph(roads.curves).crossings).toHaveLength(1);
  });

  it('shortens a street back from a highway, slot or no slot', () => {
    const points: Point[] = [];
    for (let x = 0; x <= 1500; x += 30) points.push({ x, y: 0 });
    const plan = planHighway(points, [], [], [0, points.length - 1], [], () => true);
    const roads = network();
    roads.add({ tier: 'highway', points, bridges: plan.bridges, tunnels: [], interchanges: [0, points.length - 1], slots: plan.slots, lift: plan.lift });
    roads.add(alongX(-300, 1800, 200));
    // A street may not cross a highway's right-of-way anywhere, so it is cut
    // back to the piece on the far side that still reaches the network, and
    // the graph gains no crossing (issue #269).
    const at = ((plan.slots[plan.slots.length >> 1] as number) + 0.5) * 30;
    const street = roads.add(alongY(at, steps(-95, 205))) as RoadCurve;
    expect(Math.min(...street.points.map((p) => p.y))).toBeGreaterThan(0);
    expect(buildRoadGraph(roads.curves).crossings).toHaveLength(0);
  });
});

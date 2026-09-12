import { describe, expect, it } from 'vitest';
import { buildRoadGraph } from '../src/world/graph.ts';
import { CLEARANCE, raiseOverpasses } from '../src/world/overpass.ts';
import type { Point, RoadCurve, RoadTier } from '../src/world/types.ts';

/** A straight road along x, with a point every `step` metres. */
function along(id: number, tier: RoadTier, fromX: number, toX: number, y = 0, step = 20): RoadCurve {
  const points: Point[] = [];
  for (let x = fromX; x <= toX; x += step) points.push({ x, y });
  return { id, tier, points, bridges: [], tunnels: [], interchanges: [] };
}

/**
 * A straight road along y, crossing the roads above at `x`. Its points miss
 * `y = 0` on purpose: a crossing that stands on a point of either road is a
 * place the two share, which is a junction and not an overpass.
 */
function across(id: number, tier: RoadTier, x: number, fromY = -70, toY = 70, step = 20): RoadCurve {
  const points: Point[] = [];
  for (let y = fromY; y <= toY; y += step) points.push({ x, y });
  return { id, tier, points, bridges: [], tunnels: [], interchanges: [] };
}

/** The lift of a curve at the point nearest a place, and 0 where the curve has none. */
function liftNear(road: RoadCurve, x: number): number {
  let best = 0;
  let bestOff = Infinity;
  for (let i = 0; i < road.points.length; i++) {
    const off = Math.abs((road.points[i] as Point).x - x);
    if (off >= bestOff) continue;
    bestOff = off;
    best = road.lift?.[i] ?? 0;
  }
  return best;
}

describe('a road that crosses another one', () => {
  it('is carried over it, on a deck, at the clearance the crossing needs', () => {
    // The narrower road climbs: a street hops over an arterial, and the
    // arterial holds its line.
    const roads = raiseOverpasses([along(0, 'street', -300, 300), across(1, 'arterial', 10)]);
    const carried = roads[0] as RoadCurve;
    const under = roads[1] as RoadCurve;
    expect(liftNear(carried, 10)).toBeCloseTo(CLEARANCE, 6);
    // The road underneath is left on the ground.
    expect(under.lift).toBeUndefined();
    expect(under.bridges).toEqual([]);
    // Every raised segment is a deck, and no segment on the ground is.
    const lift = carried.lift as number[];
    for (let i = 0; i + 1 < carried.points.length; i++) {
      const raised = (lift[i] as number) > 0 || (lift[i + 1] as number) > 0;
      expect(carried.bridges.includes(i)).toBe(raised);
    }
  });

  it('keeps its line: the points it gains stand on it, and the ramps end on points it had', () => {
    const roads = raiseOverpasses([along(0, 'street', -300, 300), across(1, 'arterial', 10)]);
    const carried = roads[0] as RoadCurve;
    expect(carried.points.length).toBeGreaterThan(31);
    for (const point of carried.points) expect(point.y).toBe(0);
    // A ramp that ended between two points would cut that segment in two, and
    // half a segment can climb harder than the whole. So each end of the lift
    // stands on a point the curve already had: a whole multiple of the step.
    const lift = carried.lift as number[];
    for (let i = 0; i < carried.points.length; i++) {
      if ((lift[i] as number) !== 0) continue;
      expect(Math.abs((carried.points[i] as Point).x % 20)).toBe(0);
    }
  });

  it('climbs no harder than its tier allows', () => {
    const roads = raiseOverpasses([along(0, 'street', -300, 300), across(1, 'arterial', 10)]);
    const carried = roads[0] as RoadCurve;
    const lift = carried.lift as number[];
    for (let i = 0; i + 1 < carried.points.length; i++) {
      const run = (carried.points[i + 1] as Point).x - (carried.points[i] as Point).x;
      const rise = Math.abs((lift[i + 1] as number) - (lift[i] as number));
      expect(rise / run).toBeLessThanOrEqual(0.18 + 1e-9);
    }
  });

  it('lets the wider road climb where a junction stands inside the narrow one\'s ramps', () => {
    const street = along(0, 'street', -300, 300);
    // Another street meets this one 10 m from the crossing, on a point the two
    // share. A junction is a plane at the height of the ground, so this street
    // cannot climb there.
    const meeting = across(2, 'street', 20);
    meeting.points[3] = { x: 20, y: 0 };
    // The arterial is long enough for its own 81 m ramps.
    const roads = raiseOverpasses([street, across(1, 'arterial', 10, -190, 210), meeting]);
    expect((roads[0] as RoadCurve).lift).toBeUndefined();
    expect(liftNear(rotated(roads[1] as RoadCurve), 0)).toBeCloseTo(CLEARANCE, 6);
  });

  it('is left flat where the road is too short to land again', () => {
    // Neither is long enough: a street needs 36 m of ramp and an arterial 81 m,
    // and each of these runs out before it is down again.
    const roads = raiseOverpasses([along(0, 'street', -40, 40), across(1, 'arterial', 10, -50, 50)]);
    for (const road of roads) expect(road.lift).toBeUndefined();
    expect(buildRoadGraph(roads).crossings).toHaveLength(1);
  });

  it('gives two crossings close together one deck rather than a dip between them', () => {
    const roads = raiseOverpasses([along(0, 'street', -300, 300), across(1, 'arterial', -10), across(2, 'arterial', 10)]);
    const carried = roads[0] as RoadCurve;
    const lift = carried.lift as number[];
    for (let i = 0; i < carried.points.length; i++) {
      const x = (carried.points[i] as Point).x;
      if (x < -10 || x > 10) continue;
      expect(lift[i]).toBeCloseTo(CLEARANCE, 6);
    }
  });

  it('moves the decks, bores and interchanges of a curve with the points it gains', () => {
    const road = along(0, 'arterial', -600, 600);
    // Segment 0 is a bore and segment 1 a deck, both far from the crossing, and
    // the interchanges stand at the two ends.
    road.tunnels = [0];
    road.bridges = [1];
    road.interchanges = [0, road.points.length - 1];
    const roads = raiseOverpasses([road, across(1, 'highway', 10)]);
    const carried = roads[0] as RoadCurve;
    const first = carried.points[carried.interchanges[0] as number] as Point;
    const last = carried.points[carried.interchanges[1] as number] as Point;
    expect(first.x).toBe(-600);
    expect(last.x).toBe(600);
    expect(carried.points[(carried.tunnels[0] as number) + 1]).toEqual({ x: -580, y: 0 });
    expect(carried.points[(carried.bridges[0] as number) + 1]).toEqual({ x: -560, y: 0 });
  });
});

/** The curve of the road that runs across, so `liftNear` can read it along y. */
function rotated(road: RoadCurve): RoadCurve {
  return { ...road, points: road.points.map((p) => ({ x: p.y, y: p.x })) };
}

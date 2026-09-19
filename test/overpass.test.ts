import { describe, expect, it } from 'vitest';
import { CLEARANCE, raiseAt, raised, type RaisedLine } from '../src/world/overpass.ts';
import { curveDistances } from '../src/world/ribbon.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { Point } from '../src/world/types.ts';

/** A straight line along x, with a point every `step` metres. */
function line(fromX: number, toX: number, step = 20): RaisedLine {
  const points: Point[] = [];
  for (let x = fromX; x <= toX; x += step) points.push({ x, y: 0 });
  return { points, bridges: [], tunnels: [], interchanges: [] };
}

/** The line with one raise of `height` over the place `x`, a plateau `plateau` metres each side, at a street's grade. */
function raisedOver(road: RaisedLine, x: number, plateau = 17, height = CLEARANCE): RaisedLine {
  const distances = curveDistances(road.points);
  const start = (road.points[0] as Point).x;
  const raise = raiseAt(distances, x - start, plateau, height / TIERS.street.maxGrade, height);
  if (raise === undefined) throw new Error('no raise');
  return raised(road, [raise]);
}

/** The lift of a line at the point nearest a place along x. */
function liftNear(road: RaisedLine, x: number): number {
  let best = 0;
  let bestOff = Infinity;
  road.points.forEach((p, i) => {
    const off = Math.abs(p.x - x);
    if (off >= bestOff) return;
    bestOff = off;
    best = road.lift?.[i] ?? 0;
  });
  return best;
}

describe('the lift profile of an overpass', () => {
  it('stands a clearance over the crossing, and every raised segment is a deck', () => {
    const carried = raisedOver(line(-300, 300), 10);
    expect(liftNear(carried, 10)).toBeCloseTo(CLEARANCE, 6);
    const lift = carried.lift as number[];
    for (let i = 0; i + 1 < carried.points.length; i++) {
      const up = (lift[i] as number) > 0 || (lift[i + 1] as number) > 0;
      expect(carried.bridges.includes(i)).toBe(up);
    }
  });

  it('stands at the height it is asked for, however far that is over the clearance', () => {
    // The height comes from `crossing-plan.ts`, which measures the surface of
    // the road below: a road in a dip asks for more than the clearance (issue
    // #290). The ramps grow with it and stay inside the tier's grade.
    const carried = raisedOver(line(-600, 600), 10, 17, CLEARANCE + 6);
    expect(liftNear(carried, 10)).toBeCloseTo(CLEARANCE + 6, 6);
    const lift = carried.lift as number[];
    for (let i = 0; i + 1 < carried.points.length; i++) {
      const run = (carried.points[i + 1] as Point).x - (carried.points[i] as Point).x;
      expect(Math.abs((lift[i + 1] as number) - (lift[i] as number)) / run).toBeLessThanOrEqual(TIERS.street.maxGrade + 1e-9);
    }
  });

  it('keeps its line: the points it gains stand on it, and the ramps end on points it had', () => {
    const carried = raisedOver(line(-300, 300), 10);
    expect(carried.points.length).toBeGreaterThan(31);
    for (const point of carried.points) expect(point.y).toBe(0);
    // A ramp that ended between two points would cut that segment in two, and
    // half a segment can climb harder than the whole. So each end of the lift
    // stands on a point the line already had: a whole multiple of the step.
    const lift = carried.lift as number[];
    carried.points.forEach((p, i) => {
      if (lift[i] === 0) expect(Math.abs(p.x % 20)).toBe(0);
    });
  });

  it('climbs no harder than its tier allows', () => {
    const carried = raisedOver(line(-300, 300), 10);
    const lift = carried.lift as number[];
    for (let i = 0; i + 1 < carried.points.length; i++) {
      const run = (carried.points[i + 1] as Point).x - (carried.points[i] as Point).x;
      expect(Math.abs((lift[i + 1] as number) - (lift[i] as number)) / run).toBeLessThanOrEqual(TIERS.street.maxGrade + 1e-9);
    }
  });

  it('asks for no raise where the line runs out before it is down again', () => {
    const road = line(-40, 40);
    expect(raiseAt(curveDistances(road.points), 50, 17, CLEARANCE / TIERS.street.maxGrade, CLEARANCE)).toBeUndefined();
  });

  it('gives two raises close together one deck rather than a dip between them', () => {
    const road = line(-300, 300);
    const distances = curveDistances(road.points);
    const ramp = CLEARANCE / TIERS.street.maxGrade;
    const raises = [290, 310].map((at) => raiseAt(distances, at, 17, ramp, CLEARANCE)).filter((r) => r !== undefined);
    const carried = raised(road, raises);
    carried.points.forEach((p, i) => {
      if (p.x >= -10 && p.x <= 10) expect(carried.lift?.[i]).toBeCloseTo(CLEARANCE, 6);
    });
  });

  it('moves the decks, bores and interchanges of a line with the points it gains', () => {
    const road = line(-600, 600);
    // Segment 0 is a bore and segment 1 a deck, both far from the crossing, and
    // the interchanges stand at the two ends.
    road.tunnels = [0];
    road.bridges = [1];
    road.interchanges = [0, road.points.length - 1];
    const carried = raisedOver(road, 10);
    expect((carried.points[carried.interchanges[0] as number] as Point).x).toBe(-600);
    expect((carried.points[carried.interchanges[1] as number] as Point).x).toBe(600);
    expect(carried.points[(carried.tunnels[0] as number) + 1]).toEqual({ x: -580, y: 0 });
    expect(carried.points[(carried.bridges[0] as number) + 1]).toEqual({ x: -560, y: 0 });
  });
});

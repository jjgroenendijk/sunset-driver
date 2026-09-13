import { describe, expect, it } from 'vitest';
import { MIN_MEET } from '../src/world/road-clear.ts';
import { footprintHalfWidth } from '../src/world/tiers.ts';
import { type Point, type RoadCurve, type WorldDescription } from '../src/world/types.ts';
import { seeds, worlds } from './seed-fixture.ts';
import { distanceToSegment, pointKey } from './seed-probes.ts';

/**
 * The seed sweep of spec section 6 on the ground two roads share. Spec section 2
 * promises no two roads overlap, so two roads touch only where they share a
 * point or cross. These checks read the two ways a road once lay on another
 * with nothing joining them: along its line from a shared point, and with an
 * end standing in its carriageway.
 */
export function overlapChecks(): void {
  describe('road overlap', () => {
    it('meets another road only at an angle a junction can be built at', () => {
      // A road that leaves a shared point along another road's line lies in
      // that road's carriageway for as far as the two run together.
      for (const seed of seeds) {
        const w = worlds.get(seed) as WorldDescription;
        const worst = shallowestMeeting(w.roads);
        const complaint = worst !== undefined && worst.turn < MIN_MEET ? `${worst.text} at ${((worst.turn * 180) / Math.PI).toFixed(0)}°` : undefined;
        expect(complaint, `seed ${seed}`).toBeUndefined();
      }
    });

    it('ends no road inside the carriageway of a road it does not meet', () => {
      // An end that is a point of no other curve met nothing, so the ground
      // around it has to be its own: not within another road's footprint.
      for (const seed of seeds) {
        const w = worlds.get(seed) as WorldDescription;
        expect(endOnCarriageway(w.roads), `seed ${seed}`).toBeUndefined();
      }
    });
  });
}

/** Where two curves leave a shared point closest to each other's line, and the angle between them. */
function shallowestMeeting(roads: readonly RoadCurve[]): { turn: number; text: string } | undefined {
  const rays = new Map<number, { curve: RoadCurve; to: Point }[]>();
  for (const road of roads) {
    for (let i = 0; i < road.points.length; i++) {
      const key = pointKey(road.points[i] as Point);
      const here = rays.get(key) ?? [];
      for (const to of [road.points[i - 1], road.points[i + 1]]) {
        if (to !== undefined) here.push({ curve: road, to });
      }
      rays.set(key, here);
    }
  }
  let worst: { turn: number; text: string } | undefined;
  for (const road of roads) {
    for (const p of road.points) {
      const here = rays.get(pointKey(p)) ?? [];
      for (const u of here) {
        if (u.curve.id !== road.id) continue;
        for (const v of here) {
          if (v.curve.id <= road.id) continue;
          let turn = Math.abs(Math.atan2(u.to.y - p.y, u.to.x - p.x) - Math.atan2(v.to.y - p.y, v.to.x - p.x)) % (2 * Math.PI);
          if (turn > Math.PI) turn = 2 * Math.PI - turn;
          if (worst !== undefined && turn >= worst.turn) continue;
          const where = `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
          worst = { turn, text: `${road.tier} ${road.id} leaves ${v.curve.tier} ${v.curve.id} at ${where}` };
        }
      }
    }
  }
  return worst;
}

/** The first end of a curve that meets nothing and stands inside another road's footprint on the ground. */
function endOnCarriageway(roads: readonly RoadCurve[]): string | undefined {
  const CELL = 50;
  const shared = new Map<number, number>();
  const cells = new Map<number, { road: RoadCurve; i: number }[]>();
  const cell = (cx: number, cy: number): number => (cy + 10_000) * 20_000 + cx + 10_000;
  for (const road of roads) {
    for (const p of road.points) shared.set(pointKey(p), (shared.get(pointKey(p)) ?? 0) + 1);
    for (let i = 0; i + 1 < road.points.length; i++) {
      // A deck and a bore are not on the ground, so nothing stands in them.
      if (road.bridges.includes(i) || road.tunnels.includes(i)) continue;
      const a = road.points[i] as Point;
      const b = road.points[i + 1] as Point;
      for (let cy = Math.floor(Math.min(a.y, b.y) / CELL); cy <= Math.floor(Math.max(a.y, b.y) / CELL); cy++) {
        for (let cx = Math.floor(Math.min(a.x, b.x) / CELL); cx <= Math.floor(Math.max(a.x, b.x) / CELL); cx++) {
          const key = cell(cx, cy);
          const list = cells.get(key) ?? [];
          list.push({ road, i });
          cells.set(key, list);
        }
      }
    }
  }
  const reach = footprintHalfWidth('highway');
  for (const road of roads) {
    for (const end of [road.points[0] as Point, road.points[road.points.length - 1] as Point]) {
      if ((shared.get(pointKey(end)) ?? 0) > 1) continue;
      for (let cy = Math.floor((end.y - reach) / CELL); cy <= Math.floor((end.y + reach) / CELL); cy++) {
        for (let cx = Math.floor((end.x - reach) / CELL); cx <= Math.floor((end.x + reach) / CELL); cx++) {
          for (const { road: other, i } of cells.get(cell(cx, cy)) ?? []) {
            if (other.id === road.id) continue;
            const d = distanceToSegment(end, other.points[i] as Point, other.points[i + 1] as Point);
            if (d >= footprintHalfWidth(other.tier)) continue;
            return `${road.tier} ${road.id} ends at ${end.x.toFixed(1)},${end.y.toFixed(1)}, ${d.toFixed(1)} m from ${other.tier} ${other.id}`;
          }
        }
      }
    }
  }
  return undefined;
}

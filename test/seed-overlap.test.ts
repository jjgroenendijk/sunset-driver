import { expect, it } from 'vitest';
import { MIN_MEET } from '../src/world/network-clearance.ts';
import { selfOverlap } from '../src/world/self-overlap.ts';
import { footprintHalfWidth } from '../src/world/tiers.ts';
import { type Point, type RoadCurve, type WorldDescription } from '../src/world/types.ts';
import { seeds, worlds } from './seed-fixture.ts';
import { distanceToSegment, nodePoints, nodeVisits } from './seed-probes.ts';
import { sweepSuite } from './seed-suite.ts';

/**
 * The seed sweep of spec section 6 on the ground two roads share. Spec section 2
 * promises no two roads overlap, so two roads touch only where they share a
 * point or cross. These checks read the two ways a road once lay on another
 * with nothing joining them: along its line from a shared point, and with an
 * end standing in its carriageway. A road may not lie over itself either.
 */
sweepSuite('road overlap', () => {
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

  it('lays no road over its own carriageway', () => {
    // A curve that turns back on itself tighter than a half turn of its own
    // width lies over itself, and a road that crosses there crosses it two or
    // three times in a few metres (#252). The network refuses such a road
    // when it is added, and the passes after the trace may not bend one into it.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      let complaint: string | undefined;
      for (const road of w.roads) {
        const fold = selfOverlap(road.points, road.tier);
        if (fold === undefined) continue;
        const p = road.points[fold.second] as Point;
        complaint ??= `${road.tier} ${road.id} lies over itself between segments ${fold.first} and ${fold.second}, at ${p.x.toFixed(0)},${p.y.toFixed(0)}`;
      }
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

/**
 * The nodes a ramp of an interchange meets its highway at. A ramp leaves the
 * highway along the highway — that is what a gore is — so the angle a junction
 * needs is not the angle a merge is built at, and these nodes are left out of
 * the rule below (`ramps.ts`).
 */
function gores(roads: readonly RoadCurve[]): Set<number> {
  const out = new Set<number>();
  for (const road of roads) {
    for (const x of road.interchanges) for (const head of x.heads) out.add(road.nodes[head] ?? -1);
  }
  return out;
}

/** Where two curves leave a shared node closest to each other's line, and the angle between them. */
function shallowestMeeting(roads: readonly RoadCurve[]): { turn: number; text: string } | undefined {
  const merges = gores(roads);
  const rays = new Map<number, { curve: RoadCurve; to: Point }[]>();
  for (const [node, on] of nodePoints(roads)) {
    const here: { curve: RoadCurve; to: Point }[] = [];
    for (const { road, at } of on) {
      for (const to of [road.points[at - 1], road.points[at + 1]]) {
        if (to !== undefined) here.push({ curve: road, to });
      }
    }
    rays.set(node, here);
  }
  let worst: { turn: number; text: string } | undefined;
  for (const road of roads) {
    for (let i = 0; i < road.points.length; i++) {
      const p = road.points[i] as Point;
      if (merges.has(road.nodes[i] ?? -1)) continue;
      const here = rays.get(road.nodes[i] ?? -1) ?? [];
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
  const shared = nodePoints(roads);
  const cells = new Map<number, { road: RoadCurve; i: number }[]>();
  const cell = (cx: number, cy: number): number => (cy + 10_000) * 20_000 + cx + 10_000;
  for (const road of roads) {
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
    for (const i of [0, road.points.length - 1]) {
      const end = road.points[i] as Point;
      if (nodeVisits(shared, road, i) > 1) continue;
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

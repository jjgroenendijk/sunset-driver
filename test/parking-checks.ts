import { type Point } from '../src/core/geom.ts';
import { insideRegion, ringsClash } from '../src/world/lot-geom.ts';
import { ParcelIndex, type Parcel } from '../src/world/parcels.ts';
import { BAY_SHARE, bayRing, laneHalfWidth, segmentQuad, type ParkingBays } from '../src/world/parking.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { RoadCurve } from '../src/world/types.ts';

/** Metres each way of one bucket the checks file the segments and the bays in. */
const CELL = 20;

/**
 * What is wrong with a set of bays, as one line per fault: a bay that lies on
 * the lanes of any road, two bays that share ground, a street bay off its
 * parking strip, and a car park bay that is not wholly on a car park. The
 * parcels are left out where the bays were laid without any.
 */
export function bayFaults(bays: ParkingBays, roads: readonly RoadCurve[], parcels?: readonly Parcel[]): string[] {
  const faults: string[] = [];
  const segments = new Map<number, [RoadCurve, number][]>();
  for (const road of roads) {
    for (let i = 0; i + 1 < road.points.length; i++) {
      const a = road.points[i] as Point;
      const b = road.points[i + 1] as Point;
      const reach = TIERS[road.tier].width / 2;
      for (const key of cellsOf(Math.min(a.x, b.x) - reach, Math.min(a.y, b.y) - reach, Math.max(a.x, b.x) + reach, Math.max(a.y, b.y) + reach)) {
        const list = segments.get(key) ?? [];
        list.push([road, i]);
        segments.set(key, list);
      }
    }
  }
  const index = parcels === undefined ? undefined : new ParcelIndex(parcels);
  const filed = new Map<number, number[]>();
  for (let bay = 0; bay < bays.count; bay++) {
    // An aircraft stand is the airfield's, and `seed-airfields.test.ts` checks it.
    if ((bays.craft?.[bay] ?? -1) >= 0) continue;
    const ring = bayRing(bays, bay);
    const box = boxOf(ring);
    const at = `bay ${bay} at (${Math.round(bays.x[bay] as number)}, ${Math.round(bays.y[bay] as number)})`;
    const seen = new Set<RoadCurve['points'][number]>();
    let strip = Infinity;
    for (const key of cellsOf(box.minX, box.minY, box.maxX, box.maxY)) {
      for (const [road, i] of segments.get(key) ?? []) {
        const a = road.points[i] as Point;
        // A segment is filed under every cell it crosses; its first point names it.
        if (seen.has(a)) continue;
        seen.add(a);
        const b = road.points[i + 1] as Point;
        const quad = segmentQuad(a, b, laneHalfWidth(road.tier));
        if (quad !== undefined && ringsClash(ring, quad, -BAY_SHARE)) faults.push(`${at} lies on the lanes of a ${road.tier}`);
        if (road.tier === 'street') strip = Math.min(strip, distanceToSegment(bays.x[bay] as number, bays.y[bay] as number, a, b));
      }
      for (const other of filed.get(key) ?? []) {
        if (ringsClash(ring, bayRing(bays, other), -BAY_SHARE)) faults.push(`${at} shares ground with bay ${other}`);
      }
    }
    for (const key of cellsOf(box.minX, box.minY, box.maxX, box.maxY)) {
      const list = filed.get(key) ?? [];
      list.push(bay);
      filed.set(key, list);
    }
    if (bays.street[bay] === 1) {
      const middle = TIERS.street.width / 2 - TIERS.street.parking / 2;
      if (Math.abs(strip - middle) > 0.25) faults.push(`${at} stands ${strip.toFixed(2)} m from its street, not ${middle} m`);
    } else if (index !== undefined) {
      const parcel = index.at(bays.x[bay] as number, bays.y[bay] as number);
      if (parcel?.owner !== 'car-park' || !insideRegion(ring, parcel.region)) faults.push(`${at} is not on a car park`);
    }
  }
  return [...new Set(faults)];
}

function cellsOf(minX: number, minY: number, maxX: number, maxY: number): number[] {
  const keys: number[] = [];
  for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) keys.push((cx + 32768) * 65536 + cy + 32768);
  }
  return keys;
}

function boxOf(ring: readonly Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function distanceToSegment(x: number, y: number, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * vx + (y - a.y) * vy) / l2)) : 0;
  return Math.hypot(x - a.x - vx * t, y - a.y - vy * t);
}

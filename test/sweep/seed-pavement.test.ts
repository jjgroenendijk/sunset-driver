import { expect, it } from 'vitest';
import { pavementTriangles, type PavementVertex, type SurfaceAt } from '../../src/render/roads/pavement-mesh.ts';
import type { RoadCarve } from '../../src/world/carve/carve.ts';
import { junctionShape } from '../../src/world/junctions/junction-shape.ts';
import type { JunctionMap } from '../../src/world/junctions/junctions.ts';
import type { ChunkPavement } from '../../src/world/city/pavement.ts';
import { RoadRibbons } from '../../src/world/carve/ribbon.ts';
import { TIERS } from '../../src/world/roads/tiers.ts';
import type { Point, RoadTier, WorldDescription } from '../../src/world/types.ts';
import { FOOTPRINT_COUNT, PAVEMENT_SLACK, SURFACE_ABOVE, SURFACE_STRIDE } from './seed-limits.ts';
import { chunkCrowdedAt, chunkGroundAt, chunkKeys } from './seed-probes.ts';
import { bedsOf, carveOf, chunkOf, junctionsOf, seeds, worlds } from './seed-fixture.ts';
import { sweepSuite } from './seed-suite.ts';

/**
 * The seed sweep of spec sections 6.2 and 6.4 on the pavement: the inset of
 * each block, cut down to the kerb (`pavement.ts`).
 *
 * The carriageway is asked here from the roads themselves rather than from the
 * cut: a rectangle of the carriageway's width along every segment on the
 * ground, and the fan of every junction. The pavement is asked at the middle of
 * each of its triangles and half way from there to each corner. The ground is
 * asked against the pavement at its vertices and at the middle of its
 * triangles, as `seed-surface.test.ts` asks it of the roads, and ground two
 * claimants ask different heights of is left out for the same reason. One
 * piece in `SURFACE_STRIDE` is asked all of that, and every ring of every piece
 * whether it crosses itself.
 */
sweepSuite('pavement', () => {
  it('lays no pavement over a carriageway, never crosses itself and never has the ground stand through it', () => {
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const carve = carveOf(seed);
      const carriageway = new CarriagewayIndex(w, junctionsOf(seed), new RoadRibbons(bedsOf(seed), w.roads));
      const surfaceAt = (x: number, y: number, tier: RoadTier): number => carve.surfaceAt(x, y, tier);
      let complaint: string | undefined;
      let faults = 0;
      let pieces = 0;
      const fault = (text: string): void => {
        faults++;
        complaint ??= text;
      };
      for (const [cx, cy] of chunkKeys()) {
        for (const piece of chunkOf(seed, cx, cy).pavement) {
          if (pieces++ % SURFACE_STRIDE !== 0) continue;
          checkPiece(piece, `chunk ${cx}, ${cy}: ${piece.tier} pavement`, carve, carriageway, surfaceAt, fault);
        }
      }
      expect(pieces, `seed ${seed}`).toBeGreaterThan(0);
      if (faults > 0) complaint = `${faults} faults: ${complaint}`;
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });
});

/**
 * Asks one piece of pavement whether a ring crosses itself, whether the ground
 * stands through it and whether it lies over a carriageway. Each fault goes to `fault`.
 */
function checkPiece(
  piece: ChunkPavement,
  where: string,
  carve: RoadCarve,
  carriageway: CarriagewayIndex,
  surfaceAt: SurfaceAt,
  fault: (text: string) => void,
): void {
  for (const ring of [piece.region.outer, ...piece.region.holes]) {
    const crossing = selfCrossing(ring);
    if (crossing !== undefined) fault(`${where} crosses itself at ${crossing.x.toFixed(1)},${crossing.y.toFixed(1)}`);
  }
  const mesh = pavementTriangles(piece, surfaceAt);
  if (mesh === undefined) return;
  const ground = (v: { x: number; y: number; h: number }): void => {
    if (chunkCrowdedAt(carve, v.x, v.y)) return;
    const above = chunkGroundAt(carve, v.x, v.y) - v.h;
    if (above > SURFACE_ABOVE) fault(`${where} at ${v.x.toFixed(1)},${v.y.toFixed(1)} has the ground ${above.toFixed(2)} m above it`);
  };
  for (const v of mesh.vertices) ground(v);
  for (const face of mesh.faces) {
    const [a, b, c] = face.map((k) => mesh.vertices[k] as PavementVertex) as [PavementVertex, PavementVertex, PavementVertex];
    const middle = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, h: (a.h + b.h + c.h) / 3 };
    ground(middle);
    for (const p of [middle, halfway(middle, a), halfway(middle, b), halfway(middle, c)]) {
      const road = carriageway.under(p);
      if (road !== undefined) fault(`${where} at ${p.x.toFixed(1)},${p.y.toFixed(1)} lies over ${road}`);
    }
  }
}

function halfway(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Where two edges of a ring that do not share a corner cross, or nothing. Two
 * edges that only touch do not count: the polygon arithmetic may pinch a ring
 * at a vertex, and that ring still does not cross itself.
 */
function selfCrossing(ring: readonly Point[]): Point | undefined {
  const n = ring.length;
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (i, j) => Math.min((ring[i] as Point).x, (ring[(i + 1) % n] as Point).x) - Math.min((ring[j] as Point).x, (ring[(j + 1) % n] as Point).x),
  );
  for (let s = 0; s < n; s++) {
    const i = order[s] as number;
    const a = ring[i] as Point;
    const b = ring[(i + 1) % n] as Point;
    const right = Math.max(a.x, b.x);
    for (let u = s + 1; u < n; u++) {
      const j = order[u] as number;
      const c = ring[j] as Point;
      const d = ring[(j + 1) % n] as Point;
      if (Math.min(c.x, d.x) > right) break;
      if (Math.abs(i - j) <= 1 || Math.abs(i - j) === n - 1) continue;
      const at = segmentsCross(a, b, c, d);
      if (at !== undefined) return at;
    }
  }
  return undefined;
}

/** Where segment `ab` crosses segment `cd` strictly inside both, or nothing. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): Point | undefined {
  if (Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) return undefined;
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (!(d1 * d2 < 0 && d3 * d4 < 0)) return undefined;
  const t = d1 / (d1 - d2);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function cross(o: Point, a: Point, p: Point): number {
  return (a.x - o.x) * (p.y - o.y) - (a.y - o.y) * (p.x - o.x);
}

/** Metres across a cell of the carriageway index. */
const CELL = 20;

/**
 * The carriageway of a whole world, as the roads draw it: a rectangle of the
 * carriageway's width along every segment on the ground, and every triangle of
 * every junction's fan, filed in a grid.
 */
class CarriagewayIndex {
  private readonly cells = new Map<string, { name: string; ring: Point[] }[]>();

  constructor(w: WorldDescription, junctions: JunctionMap, ribbons: RoadRibbons) {
    for (const road of w.roads) {
      const half = TIERS[road.tier].width / 2;
      const off = new Set([...road.bridges, ...road.tunnels]);
      for (let i = 0; i + 1 < road.points.length; i++) {
        if (off.has(i)) continue;
        const a = road.points[i] as Point;
        const b = road.points[i + 1] as Point;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length === 0) continue;
        const nx = (-(b.y - a.y) / length) * half;
        const ny = ((b.x - a.x) / length) * half;
        const ring = [
          { x: a.x - nx, y: a.y - ny },
          { x: b.x - nx, y: b.y - ny },
          { x: b.x + nx, y: b.y + ny },
          { x: a.x + nx, y: a.y + ny },
        ];
        this.file(`${road.tier} ${road.id} segment ${i}`, ring);
      }
    }
    for (const junction of junctions.junctions) {
      const fan = junctionShape(junction, ribbons).carriageway;
      for (let i = 0; i < fan.length; i++) {
        const p = fan[i] as Point;
        const q = fan[(i + 1) % fan.length] as Point;
        const ring = [{ x: junction.x, y: junction.y }, { x: p.x, y: p.y }, { x: q.x, y: q.y }];
        if (Math.abs(cross(ring[0] as Point, p, q)) > 1e-9) this.file(`junction ${junction.node}`, ring);
      }
    }
  }

  /** The carriageway a place lies on by more than {@link PAVEMENT_SLACK}, or nothing. */
  under(p: Point): string | undefined {
    for (const entry of this.cells.get(`${Math.floor(p.x / CELL)}:${Math.floor(p.y / CELL)}`) ?? []) {
      if (insideBy(entry.ring, p, PAVEMENT_SLACK)) return entry.name;
    }
    return undefined;
  }

  private file(name: string, ring: Point[]): void {
    const xs = ring.map((q) => q.x);
    const ys = ring.map((q) => q.y);
    for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++) {
      for (let cy = Math.floor(Math.min(...ys) / CELL); cy <= Math.floor(Math.max(...ys) / CELL); cy++) {
        const key = `${cx}:${cy}`;
        const list = this.cells.get(key);
        if (list === undefined) this.cells.set(key, [{ name, ring }]);
        else list.push({ name, ring });
      }
    }
  }
}

/** True where a place stands inside a convex ring, further than `slack` from each of its edges. */
function insideBy(ring: readonly Point[], p: Point, slack: number): boolean {
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) continue;
    const side = cross(a, b, p) / length;
    if (sign === 0) sign = Math.sign(side);
    if (side * sign <= slack) return false;
  }
  return sign !== 0;
}

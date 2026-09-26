import { describe, expect, it } from 'vitest';
import { pointInRegion, type Point } from '../../../src/core/geom.ts';
import { pavementSurface, pavementTriangles, PAVEMENT_EDGE } from '../../../src/render/roads/pavement-mesh.ts';
import { roadDrawCalls, vergeRise } from '../../../src/render/roads/road-mesh.ts';
import { buildLayers, ChunkSource, type WorldChunk } from '../../../src/world/chunks.ts';
import { Heightfield } from '../../../src/world/terrain/heightfield.ts';
import { footprintHalfWidth, TIERS } from '../../../src/world/roads/tiers.ts';
import type { District, RoadCurve, RoadTier, WorldDescription, Zone } from '../../../src/world/types.ts';
import { withNodes } from '../../support/helpers.ts';
import { compareStrings } from '../../../src/core/sort.ts';

const SIZE = 800;
const CELL = 10;

function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

function curve(id: number, coords: readonly [number, number][], tier: RoadTier = 'street'): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [], nodes: [] };
}

/** A square island on ground that rises across the map, under the roads a test lays. */
function world(roads: RoadCurve[]): WorldDescription {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) hf.set(ix, iy, 20 + hf.worldX(ix) * 0.02 + hf.worldY(iy) * 0.05);
  }
  return {
    seed: 7,
    size: SIZE,
    archetype: 'archipelago',
    core: { x: 0, y: 0 },
    terrain: hf.toData(),
    water: {
      seaLevel: 0,
      islands: [{ id: 0, x: 0, y: 0, radius: SIZE / 2, main: true }],
      crossings: [],
      rivers: [],
      harbour: { x: 0, y: 0, radius: 10 },
      industry: 0,
    },
    districts: [district(0, 'inner', 0, 0)],
    beaches: [],
    airfields: [],
    roads: withNodes(roads),
    corridors: [],
    tram: { route: [], edges: [], corridors: [], stops: [], crossings: [], length: 0 },
  };
}

/** Where a street at `angle` degrees from the east ends, 180 m out from (60, 60). */
function arm(angle: number): [number, number] {
  const radians = (angle * Math.PI) / 180;
  return [60 + 180 * Math.cos(radians), 60 + 180 * Math.sin(radians)];
}

// A junction at (60, 60) with a right-angled corner between the east and north
// arms and a sharp one of 35 degrees between the east arm and a third street;
// and an arterial crossing a street away from any junction, which the network
// never lays but which the pavement still has to keep off.
const roads = [
  curve(0, [[-150, 60], [60, 60], arm(0)]),
  curve(1, [[60, 60], arm(90)]),
  curve(2, [[60, 60], arm(-35)]),
  curve(3, [[-120, -200], [-120, 200]], 'arterial'),
];
const w = world(roads);
const layers = buildLayers(w);
const source = new ChunkSource(w, layers);
const surfaceAt = (x: number, y: number, tier: RoadTier): number => layers.carve.surfaceAt(x, y, tier);
const home = source.chunk(0, 0);
const west = source.chunk(-1, 0);

/** The pavement of a chunk that covers a place, or nothing. */
function pieceAt(chunk: WorldChunk, p: Point): WorldChunk['pavement'][number] | undefined {
  return chunk.pavement.find((piece) => pointInRegion(p, piece.region));
}

/** Metres from a place to a segment, and how far along it the nearest point lies. */
function offset(p: Point, a: Point, b: Point): { across: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  return { across: Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.hypot(dx, dy), t };
}

/** True where a place lies more than a centimetre inside the carriageway of a road. */
function onCarriageway(p: Point): boolean {
  return w.roads.some((road) => {
    for (let i = 0; i + 1 < road.points.length; i++) {
      const { across, t } = offset(p, road.points[i] as Point, road.points[i + 1] as Point);
      if (t > 0 && t < 1 && across < TIERS[road.tier].width / 2 - 0.01) return true;
    }
    return false;
  });
}

describe('pavement', () => {
  it('paves the corner of a junction, and every piece stands inside its chunk', () => {
    // Half way between the kerb and the back of the pavement, on the diagonal
    // of the right-angled corner.
    const depth = (TIERS.street.width / 2 + footprintHalfWidth('street')) / 2;
    expect(pieceAt(home, { x: 60 + depth, y: 60 + depth })?.tier).toBe('street');
    for (const piece of [...home.pavement, ...west.pavement]) {
      const chunk = home.pavement.includes(piece) ? home : west;
      for (const p of piece.region.outer) {
        expect(p.x).toBeGreaterThanOrEqual(chunk.bounds.minX - 1e-6);
        expect(p.x).toBeLessThanOrEqual(chunk.bounds.maxX + 1e-6);
      }
    }
  });

  it('lays no pavement over a carriageway, its own or another road crossing it', () => {
    let asked = 0;
    for (const chunk of [home, west]) {
      for (const piece of chunk.pavement) {
        const mesh = pavementTriangles(piece, surfaceAt);
        if (mesh === undefined) continue;
        for (const [a, b, c] of mesh.faces) {
          const pa = mesh.vertices[a] as Point;
          const pb = mesh.vertices[b] as Point;
          const pc = mesh.vertices[c] as Point;
          const middle = { x: (pa.x + pb.x + pc.x) / 3, y: (pa.y + pb.y + pc.y) / 3 };
          asked++;
          expect(onCarriageway(middle), `${piece.tier} pavement at ${middle.x.toFixed(1)},${middle.y.toFixed(1)}`).toBe(false);
        }
      }
    }
    expect(asked).toBeGreaterThan(100);
  });

  it('leaves the sharp corner with a pavement that never crosses itself', () => {
    for (const piece of home.pavement) {
      for (const ring of [piece.region.outer, ...piece.region.holes]) expectSimple(ring);
    }
    // Down the middle of the sharp corner the two kerbs meet 18 m out and the
    // backs of the two pavements 28 m out. The junction's rounded kerb takes the
    // ground between, so the corner has no room for a pavement and has none.
    const bisector = (-17.5 * Math.PI) / 180;
    for (const d of [20, 23, 26]) {
      const p = { x: 60 + d * Math.cos(bisector), y: 60 + d * Math.sin(bisector) };
      expect(pieceAt(home, p), `${d} m down the corner`).toBeUndefined();
    }
  });

  it('meets the next chunk on the same places along the line they share', () => {
    const onLine = (chunk: WorldChunk): string[] =>
      chunk.pavement
        .flatMap((piece) => [piece.region.outer, ...piece.region.holes].flat())
        .filter((p) => Math.abs(p.x) < 1e-6)
        .map((p) => `${p.y.toFixed(3)}`)
        .sort(compareStrings);
    expect(onLine(home).length).toBeGreaterThan(0);
    expect(onLine(west)).toEqual(onLine(home));
  });

  it('stands on the road surface, faces up, and follows the ground in short edges', () => {
    for (const piece of home.pavement) {
      const mesh = pavementTriangles(piece, surfaceAt);
      if (mesh === undefined) continue;
      for (const v of mesh.vertices) expect(v.h).toBeCloseTo(surfaceAt(v.x, v.y, piece.tier) + vergeRise(piece.tier), 6);
      for (const [a, b, c] of mesh.faces) {
        const pa = mesh.vertices[a] as Point;
        const pb = mesh.vertices[b] as Point;
        const pc = mesh.vertices[c] as Point;
        expect((pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x)).toBeGreaterThan(0);
        for (const [p, q] of [[pa, pb], [pb, pc], [pc, pa]] as const) {
          expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThanOrEqual(PAVEMENT_EDGE + 1e-9);
        }
      }
      const geometry = pavementSurface(piece, home.bounds, surfaceAt);
      const normal = geometry?.getAttribute('normal');
      const index = geometry?.getIndex();
      const position = geometry?.getAttribute('position');
      if (normal === undefined || index === null || index === undefined || position === undefined) continue;
      // Every face of the mesh turns towards its own normal, the top up and
      // each face down an edge outwards.
      for (let i = 0; i + 2 < index.count; i += 3) {
        const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
        const ux = position.getX(b) - position.getX(a);
        const uy = position.getY(b) - position.getY(a);
        const uz = position.getZ(b) - position.getZ(a);
        const vx = position.getX(c) - position.getX(a);
        const vy = position.getY(c) - position.getY(a);
        const vz = position.getZ(c) - position.getZ(a);
        const facing = (uy * vz - uz * vy) * normal.getX(a) + (uz * vx - ux * vz) * normal.getY(a) + (ux * vy - uy * vx) * normal.getZ(a);
        expect(facing).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('counts the draw calls of a tier that reaches a chunk only through its pavement', () => {
    // A street three metres south of the line between two chunks: its run is
    // all in the chunk to the south, and its pavement reaches over the line.
    const beside = world([curve(0, [[-150, -3], [150, -3]])]);
    const cut = new ChunkSource(beside, buildLayers(beside)).chunk(0, 0);
    expect(cut.roads).toHaveLength(0);
    expect(cut.pavement.some((piece) => piece.tier === 'street')).toBe(true);
    expect(roadDrawCalls(cut)).toBeGreaterThan(0);
  });
});

/** True where two segments cross at a place neither of them ends at. */
function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (o: Point, p: Point, q: Point): number => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  return side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0;
}

/** Expects no edge of a closed ring to cross another edge of it that it does not touch. */
function expectSimple(ring: readonly Point[]): void {
  for (let i = 0; i < ring.length; i++) {
    for (let j = i + 2; j < ring.length; j++) {
      if (i === 0 && j === ring.length - 1) continue;
      expect(crosses(ring[i] as Point, ring[(i + 1) % ring.length] as Point, ring[j] as Point, ring[(j + 1) % ring.length] as Point)).toBe(false);
    }
  }
}

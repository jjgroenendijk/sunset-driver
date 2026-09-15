import { describe, expect, it } from 'vitest';
import {
  buildChunkLamps,
  LAMP_BY_TIER,
  LAMP_LENS,
  LAMP_POST,
  lampDrawCalls,
  lampGeometry,
  lampsIn,
  type Lamp,
} from '../src/render/lamp-mesh.ts';
import { LAMP_LIGHT_CAP, nearest } from '../src/render/lamps.ts';
import { SCENE_LIGHT_CAP } from '../src/render/sky.ts';
import { buildLayers, ChunkSource, CHUNK_SIZE } from '../src/world/chunks.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { RoadRibbons } from '../src/world/ribbon.ts';
import { footprintHalfWidth, TIERS } from '../src/world/tiers.ts';
import type { District, RoadCurve, RoadTier, WorldDescription, Zone } from '../src/world/types.ts';
import { withNodes } from './helpers.ts';

const SIZE = 1200;
const CELL = 10;

/** Metres two places may stand apart and still be one place. */
const TOLERANCE = 1e-6;

function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

function curve(id: number, coords: readonly [number, number][], tier: RoadTier): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [], nodes: [] };
}

/**
 * A hand-built world: a square island under a few long straight roads, so the
 * lamps can be checked against numbers worked out by hand. The ground tilts
 * across the map, so a lamp standing on the wrong bed would show in its height.
 */
function gridWorld(roads: RoadCurve[]): WorldDescription {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) {
      hf.set(ix, iy, 20 + hf.worldX(ix) * 0.02 + hf.worldY(iy) * 0.03);
    }
  }
  return {
    seed: 21,
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
    districts: [district(0, 'inner', 0, 0), district(1, 'suburban', 300, 300)],
    beaches: [],
    roads: withNodes(roads),
    corridors: [],
    tram: { route: [], edges: [], corridors: [], stops: [], crossings: [], length: 0 },
  };
}

/** Where each road runs: one straight line each way for three tiers. */
const END = 500;
const ROADS: RoadCurve[] = [
  curve(0, [[-END, 0], [END, 0]], 'arterial'),
  curve(1, [[0, -END], [0, END]], 'street'),
  curve(2, [[-END, 200], [END, 200]], 'alley'),
];

const world = gridWorld(ROADS);
const layers = buildLayers(world);
const source = new ChunkSource(world, layers);
const ribbons = new RoadRibbons(world.terrain, world.roads);

/** Chunks each way of the origin that cover the roads above. */
const REACH = Math.ceil(END / CHUNK_SIZE);

/** Every lamp of the map, taken a chunk at a time as the scene takes them. */
function allLamps(): Lamp[] {
  const out: Lamp[] = [];
  for (let cy = -REACH; cy <= REACH; cy++) {
    for (let cx = -REACH; cx <= REACH; cx++) out.push(...lampsIn(source.chunk(cx, cy), ribbons));
  }
  return out;
}

const lamps = allLamps();

/** How far a lamp stands from the centreline of the road it belongs to. */
function acrossOf(lamp: Lamp): number {
  return lamp.tier === 'street' ? Math.abs(lamp.x) : Math.abs(lamp.y);
}

/** How far along its road a lamp stands, measured from the start of the curve. */
function alongOf(lamp: Lamp): number {
  return lamp.tier === 'street' ? lamp.y + END : lamp.x + END;
}

describe('where the street lamps stand', () => {
  it('puts lamps on the lit tiers and none on the rest', () => {
    expect(lamps.length).toBeGreaterThan(0);
    for (const lamp of lamps) expect(LAMP_BY_TIER[lamp.tier]).toBeDefined();
    expect(lamps.some((lamp) => lamp.tier === 'arterial')).toBe(true);
    expect(lamps.some((lamp) => lamp.tier === 'street')).toBe(true);
    expect(lamps.some((lamp) => lamp.tier === 'alley')).toBe(false);
  });

  it('stands every mast clear of the carriageway and inside the ground the road claims', () => {
    for (const lamp of lamps) {
      const across = acrossOf(lamp);
      expect(across).toBeGreaterThan(TIERS[lamp.tier].width / 2);
      expect(across).toBeLessThanOrEqual(footprintHalfWidth(lamp.tier));
    }
  });

  it('reaches the lantern out over the road and hangs it at the top of the mast', () => {
    for (const lamp of lamps) {
      const spec = LAMP_BY_TIER[lamp.tier];
      if (spec === undefined) throw new Error(`${lamp.tier} carries no lamps`);
      const head = Math.hypot(lamp.headX - lamp.x, lamp.headY - lamp.y);
      expect(head).toBeCloseTo(spec.arm, 6);
      // The arm reaches toward the road, so the lantern is nearer its middle
      // than the mast is.
      expect(Math.hypot(lamp.headX - lamp.roadX, lamp.headY - lamp.roadY)).toBeLessThan(
        Math.hypot(lamp.x - lamp.roadX, lamp.y - lamp.roadY),
      );
      expect(lamp.headHeight - lamp.height).toBeGreaterThan(spec.mast - 0.5);
      expect(lamp.headHeight - lamp.height).toBeLessThanOrEqual(spec.mast);
      // The mast stands on the verge, which is at or a little above the bed.
      expect(lamp.height).toBeGreaterThanOrEqual(lamp.roadHeight);
      expect(lamp.height - lamp.roadHeight).toBeLessThan(1);
    }
  });

  it('spaces them by the tier, whatever chunk they land in', () => {
    for (const tier of ['arterial', 'street'] as const) {
      const spec = LAMP_BY_TIER[tier];
      if (spec === undefined) throw new Error(`${tier} carries no lamps`);
      const along = lamps.filter((lamp) => lamp.tier === tier).map(alongOf);
      expect(along.length).toBeGreaterThan(10);
      for (const at of along) {
        const off = Math.abs(at / spec.spacing - Math.round(at / spec.spacing));
        expect(off).toBeLessThan(1e-6);
      }
    }
  });

  it('gives a lit tier that is carried on both verges two lamps at each place', () => {
    const arterial = lamps.filter((lamp) => lamp.tier === 'arterial');
    const left = arterial.filter((lamp) => lamp.y > 0).map(alongOf).sort((a, b) => a - b);
    const right = arterial.filter((lamp) => lamp.y < 0).map(alongOf).sort((a, b) => a - b);
    expect(left).toEqual(right);

    // A street alternates instead, so one lamp stands at each place and the
    // side changes from one to the next.
    const street = lamps.filter((lamp) => lamp.tier === 'street').sort((a, b) => alongOf(a) - alongOf(b));
    for (let i = 1; i < street.length; i++) {
      const before = street[i - 1] as Lamp;
      const here = street[i] as Lamp;
      expect(Math.sign(here.x)).toBe(-Math.sign(before.x));
    }
  });

  it('never places one lamp twice, however the chunks cut the roads', () => {
    const seen = new Set<string>();
    for (const lamp of lamps) {
      const key = `${lamp.x.toFixed(3)},${lamp.y.toFixed(3)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('leaves the stretches the junctions take unlit', () => {
    // The roads above only cross on the map; these two share the point at the
    // origin, which is what makes a junction and cuts a gap out of each curve.
    const crossing = gridWorld([
      curve(0, [[-END, 0], [0, 0], [END, 0]], 'arterial'),
      curve(1, [[0, -END], [0, 0], [0, END]], 'street'),
    ]);
    const met = buildLayers(crossing);
    const cut = new ChunkSource(crossing, met);
    const frames = new RoadRibbons(crossing.terrain, crossing.roads, met.junctions);
    expect(met.junctions.junctions).toHaveLength(1);
    const gaps = met.junctions.gaps;
    expect(gaps.some((list) => list !== undefined && list.length > 0)).toBe(true);

    let complaint: string | undefined;
    let lit = 0;
    for (let cy = -REACH; cy <= REACH; cy++) {
      for (let cx = -REACH; cx <= REACH; cx++) {
        for (const lamp of lampsIn(cut.chunk(cx, cy), frames)) {
          lit++;
          // The arterial runs along x and the street along y, and each is one
          // curve, so the distance along it is the distance from its start.
          const curveId = lamp.tier === 'street' ? 1 : 0;
          const at = curveId === 1 ? lamp.y + END : lamp.x + END;
          for (const gap of gaps[curveId] ?? []) {
            if (at >= gap.from.distance && at <= gap.to.distance) {
              complaint ??= `${lamp.tier} lamp ${at} m along stands in the junction from ${gap.from.distance} to ${gap.to.distance}`;
            }
          }
        }
      }
    }
    expect(lit).toBeGreaterThan(10);
    expect(complaint).toBeUndefined();
  });

  it('answers the same lamps however many times a chunk is asked for', () => {
    const once = lampsIn(source.chunk(0, 0), ribbons);
    const again = lampsIn(source.chunk(0, 0), ribbons);
    expect(again).toEqual(once);
  });
});

describe('the lamps of a chunk, as geometry', () => {
  it('shares one geometry per tier and a place for each lamp', () => {
    const chunk = source.chunk(0, 0);
    const here = lampsIn(chunk, ribbons);
    const tiers = buildChunkLamps(here);
    const placed = tiers.reduce((sum, tier) => sum + tier.matrices.length, 0);
    expect(placed).toBe(here.length);
    for (const tier of tiers) {
      expect(tier.matrices.length).toBeGreaterThan(0);
      expect(tier.geometry.getAttribute('part')).toBeDefined();
      tier.geometry.dispose();
    }
  });

  it('costs one batch where a lit tier runs and nothing where none does', () => {
    let lit = 0;
    let unlit = 0;
    for (let cy = -REACH; cy <= REACH; cy++) {
      for (let cx = -REACH; cx <= REACH; cx++) {
        const chunk = source.chunk(cx, cy);
        const calls = lampDrawCalls(chunk);
        expect(calls).toBeLessThanOrEqual(1);
        // The count is answered off the chunk alone, so it may promise a batch
        // a bridged run then leaves empty; it never promises fewer.
        expect(calls).toBeGreaterThanOrEqual(Math.min(1, lampsIn(chunk, ribbons).length));
        if (calls === 1) lit++;
        else unlit++;
      }
    }
    expect(lit).toBeGreaterThan(0);
    expect(unlit).toBeGreaterThan(0);
  });

  it('builds a mast with a lantern on the end of its arm', () => {
    for (const tier of ['highway', 'arterial', 'street'] as const) {
      const spec = LAMP_BY_TIER[tier];
      if (spec === undefined) throw new Error(`${tier} carries no lamps`);
      const geometry = lampGeometry(spec);
      const part = geometry.getAttribute('part');
      const kinds = new Set<number>();
      for (let v = 0; v < part.count; v++) kinds.add(part.getX(v));
      expect([...kinds].sort()).toEqual([LAMP_POST, LAMP_LENS]);

      // Nothing reaches past the arm, back behind the mast, under the ground or
      // over the top of the mast.
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (box === null) throw new Error('a lamp with no geometry');
      expect(box.min.x).toBeGreaterThan(-1);
      expect(box.max.x).toBeLessThanOrEqual(spec.arm + 0.5);
      expect(box.min.y).toBeGreaterThanOrEqual(-TOLERANCE);
      expect(box.max.y).toBeLessThanOrEqual(spec.mast + TOLERANCE);
      geometry.dispose();
    }
  });
});

describe('the light the lamps are given', () => {
  it('fits the scene inside its light cap', () => {
    // The sun and the sky fill are the other two (spec section 10.5).
    expect(2 + LAMP_LIGHT_CAP).toBeLessThanOrEqual(SCENE_LIGHT_CAP);
  });

  it('hands the pool to the nearest lamps, nearest first', () => {
    const chosen = nearest(0, 0, [lamps]);
    expect(chosen.length).toBe(LAMP_LIGHT_CAP);
    for (let i = 1; i < chosen.length; i++) {
      const before = chosen[i - 1] as Lamp;
      const here = chosen[i] as Lamp;
      expect(Math.hypot(here.headX, here.headY)).toBeGreaterThanOrEqual(Math.hypot(before.headX, before.headY));
    }
    // Nothing outside the pool is nearer than anything inside it.
    const worst = Math.hypot((chosen[chosen.length - 1] as Lamp).headX, (chosen[chosen.length - 1] as Lamp).headY);
    for (const lamp of lamps) {
      if (chosen.includes(lamp)) continue;
      expect(Math.hypot(lamp.headX, lamp.headY)).toBeGreaterThanOrEqual(worst - TOLERANCE);
    }
  });

  it('takes fewer than the cap where there are fewer lamps, and none from nothing', () => {
    expect(nearest(0, 0, []).length).toBe(0);
    expect(nearest(0, 0, [lamps.slice(0, 3)]).length).toBe(3);
  });
});

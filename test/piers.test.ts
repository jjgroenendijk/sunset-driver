import { Box3 } from 'three';
import { describe, expect, it } from 'vitest';
import { pierGeometry } from '../src/render/corridor-mesh.ts';
import { buildChunkRoads, roadDrawCalls, TIER_ORDER } from '../src/render/road-mesh.ts';
import {
  DECK_DEPTH,
  SKIRT,
  SURFACE_CROSSING,
  SURFACE_RAIL,
  SURFACE_RAISE,
  SURFACE_STRUCTURE,
  SURFACE_TRAM_LANE,
} from '../src/render/road-section.ts';
import { buildLayers, chunkAt, ChunkSource } from '../src/world/chunks.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { deckPiers } from '../src/world/piers.ts';
import { RoadRibbons } from '../src/world/ribbon.ts';
import { footprintHalfWidth, TIERS } from '../src/world/tiers.ts';
import { tramTrack } from '../src/world/tram-track.ts';
import type { Corridor, RoadCurve, RoadTier } from '../src/world/types.ts';
import { curve, dip, FLAT, ringDistricts, ringRoads, viaduct, world, worldOf } from './corridor-fixture.ts';

describe('piers', () => {
  it('stands the piers of a deck over water in the water, in pairs across the deck', () => {
    const w = worldOf(world(dip(-5), []), [viaduct([1, 2])]);
    const piers = deckPiers(w);
    const hf = new Heightfield(w.terrain);
    // 200 m of deck in bays of about 25 m: seven bays inside the abutments, a pair at each.
    expect(piers.length).toBe(14);
    for (const pier of piers) {
      expect(hf.sample(pier.x, pier.y), `${pier.x},${pier.y}`).toBeLessThan(w.water.seaLevel);
      expect([1, 2]).toContain(pier.segment);
      expect(Math.abs(pier.across)).toBeGreaterThan(0);
      expect(Math.abs(pier.across)).toBeLessThan(TIERS.highway.width / 2);
    }
  });

  it('takes the piers of a deck over land from the corridor under it', () => {
    const w = worldOf(world(dip(2), []), [viaduct([1, 2])]);
    const corridor = w.corridors[0] as Corridor;
    expect(deckPiers(w).map((pier) => ({ x: pier.x, y: pier.y }))).toEqual(corridor.pillars);
  });

  it('stands no pier on a street that passes under the deck', () => {
    const street = curve(1, 'street', [
      [-50, -150],
      [-50, 150],
    ]);
    const w = worldOf(world(dip(2), []), [viaduct([1, 2]), street]);
    const piers = deckPiers(w);
    // The bay over the street loses its pair, and no other bay does.
    expect(piers.length).toBe(12);
    for (const pier of piers) expect(Math.abs(pier.x + 50)).toBeGreaterThan(footprintHalfWidth('street'));
  });

  it('builds a column from under the ground up into the underside of the deck', () => {
    const w = worldOf(world(dip(-5), []), [viaduct([1, 2])]);
    const ribbons = new RoadRibbons(w.terrain, w.roads);
    const pier = deckPiers(w)[0] as ReturnType<typeof deckPiers>[number];
    const ground = -5;
    const geometry = pierGeometry({ ...pier, tier: 'highway', ground }, ribbons);
    expect(geometry).toBeDefined();
    const box = new Box3().setFromBufferAttribute(geometry?.getAttribute('position') as never);
    const frame = ribbons.frameAt(pier.curve, pier.segment, pier.x, pier.y);
    const soffit = frame.height + frame.bank * pier.across - SKIRT - DECK_DEPTH;
    expect(box.min.y).toBeLessThan(ground);
    expect(box.max.y).toBeGreaterThan(soffit);
    expect(box.max.y).toBeLessThan(soffit + 0.5);
    // Centred on the foot, in the scene's x and z.
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(pier.x, 3);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(pier.y, 3);
    expect(geometry?.getAttribute('kind').getX(0)).toBe(SURFACE_STRUCTURE);
  });

  it('draws no column under a deck that stands on the ground', () => {
    const w = worldOf(world(dip(-5), []), [viaduct([1, 2])]);
    const ribbons = new RoadRibbons(w.terrain, w.roads);
    const pier = deckPiers(w)[0] as ReturnType<typeof deckPiers>[number];
    const frame = ribbons.frameAt(pier.curve, pier.segment, pier.x, pier.y);
    expect(pierGeometry({ ...pier, tier: 'highway', ground: frame.height }, ribbons)).toBeUndefined();
  });
});

describe('the tram track', () => {
  it('lays the track down every segment of the loop and none of the street', () => {
    const roads = ringRoads();
    const w = worldOf(world(FLAT, ringDistricts()), roads);
    const track = tramTrack(w, buildRoadGraph(w.roads));
    for (const road of roads) {
      const mask = track.segments[road.id];
      if (road.tier === 'arterial') expect(Array.from(mask ?? []), `road ${road.id}`).toEqual([1, 1]);
      else expect(mask).toBeUndefined();
    }
  });

  it('turns each level crossing along the track it lies on', () => {
    const w = worldOf(world(FLAT, ringDistricts()), ringRoads());
    const track = tramTrack(w, buildRoadGraph(w.roads));
    expect(track.crossings.length).toBe(1);
    const crossing = track.crossings[0] as (typeof track.crossings)[number];
    expect(crossing.tier).toBe('arterial');
    // The street meets the south side of the ring, which runs along x.
    expect(Math.abs(crossing.alongX)).toBeCloseTo(1);
    expect(crossing.alongY).toBeCloseTo(0);
  });

  it('lays no track where the world runs no tram', () => {
    const roads: RoadCurve[] = [viaduct([])];
    const w0 = worldOf(world(FLAT, []), roads);
    const track = tramTrack(w0, buildRoadGraph(w0.roads));
    expect(track.segments.every((mask) => mask === undefined)).toBe(true);
    expect(track.crossings).toEqual([]);
  });
});

describe('the corridors of a chunk', () => {
  const w = worldOf(world(FLAT, ringDistricts()), ringRoads());
  const layers = buildLayers(w);
  const source = new ChunkSource(w, layers);
  const surfaceAt = (x: number, y: number, tier: RoadTier): number => layers.carve.surfaceAt(x, y, tier);

  it('lays the lane, the rails and the level crossing in the batch of the arterial they run down', () => {
    const { cx, cy } = chunkAt(0, -300);
    const chunk = source.chunk(cx, cy);
    expect(chunk.tram.length).toBeGreaterThan(0);
    expect(chunk.tramCrossings.length).toBe(1);
    const tiers = buildChunkRoads(chunk, layers.carve.ribbons, surfaceAt);
    const kinds = new Set<number>();
    for (const tier of tiers) {
      for (const part of tier.corridors) {
        expect(tier.tier).toBe('arterial');
        const kind = part.getAttribute('kind');
        for (let v = 0; v < kind.count; v++) kinds.add(kind.getX(v));
      }
    }
    expect([...kinds].sort()).toEqual([SURFACE_TRAM_LANE, SURFACE_RAIL, SURFACE_CROSSING].sort());
    // The corridors add parts to a tier the chunk already draws, and no draw call.
    const drawn = TIER_ORDER.filter((tier) => chunk.roads.some((run) => run.tier === tier) || chunk.pavement.some((p) => p.tier === tier));
    expect(tiers.map((tier) => tier.tier)).toEqual(drawn);
    expect(roadDrawCalls(chunk)).toBe(roadDrawCalls({ ...chunk, tram: [], tramCrossings: [], piers: [] }));
  });

  it('paints no line inside the lane where the track runs, and keeps the lines outside it', () => {
    const { cx, cy } = chunkAt(0, -300);
    const chunk = source.chunk(cx, cy);
    const ribbons = layers.carve.ribbons;
    const paintOf = (tram: typeof chunk.tram): Float32Array =>
      (buildChunkRoads({ ...chunk, tram }, ribbons, surfaceAt).find((tier) => tier.tier === 'arterial')?.markings ??
        new Float32Array(0));
    const bare = paintOf(chunk.tram);
    const painted = paintOf([]);
    expect(bare.length).toBeGreaterThan(0);
    expect(bare.length).toBeLessThan(painted.length);
  });

  it('lays the lane over the carriageway, never under it', () => {
    const { cx, cy } = chunkAt(0, -300);
    const chunk = source.chunk(cx, cy);
    const ribbons = layers.carve.ribbons;
    const arterial = buildChunkRoads(chunk, ribbons, surfaceAt).find((tier) => tier.tier === 'arterial');
    for (const part of arterial?.corridors ?? []) {
      const position = part.getAttribute('position');
      const kind = part.getAttribute('kind');
      for (let v = 0; v < position.count; v++) {
        if (kind.getX(v) !== SURFACE_TRAM_LANE) continue;
        const x = position.getX(v);
        const y = position.getZ(v);
        expect(position.getY(v)).toBeGreaterThan(surfaceAt(x, y, 'arterial') + SURFACE_RAISE);
      }
    }
  });
});

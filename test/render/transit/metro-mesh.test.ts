import { BufferAttribute, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { metroStairGeometry, SIGN_GLOW, stairPlace, stairsIn } from '../../../src/render/transit/metro-mesh.ts';
import type { MetroEntrance } from '../../../src/world/transit/metro.ts';
import { vergeRise } from '../../../src/render/roads/road-section.ts';
import type { WorldChunk } from '../../../src/world/chunks.ts';

/** A chunk covering 0..100 each way, which is all `stairsIn` reads of one. */
const CHUNK = { bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 } } as unknown as WorldChunk;

function entrance(x: number, y: number, heading = 0): MetroEntrance {
  return { station: 0, district: 0, x, y, heading, tier: 'street' };
}

/** Spec section 13.3: the stairs down to a station, and where a chunk draws them. */
describe('metro entrance mesh', () => {
  it('draws the entrances standing in the chunk and no others', () => {
    const inside = entrance(40, 60);
    const outside = entrance(140, 60);
    const [stair, ...rest] = stairsIn(CHUNK, [inside, outside], () => 12);
    expect(rest).toEqual([]);
    // The stairs stand on the kerb, which is the road bed plus the rise of the
    // pavement it is laid on.
    expect(stair).toEqual({ x: 40, y: 60, height: 12 + vergeRise('street'), heading: 0 });
  });

  it('stands the stairs on the surface of the road the entrance belongs to', () => {
    const asked: string[] = [];
    stairsIn(CHUNK, [{ ...entrance(10, 10), tier: 'arterial' }], (x, y, tier) => {
      asked.push(`${x},${y},${tier}`);
      return 3;
    });
    expect(asked).toEqual(['10,10,arterial']);
  });

  it('turns the mouth of the well along the road and the sign toward it', () => {
    // The frame is +x toward the road, so an entrance facing north puts its
    // mouth along the road, which runs east to west.
    const place = stairPlace({ x: 5, y: 7, height: 2, heading: Math.PI / 2 });
    const toward = new Vector3(1, 0, 0).transformDirection(place);
    expect(toward.x).toBeCloseTo(0);
    expect(toward.z).toBeCloseTo(1);
    expect(new Vector3().setFromMatrixPosition(place).toArray()).toEqual([5, 2, 7]);
  });

  it('paints every vertex and burns the sign alone after dark', () => {
    const geometry = metroStairGeometry();
    const position = geometry.getAttribute('position') as BufferAttribute;
    const colour = geometry.getAttribute('color') as BufferAttribute;
    const glow = geometry.getAttribute('glow') as BufferAttribute;
    expect(colour.count).toBe(position.count);
    expect(glow.count).toBe(position.count);
    const lit = [...(glow.array as Float32Array)].filter((amount) => amount > 0);
    expect(new Set(lit)).toEqual(new Set([SIGN_GLOW]));
    // The plate is one box of the fourteen the entrance is built from, so most
    // of it stays dark whatever the hour.
    expect(lit.length).toBeLessThan(position.count / 4);
  });

  it('keeps the whole entrance above the pavement, since nothing under the ground is drawn', () => {
    const position = metroStairGeometry().getAttribute('position') as BufferAttribute;
    let lowest = Infinity;
    for (let i = 0; i < position.count; i++) lowest = Math.min(lowest, position.getY(i));
    // Float32 rounds the base of a box a hair under the pavement, not into it.
    expect(lowest).toBeCloseTo(0);
    expect(lowest).toBeGreaterThan(-1e-6);
  });
});

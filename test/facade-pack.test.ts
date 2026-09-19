import type { BufferAttribute } from 'three';
import { SkyscraperGenerator } from 'three/examples/jsm/generators/city/SkyscraperGenerator.js';
import { describe, expect, it } from 'vitest';
import type { PackedAttribute, PackedGeometry } from '../src/render/chunk-payload.ts';
import { packFacade } from '../src/render/facade-pack.ts';

/** A small generated tower, as the worker takes it: its arrays and no index. */
function tower(): PackedGeometry {
  const geometry = new SkyscraperGenerator({
    seed: 11,
    totalHeight: 40,
    floorHeight: 4,
    bayWidth: 4,
    footprint: { width: 16, depth: 12 },
  }).build().geometry;
  const count = geometry.getAttribute('position').count;
  const tints = new Float32Array(count * 3).fill(0.4);
  const attributes: PackedAttribute[] = [{ name: 'tint', array: tints, itemSize: 3, normalized: false }];
  for (const name of ['position', 'normal', 'uv', 'partId', 'roomCenter', 'roomSize']) {
    const attribute = geometry.getAttribute(name) as BufferAttribute;
    attributes.push({ name, array: attribute.array as Float32Array, itemSize: attribute.itemSize, normalized: false });
  }
  return { attributes };
}

const find = (geometry: PackedGeometry, name: string): PackedAttribute =>
  geometry.attributes.find((attribute) => attribute.name === name) as PackedAttribute;

describe('packFacade', () => {
  const before = tower();
  const count = find(before, 'position').array.length / 3;
  const after = packFacade(before);
  const index = after.index as Uint16Array | Uint32Array;
  const kept = find(after, 'position').array.length / 3;

  it('stores a vertex in 44 bytes and a shared vertex once', () => {
    let bytes = 0;
    for (const attribute of after.attributes) bytes += attribute.array.byteLength;
    expect(bytes / kept).toBe(44);
    // A quad is two triangles over four corners, not six.
    expect(kept).toBeLessThan(count * 0.75);
    expect(index.length).toBe(count);
  });

  it('draws every triangle through the index as the generator built it', () => {
    const fields: [string, number][] = [
      ['position', 0],
      ['roomCenter', 0],
      ['partId', 0],
      // A byte holds a direction to a 254th and a colour to a 510th.
      ['normal', 1 / 254],
      ['tint', 1 / 510],
      // A half float is exact to a part in 2048 of its size.
      ['uv', 20 / 2048],
      ['roomSize', 11 / 2048],
    ];
    let complaint: string | undefined;
    for (const [name, tolerance] of fields) {
      const was = find(before, name);
      const now = find(after, name);
      const scale = now.normalized ? (now.array instanceof Int8Array ? 127 : 255) : 1;
      for (let v = 0; v < count; v++) {
        const at = index[v] as number;
        for (let k = 0; k < was.itemSize; k++) {
          const expected = was.array[v * was.itemSize + k] as number;
          const got = (now.array[at * now.itemSize + k] as number) / scale;
          if (Math.abs(got - expected) > tolerance) complaint ??= `${name} of vertex ${v} is ${got}, not ${expected}`;
        }
      }
    }
    expect(complaint).toBeUndefined();
  });
});

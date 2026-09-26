import type { BufferAttribute } from 'three';
import { SkyscraperGenerator } from 'three/examples/jsm/generators/city/SkyscraperGenerator.js';
import { describe, expect, it } from 'vitest';
import type { PackedAttribute, PackedGeometry } from '../src/render/chunk-payload.ts';
import { FINISH_STEP, finishCode, finishOf } from '../src/render/building-finish.ts';
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
  // The finish of one building is the same three numbers on every vertex of it
  // (`building-finish.ts`), as its colour is.
  const code = finishCode(finishOf('tower', 'masonry', 11, 0.7));
  const finishes = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) finishes.set(code, v * 3);
  const attributes: PackedAttribute[] = [
    { name: 'tint', array: tints, itemSize: 3, normalized: false },
    { name: 'finish', array: finishes, itemSize: 3, normalized: false },
  ];
  for (const name of ['position', 'normal', 'uv', 'partId', 'roomCenter', 'roomSize']) {
    const attribute = geometry.getAttribute(name) as BufferAttribute;
    attributes.push({ name, array: attribute.array as Float32Array, itemSize: attribute.itemSize, normalized: false });
  }
  return { attributes };
}

const find = (geometry: PackedGeometry, name: string): PackedAttribute =>
  geometry.attributes.find((attribute) => attribute.name === name) as PackedAttribute;

/** What a stored number of an attribute is divided by to read it: its byte's range when normalised. */
function scaleOf(attribute: PackedAttribute): number {
  if (!attribute.normalized) return 1;
  return attribute.array instanceof Int8Array ? 127 : 255;
}

describe('packFacade', () => {
  const before = tower();
  const count = find(before, 'position').array.length / 3;
  const after = packFacade(before);
  const index = after.index as Uint16Array | Uint32Array;
  const kept = find(after, 'position').array.length / 3;

  it('stores a vertex in 48 bytes and a shared vertex once', () => {
    let bytes = 0;
    for (const attribute of after.attributes) bytes += attribute.array.byteLength;
    expect(bytes / kept).toBe(48);
    // A quad is two triangles over four corners, not six.
    expect(kept).toBeLessThan(count * 0.75);
    expect(index).toHaveLength(count);
  });

  it('draws every triangle through the index as the generator built it', () => {
    const fields: [string, number][] = [
      ['position', 0],
      ['roomCenter', 0],
      ['partId', 0],
      // A byte holds a direction to a 254th and a colour to a 510th.
      ['normal', 1 / 254],
      ['tint', 1 / 510],
      ['finish', 1 / 510],
      // A half float is exact to a part in 2048 of its size.
      ['uv', 20 / 2048],
      ['roomSize', 11 / 2048],
    ];
    let complaint: string | undefined;
    for (const [name, tolerance] of fields) {
      const was = find(before, name);
      const now = find(after, name);
      const scale = scaleOf(now);
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

  it('carries the wall and the window light through a byte unchanged', () => {
    // The first channel of a finish is a whole number stepped by `FINISH_STEP`,
    // so a byte holds it exactly and the material reads back the material and
    // the light the building was given, not a neighbouring pair.
    const packed = find(after, 'finish');
    const code = finishCode(finishOf('tower', 'masonry', 11, 0.7));
    expect(packed.normalized).toBe(true);
    for (let v = 0; v < kept; v++) {
      const byte = packed.array[v * packed.itemSize] as number;
      expect(Math.round((byte / 255) * (255 / FINISH_STEP))).toBe(Math.round((code[0] * 255) / FINISH_STEP));
    }
  });
});

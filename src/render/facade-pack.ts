/**
 * A generated facade, packed small for the GPU (spec section 9.1).
 *
 * Facades are most of what the city draws: 7.6 million vertices on the core of
 * seed `sunset`, 85 % of all vertex data. The generator writes each vertex as 36
 * floats, 144 bytes, and builds its triangles with no index, so a quad is six
 * vertices where four would do. Packed here, in the worker, a vertex is 44
 * bytes and a vertex shared by two triangles is stored once.
 *
 * - `position` and `roomCenter` stay 32-bit floats, because they are places in
 *   the world.
 * - `normal` is four signed bytes, and `tint` and `finish` four unsigned ones,
 *   read back as floats in -1..1 and 0..1. WebGPU reads a vertex in steps of
 *   four bytes, so the fourth byte is padding. A finish is a whole number
 *   stepped by `FINISH_STEP` (`building-finish.ts`) for that reason: a step
 *   that wide is a code a byte carries exactly.
 * - `uv` and `roomSize` are half floats. The facade's `uv` stays within ±20 and
 *   the room within 11 m, where a half float still resolves a sixtieth of a
 *   unit. It is a `Float16Array` and never a `Float16BufferAttribute`: three.js
 *   0.186 widens a `Uint16Array` it is not told is normalised into 32-bit
 *   integers on upload, which the half-float layout then misreads.
 * - `partId` stays a 32-bit float, the one width WebGPU reads a single number
 *   at.
 *
 * Every other attribute a facade might carry is kept as it is.
 */
import type { GeometryArray, PackedAttribute, PackedGeometry } from './chunk-payload.ts';

/** The half-float array, where the engine has one. Without it `uv` and `roomSize` stay 32-bit. */
const Half = typeof Float16Array === 'undefined' ? undefined : Float16Array;

/** Pack a facade's attributes, then index it over the vertices that are now the same. */
export function packFacade(geometry: PackedGeometry): PackedGeometry {
  const attributes = geometry.attributes.map(packAttribute);
  if (geometry.index !== undefined) return { attributes, index: geometry.index };
  return indexed(attributes);
}

function packAttribute(attribute: PackedAttribute): PackedAttribute {
  const { name, array, itemSize } = attribute;
  if (!(array instanceof Float32Array)) return attribute;
  if (name === 'normal' && itemSize === 3) {
    const out = new Int8Array((array.length / 3) * 4);
    // A unit normal is within ±1, so each byte is within ±127 and needs no clamp.
    for (let v = 0, at = 0; v < array.length; v += 3, at += 4) {
      for (let k = 0; k < 3; k++) {
        const x = (array[v + k] as number) * 127;
        out[at + k] = x < 0 ? x - 0.5 : x + 0.5;
      }
    }
    return { name, array: out, itemSize: 4, normalized: true };
  }
  if ((name === 'tint' || name === 'finish') && itemSize === 3) {
    // A clamped array rounds and clamps as it is written.
    const out = new Uint8ClampedArray((array.length / 3) * 4);
    for (let v = 0, at = 0; v < array.length; v += 3, at += 4) {
      out[at] = (array[v] as number) * 255;
      out[at + 1] = (array[v + 1] as number) * 255;
      out[at + 2] = (array[v + 2] as number) * 255;
    }
    return { name, array: new Uint8Array(out.buffer), itemSize: 4, normalized: true };
  }
  if ((name === 'uv' || name === 'roomSize') && Half !== undefined) {
    return { name, array: new Half(array), itemSize, normalized: false };
  }
  return attribute;
}

/**
 * Store each distinct vertex once and draw the triangles through an index.
 * Two vertices are the same when every byte of every attribute is: a quad's
 * two triangles share two corners that way, and a corner of a box is three
 * vertices still, because its three faces carry three normals.
 */
function indexed(attributes: PackedAttribute[]): PackedGeometry {
  const words = attributes.map((attribute) => wordsOf(attribute.array));
  const strides = attributes.map((attribute) => (attribute.itemSize * attribute.array.BYTES_PER_ELEMENT) / 4);
  const at = attributes.findIndex((attribute) => attribute.name === 'position');
  const position = words[at];
  const normal = words[attributes.findIndex((attribute) => attribute.name === 'normal')];
  const count = position === undefined ? 0 : position.length / (strides[at] as number);
  if (position === undefined || normal === undefined || count === 0) return { attributes };

  const index = new Uint32Array(count);
  // Open addressing, at most half full. Each slot holds a kept vertex plus one.
  let size = 1024;
  while (size < count * 2) size *= 2;
  const slots = new Int32Array(size);
  const kept = new Int32Array(count);
  let unique = 0;
  for (let v = 0; v < count; v++) {
    // The place and the facing tell nearly every vertex apart. The rest of a
    // vertex is compared only when two of them land on the same slot.
    let hash = Math.imul(position[v * 3] as number, 0x9e3779b1);
    hash = Math.imul(hash ^ (position[v * 3 + 1] as number), 0x85ebca6b);
    hash = Math.imul(hash ^ (position[v * 3 + 2] as number), 0xc2b2ae35);
    hash = Math.imul(hash ^ (normal[v] as number), 0x27d4eb2f);
    hash ^= hash >>> 15;
    let slot = hash & (size - 1);
    for (;;) {
      const held = slots[slot] as number;
      if (held === 0) {
        slots[slot] = unique + 1;
        kept[unique] = v;
        index[v] = unique++;
        break;
      }
      if (same(words, strides, kept[held - 1] as number, v)) {
        index[v] = held - 1;
        break;
      }
      slot = (slot + 1) & (size - 1);
    }
  }

  const packed = attributes.map((attribute, a) => {
    const w = words[a] as Int32Array;
    const s = strides[a] as number;
    const out = new Int32Array(unique * s);
    for (let u = 0, to = 0; u < unique; u++) {
      for (let k = (kept[u] as number) * s, end = k + s; k < end; k++) out[to++] = w[k] as number;
    }
    const Type = attribute.array.constructor as new (buffer: ArrayBuffer) => GeometryArray;
    return { ...attribute, array: new Type(out.buffer) };
  });
  return { attributes: packed, index: unique > 65535 ? index : new Uint16Array(index) };
}

/** An attribute's bytes read four at a time. Every packed attribute is a whole number of words a vertex. */
function wordsOf(array: GeometryArray): Int32Array {
  return new Int32Array(array.buffer, array.byteOffset, array.byteLength / 4);
}

function same(words: readonly Int32Array[], strides: readonly number[], a: number, b: number): boolean {
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as Int32Array;
    const s = strides[i] as number;
    for (let k = 0; k < s; k++) if (w[a * s + k] !== w[b * s + k]) return false;
  }
  return true;
}

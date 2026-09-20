/**
 * The grade's cube must reach the GPU as one copy of the whole texture.
 *
 * Written slice by slice, as three.js writes a `Data3DTexture`, each write is
 * partial, and some Dawn builds refuse a partial write to a 3D texture and
 * leave the cube zeroed — a black frame. This holds the shape of the copy, so
 * nobody puts the slices back.
 */
import { describe, expect, it } from 'vitest';
import { Data3DTexture } from 'three';
import { LUT_LENGTH, LUT_SIZE } from '../src/render/grade.ts';
import { uploadLut, type LutRenderer } from '../src/render/lut-upload.ts';

interface Write {
  destination: { texture: unknown };
  data: ArrayBufferView;
  layout: { bytesPerRow?: number; rowsPerImage?: number };
  size: { width: number; height: number; depthOrArrayLayers?: number };
}

/** A renderer that records what it was asked to write, and to what. */
function fakeRenderer(allocates = true): {
  renderer: LutRenderer;
  writes: Write[];
  allocations: { count: number };
} {
  const writes: Write[] = [];
  const allocations = { count: 0 };
  const renderer = {
    backend: {
      device: {
        queue: {
          writeTexture: (
            destination: Write['destination'],
            data: Write['data'],
            layout: Write['layout'],
            size: Write['size'],
          ) => {
            writes.push({ destination, data, layout, size });
          },
        },
      },
      get: () => (allocates ? { texture: { label: 'lut' } } : {}),
    },
    initTexture: () => {
      allocations.count++;
    },
  };
  return { renderer: renderer as unknown as LutRenderer, writes, allocations };
}

function lutTexture(): Data3DTexture {
  return new Data3DTexture(new Uint16Array(LUT_LENGTH), LUT_SIZE, LUT_SIZE, LUT_SIZE);
}

describe('uploadLut', () => {
  it('writes the whole cube in one copy', () => {
    const { renderer, writes } = fakeRenderer();
    const lut = lutTexture();

    expect(uploadLut(renderer, lut)).toBe(true);
    expect(writes).toHaveLength(1);
    const [write] = writes;
    expect(write?.size).toEqual({
      width: LUT_SIZE,
      height: LUT_SIZE,
      depthOrArrayLayers: LUT_SIZE,
    });
    // Four channels of half float an entry, and a whole slice between depths.
    expect(write?.layout).toEqual({ bytesPerRow: LUT_SIZE * 8, rowsPerImage: LUT_SIZE });
    expect(write?.data).toBe(lut.image.data);
  });

  it('asks the renderer to allocate the texture before writing to it', () => {
    const { renderer, allocations } = fakeRenderer();
    expect(uploadLut(renderer, lutTexture())).toBe(true);
    expect(allocations.count).toBe(1);
  });

  it('reports failure when the backend made no texture', () => {
    const { renderer, writes } = fakeRenderer(false);
    expect(uploadLut(renderer, lutTexture())).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('reports failure when there is no WebGPU device', () => {
    const renderer = { backend: {}, initTexture: () => {} } as unknown as LutRenderer;
    expect(uploadLut(renderer, lutTexture())).toBe(false);
  });
});

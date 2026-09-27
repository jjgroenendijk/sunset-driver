import type { BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { BLOCK_CURTAIN, BLOCK_WALL, Shell } from '../../../src/render/buildings/block-shell.ts';

/** Each vertex of a shell as its place and its `uv`. */
function vertices(shell: Shell): { p: number[]; uv: number[] }[] {
  const geometry = shell.geometry([0.5, 0.5, 0.5]);
  const position = geometry.getAttribute('position') as BufferAttribute;
  const uv = geometry.getAttribute('uv') as BufferAttribute;
  return Array.from({ length: position.count }, (_, i) => ({
    p: [position.getX(i), position.getY(i), position.getZ(i)],
    uv: [uv.getX(i), uv.getY(i)],
  }));
}

describe('Shell uv', () => {
  // The material draws a curtain wall's panes off these metres, so a triangle
  // laid out on other metres cuts every storey of panes along its diagonal.
  it('lays both triangles of a wall on the same metres along and up it', () => {
    const shell = new Shell();
    shell.quad([-6, 2, 4], [6, 2, 4], [6, 50, 4], [-6, 50, 4], BLOCK_CURTAIN);
    const all = vertices(shell);
    expect(all).toHaveLength(6);
    for (const { p, uv } of all) {
      expect(uv[0]).toBeCloseTo((p[0] as number) + 6, 5);
      expect(uv[1]).toBeCloseTo((p[1] as number) - 2, 5);
    }
  });

  it('measures a gable end up the wall, with its apex in the middle', () => {
    const shell = new Shell();
    shell.triangle([-5, 3, 2], [5, 3, 2], [0, 7, 2], BLOCK_WALL);
    const apex = vertices(shell)[2];
    expect(apex?.uv[0]).toBeCloseTo(5, 5);
    expect(apex?.uv[1]).toBeCloseTo(4, 5);
  });
});

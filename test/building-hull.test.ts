import { BoxGeometry, BufferAttribute, BufferGeometry, type Box3 } from 'three';
import { describe, expect, it } from 'vitest';
import { hullOf, OUTLINE_WIDTH } from '../src/render/building-hull.ts';
import type { BuildingShape } from '../src/render/building-shape.ts';

/** A plain box of a shape, which lays the hull out on the footprint's rectangle. */
const BOX: BuildingShape = { plan: 'box', parts: [], floorHeight: 4, bayWidth: 4.2 };

/** Metres a place may stand off where it should and still be there. */
const TOLERANCE = 0.01;

/** A box standing on `from`, as the unindexed triangles a shell is made of. */
function box(width: number, depth: number, from: number, to: number): number[] {
  const geometry = new BoxGeometry(width, to - from, depth).toNonIndexed();
  geometry.translate(0, (from + to) / 2, 0);
  return Array.from(geometry.getAttribute('position').array);
}

/** The shell as the builder hands it over, and the hull it is outlined with. */
function hullAround(...parts: number[][]): { hull: BufferGeometry; bounds: Box3 } {
  const shell = new BufferGeometry();
  shell.setAttribute('position', new BufferAttribute(new Float32Array(parts.flat()), 3));
  shell.computeBoundingBox();
  const bounds = shell.boundingBox as Box3;
  const massing = {
    width: bounds.max.x - bounds.min.x,
    depth: bounds.max.z - bounds.min.z,
    height: bounds.max.y,
    offset: 0,
    chamfer: 0,
  };
  const hull = hullOf(massing, shell, bounds, { along: 1, across: 1, shift: 0 }, BOX, undefined, 0);
  return { hull, bounds };
}

/** Every vertex of a geometry as x, y and z. */
function vertices(geometry: BufferGeometry): [number, number, number][] {
  const position = geometry.getAttribute('position') as BufferAttribute;
  const out: [number, number, number][] = [];
  for (let v = 0; v < position.count; v++) out.push([position.getX(v), position.getY(v), position.getZ(v)]);
  return out;
}

describe('the outline hull, band by band', () => {
  it('stops the hull of a lower tier at its roof', () => {
    // A podium whose roof stands just over where a band of 1 m would be cut,
    // and a tower on it. Cut on that grid, the band holding the podium's roof
    // stood the hull a whole band over it, at the podium's width: a black wall
    // round the edge of the terrace.
    const roof = 9.83;
    const { hull } = hullAround(box(20, 20, 0, roof), box(10, 10, roof, 30.3));
    for (const [x, y, z] of vertices(hull)) {
      if (Math.max(Math.abs(x), Math.abs(z)) > 5 + OUTLINE_WIDTH + TOLERANCE) {
        expect(y, `${x.toFixed(2)},${z.toFixed(2)}`).toBeLessThanOrEqual(roof + TOLERANCE);
      }
    }
  });

  it('draws in over a pitched roof rather than boxing it', () => {
    // A gable from eaves at 10 m to a ridge at 15 m. Each sloping triangle
    // spans the whole pitch, and measured whole it held every band of the roof
    // out at the eaves: a box standing 5 m over the far eave.
    const eaves = 10;
    const ridge = 15;
    const gable = [
      // The two slopes, each as two triangles.
      [-5, eaves, -5, 0, ridge, -5, 0, ridge, 5],
      [-5, eaves, -5, 0, ridge, 5, -5, eaves, 5],
      [5, eaves, -5, 5, eaves, 5, 0, ridge, 5],
      [5, eaves, -5, 0, ridge, 5, 0, ridge, -5],
      // The two ends.
      [-5, eaves, 5, 0, ridge, 5, 5, eaves, 5],
      [-5, eaves, -5, 5, eaves, -5, 0, ridge, -5],
    ].flat();
    const { hull } = hullAround(box(10, 10, 0, eaves), gable);
    for (const [x, y] of vertices(hull)) {
      if (y <= eaves + 1) continue;
      // A band is a metre deep at most, so the hull stands out from the slope
      // by what the slope runs in over one band, and the rim.
      const slope = ridge - Math.min(y, ridge);
      expect(Math.abs(x), `at ${y.toFixed(2)}`).toBeLessThanOrEqual(slope + 1 + OUTLINE_WIDTH + TOLERANCE);
    }
  });
});

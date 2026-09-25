import { describe, expect, it } from 'vitest';
import { ROSTER, type VehicleClass } from '../src/sim/vehicle.ts';
import { vehicleBoxes } from '../src/render/vehicle-mesh.ts';

/**
 * The inside of a lofted cabin (docs/vehicle-bodies.md, "The glass and the
 * inside"). The renderer culls back faces, so a face seen from inside the
 * cabin is drawn only when it faces in. A ray cast from inside must meet a
 * face turned towards it before it leaves the body, or the world shows through
 * the roof and the far side, as it did through the bus.
 */

type Vec = [number, number, number];

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Whether the first opaque face a ray from `from` along `dir` meets faces back at it. */
function seesALining(cls: VehicleClass, from: Vec, dir: Vec): boolean {
  let nearest = Infinity;
  let facing = false;
  for (const part of vehicleBoxes(ROSTER[cls])) {
    if (part.faces === undefined || part.glass === true) continue;
    for (const flat of part.faces) {
      const p: Vec[] = [];
      for (let i = 0; i < flat.length; i += 3) {
        p.push([(flat[i] as number) + part.x, (flat[i + 1] as number) + part.y, (flat[i + 2] as number) + part.z]);
      }
      for (let i = 1; i < p.length - 1; i++) {
        const [a, b, c] = [p[0] as Vec, p[i] as Vec, p[i + 1] as Vec];
        const e1 = sub(b, a);
        const e2 = sub(c, a);
        const h = cross(dir, e2);
        const det = dot(e1, h);
        if (Math.abs(det) < 1e-12) continue;
        const s = sub(from, a);
        const u = dot(s, h) / det;
        const q = cross(s, e1);
        const v = dot(dir, q) / det;
        const t = dot(e2, q) / det;
        if (u < 0 || v < 0 || u + v > 1 || t <= 1e-6 || t >= nearest) continue;
        nearest = t;
        facing = dot(cross(e1, e2), dir) < 0;
      }
    }
  }
  return nearest < Infinity && facing;
}

describe('the inside of a cabin', () => {
  it('lines the roof, the rails and the tail of the bus', () => {
    const spec = ROSTER.bus;
    // Halfway up the glass, in the middle of the bus.
    const eye: Vec = [0, -spec.halfHeight + 0.64 * spec.halfHeight * 2, 0];
    expect(seesALining('bus', eye, [0, 1, 0])).toBe(true);
    expect(seesALining('bus', eye, [-1, 0, 0])).toBe(true);
    // Up across to the rails and the ceiling over the windows, on either side.
    for (let x = -0.6; x <= 0.6; x += 0.24) {
      for (const z of [1, -1]) expect(seesALining('bus', eye, [x, 1, z])).toBe(true);
    }
  });

  it('lines the roof of a car', () => {
    for (const cls of ['saloon', 'compact', 'van'] as const) {
      const spec = ROSTER[cls];
      expect(seesALining(cls, [0, spec.halfHeight * 0.6, 0], [0, 1, 0])).toBe(true);
    }
  });
});

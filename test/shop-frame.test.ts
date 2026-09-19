import { describe, expect, it } from 'vitest';
import { aimAt, anglesOf, SPIN, SWAY, type Bounds } from '../src/render/shop-frame.ts';

const VIEW = { fov: 26, aspect: 4 / 3, tilt: 0.32, margin: 1 };
const PLINTH = { radius: 0.3, top: 0, bottom: -0.06 };

/** Where each corner of the box lands on the screen, in units of the half screen, at every angle. */
function projected(box: Bounds, motion: typeof SPIN): { x: number; y: number }[] {
  const { target, distance } = aimAt(box, PLINTH, motion, VIEW);
  const tanV = Math.tan((VIEW.fov / 2) * (Math.PI / 180));
  const tanH = tanV * VIEW.aspect;
  const out: { x: number; y: number }[] = [];
  for (const a of anglesOf(motion)) {
    for (const x of [box.min[0], box.max[0]]) {
      for (const y of [box.min[1], box.max[1]]) {
        for (const z of [box.min[2], box.max[2]]) {
          const rx = Math.cos(a) * x + Math.sin(a) * z;
          const rz = -Math.sin(a) * x + Math.cos(a) * z;
          const dy = y - target;
          const up = dy * Math.cos(VIEW.tilt) - rz * Math.sin(VIEW.tilt);
          const near = dy * Math.sin(VIEW.tilt) + rz * Math.cos(VIEW.tilt);
          out.push({ x: rx / (distance - near) / tanH, y: up / (distance - near) / tanV });
        }
      }
    }
  }
  return out;
}

describe('the shop preview camera', () => {
  const rifle: Bounds = { min: [-0.5, 0, -0.03], max: [0.5, 0.18, 0.03] };
  const figure: Bounds = { min: [-0.12, 0, -0.08], max: [0.12, 1, 0.08] };

  it('holds every corner of the model at every angle it turns through', () => {
    for (const [box, motion] of [[rifle, SWAY], [figure, SPIN], [rifle, SPIN]] as const) {
      for (const p of projected(box, motion)) {
        expect(Math.abs(p.x)).toBeLessThanOrEqual(1 + 1e-9);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('stands closer to a swaying rifle than to one turning all the way round', () => {
    const wide = Math.max(...projected(rifle, SWAY).map((p) => Math.abs(p.x)));
    expect(wide).toBeGreaterThan(0.8);
    expect(aimAt(rifle, PLINTH, SWAY, VIEW).distance).toBeLessThan(aimAt(rifle, PLINTH, SPIN, VIEW).distance);
  });

  it('fills most of the height with a standing figure', () => {
    const ys = projected(figure, SPIN).map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(1.6);
  });
});

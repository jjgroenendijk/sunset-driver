import { describe, expect, it } from 'vitest';
import type { CasualtyGround } from '../../../src/sim/crowd/casualty.ts';
import { createOfficer, type Officer } from '../../../src/sim/police/officer.ts';
import { wayRound } from '../../../src/sim/police/wall-follow.ts';

/** A wall on the map, from one end to the other. */
type Wall = readonly [number, number, number, number];

/** A ground of thin walls: how far a ray goes before it meets one. */
function groundOf(walls: readonly Wall[]): CasualtyGround {
  return {
    heightAt: () => 0,
    reach(x, _h, y, dir, max) {
      const dx = Math.cos(dir);
      const dy = Math.sin(dir);
      let best = max;
      for (const [ax, ay, bx, by] of walls) {
        const ex = bx - ax;
        const ey = by - ay;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((ax - x) * ey - (ay - y) * ex) / den;
        const u = ((ax - x) * dy - (ay - y) * dx) / den;
        if (t >= 0 && u >= 0 && u <= 1) best = Math.min(best, t);
      }
      return best;
    },
  };
}

/** Walk an officer at a walking pace towards a goal for some ticks; answer where they got to. */
function walk(officer: Officer, ground: CasualtyGround, goalX: number, goalY: number, ticks: number): number {
  const step = 1.4 / 60;
  for (let i = 0; i < ticks; i++) {
    const gap = Math.hypot(goalX - officer.x, goalY - officer.y);
    if (gap < 0.5) return gap;
    const dir = wayRound(officer, Math.atan2(goalY - officer.y, goalX - officer.x), step, gap, ground);
    if (dir === undefined) continue;
    officer.x += Math.cos(dir) * step;
    officer.y += Math.sin(dir) * step;
  }
  return Math.hypot(goalX - officer.x, goalY - officer.y);
}

/**
 * A courtyard open to the south, 20 m wide and 12 m deep: the back wall at
 * y = 12, the side walls at x = ±10. The goal stands north of the back wall.
 */
const COURTYARD: readonly Wall[] = [
  [-10, 12, 10, 12],
  [-10, 0, -10, 12],
  [10, 0, 10, 12],
];

describe('an officer on foot finds a way round a wall (#512)', () => {
  it('walks out of a courtyard open away from the goal, and round it, either way round', () => {
    const ground = groundOf(COURTYARD);
    for (const id of [0, 1]) {
      const officer = createOfficer(id, 'patrol', -1, 'pursue', 0, 6, 0, 0);
      const left = walk(officer, ground, 0, 20, 120 * 60);
      expect(left, `officer ${id} stuck at (${officer.x.toFixed(1)}, ${officer.y.toFixed(1)})`).toBeLessThan(0.5);
    }
  });

  it('walks into the courtyard from behind it', () => {
    const ground = groundOf(COURTYARD);
    for (const id of [0, 1]) {
      const officer = createOfficer(id, 'patrol', -1, 'pursue', 0, 20, 0, 0);
      const left = walk(officer, ground, 0, 6, 120 * 60);
      expect(left, `officer ${id} stuck at (${officer.x.toFixed(1)}, ${officer.y.toFixed(1)})`).toBeLessThan(0.5);
    }
  });

  it('keeps off the wall it follows', () => {
    const ground = groundOf(COURTYARD);
    const officer = createOfficer(0, 'patrol', -1, 'pursue', 0, 6, 0, 0);
    const step = 1.4 / 60;
    let closest = Infinity;
    for (let i = 0; i < 60 * 60; i++) {
      const gap = Math.hypot(0 - officer.x, 20 - officer.y);
      if (gap < 0.5) break;
      const dir = wayRound(officer, Math.atan2(20 - officer.y, 0 - officer.x), step, gap, ground);
      if (dir === undefined) continue;
      officer.x += Math.cos(dir) * step;
      officer.y += Math.sin(dir) * step;
      for (const [ax, ay, bx, by] of COURTYARD) {
        const ex = bx - ax;
        const ey = by - ay;
        const u = Math.max(0, Math.min(1, ((officer.x - ax) * ex + (officer.y - ay) * ey) / (ex * ex + ey * ey)));
        closest = Math.min(closest, Math.hypot(officer.x - ax - u * ex, officer.y - ay - u * ey));
      }
    }
    expect(closest).toBeGreaterThan(0.2);
  });

  it('walks the straight line when nothing stands in it', () => {
    const officer = createOfficer(0, 'patrol', -1, 'pursue', 0, 0, 0, 0);
    expect(wayRound(officer, 1, 0.02, 30, groundOf([]))).toBe(1);
    expect(officer.wallGap).toBe(-1);
  });
});

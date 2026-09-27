import { describe, expect, it } from 'vitest';
import { FrameWatch, POP_IN_EVERY } from '../../../src/render/frame/frame-watch.ts';
import { EDGES, type Edge, type PopIn } from '../../../src/render/frame/pop-in.ts';

const REFRESH = 1000 / 60;

function reading(hole: number, edges: Partial<Record<Edge, number>> = {}): PopIn {
  const all = Object.fromEntries(EDGES.map((edge) => [edge, edges[edge] ?? Infinity])) as Record<Edge, number>;
  return { hole, late: Infinity, edges: all };
}

describe('the frame watch', () => {
  it('reads a steady 60 Hz as 60 fps with no long frame', () => {
    const watch = new FrameWatch();
    for (let i = 0; i < 300; i++) watch.sample(REFRESH);
    const r = watch.report();
    expect(r.fps).toBeCloseTo(60, 0);
    expect(r.p95).toBeCloseTo(REFRESH, 3);
    expect(r.long).toBe(0);
  });

  it('counts a stutter, and forgets it five seconds later', () => {
    const watch = new FrameWatch();
    watch.sample(80);
    for (let i = 0; i < 100; i++) watch.sample(REFRESH);
    expect(watch.report().long).toBe(1);
    expect(watch.report().worst).toBe(80);
    for (let i = 0; i < 400; i++) watch.sample(REFRESH);
    expect(watch.report().long).toBe(0);
  });

  it('asks for the pop-in once every few frames, and keeps the nearest', () => {
    const watch = new FrameWatch();
    const asked = Array.from({ length: POP_IN_EVERY * 3 }, () => watch.sample(REFRESH)).filter(Boolean).length;
    expect(asked).toBe(3);
    watch.pop(reading(300, { traffic: 190 }));
    watch.pop(reading(Infinity, { crowd: 120, traffic: 185 }));
    const r = watch.report();
    expect(r.hole).toBe(300);
    expect(r.edge).toBe(120);
    expect(r.edgeName).toBe('crowd');
    expect(watch.line()).toContain('crowd 120 m');
  });
});

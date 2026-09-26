import { describe, expect, it } from 'vitest';
import { CrowdPass, PASS_STEP } from '../../../src/render/people/crowd-pass.ts';

/** One person of a pass: where they start, the way they walk and how fast. */
interface Walker {
  x: number;
  y: number;
  heading: number;
  speed: number;
  group: number;
  /** Drawn by someone else: the crowd steps round them, and they do not step. */
  fixed?: boolean;
}

/**
 * Walk everybody on in steps of `dt` seconds and answer where each is drawn,
 * frame by frame: their place on their lane plus the step the pass gives them.
 */
function drawn(walkers: Walker[], seconds: number, dt = 0.05): { x: number; y: number }[][] {
  const pass = new CrowdPass(walkers.length);
  const frames: { x: number; y: number }[][] = [];
  for (let t = 0; t <= seconds; t += dt) {
    pass.count = 0;
    const at = walkers.map((w) => ({ x: w.x + Math.cos(w.heading) * w.speed * t, y: w.y + Math.sin(w.heading) * w.speed * t }));
    walkers.forEach((w, i) => (w.fixed === true ? pass.addFixed(at[i]!.x, at[i]!.y, w.heading, w.speed) : pass.add(at[i]!.x, at[i]!.y, w.heading, w.speed, w.group, i)));
    pass.solve();
    frames.push(
      walkers.map((w, i) => {
        const step = pass.step[i] as number;
        if (w.fixed === true) expect(step).toBe(0);
        expect(Math.abs(step)).toBeLessThanOrEqual(PASS_STEP);
        return { x: at[i]!.x - Math.sin(w.heading) * step, y: at[i]!.y + Math.cos(w.heading) * step };
      }),
    );
  }
  return frames;
}

/** The least distance between two people over every frame. */
const closest = (frames: { x: number; y: number }[][], a: number, b: number): number =>
  Math.min(...frames.map((f) => Math.hypot(f[a]!.x - f[b]!.x, f[a]!.y - f[b]!.y)));

describe('people passing each other on a pavement (spec sections 13.1, 20.1)', () => {
  it('passes two walking at each other on one line, each to their own right, without meeting', () => {
    const frames = drawn(
      [
        { x: -4, y: 0, heading: 0, speed: 1.4, group: 0 },
        { x: 4, y: 0, heading: Math.PI, speed: 1.4, group: 1 },
      ],
      6,
    );
    expect(closest(frames, 0, 1)).toBeGreaterThan(0.5);
    // Heading +x, their right is +y; heading -x, it is -y.
    const level = frames.reduce((a, f) => (Math.abs(f[0]!.x - f[1]!.x) < Math.abs(a[0]!.x - a[1]!.x) ? f : a), frames[0]!);
    expect(level[0]!.y).toBeGreaterThan(level[1]!.y);
  });

  it('steps a person who keeps left away from the other one rather than across them', () => {
    // The second stands a little to the first one's right, so a step to the right would meet them.
    const frames = drawn(
      [
        { x: -4, y: 0, heading: 0, speed: 1.4, group: 0 },
        { x: 4, y: 0.2, heading: Math.PI, speed: 1.4, group: 1 },
      ],
      6,
    );
    expect(closest(frames, 0, 1)).toBeGreaterThan(0.5);
    // Neither crosses the other's line: the second stays on the first one's right all the way.
    for (const f of frames) expect(f[1]!.y).toBeGreaterThan(f[0]!.y);
  });

  it('walks round somebody standing on the lane, who does not move', () => {
    const frames = drawn(
      [
        { x: -4, y: 0, heading: 0, speed: 1.4, group: 0 },
        { x: 0, y: 0, heading: Math.PI, speed: 0, group: 1 },
      ],
      6,
    );
    expect(closest(frames, 0, 1)).toBeGreaterThan(0.5);
    for (const f of frames) expect(f[1]).toEqual({ x: 0, y: 0 });
    // And steps back onto the lane once past.
    expect(Math.abs(frames[frames.length - 1]![0]!.y)).toBeLessThan(1e-9);
  });

  it('moves apart two who stand face to face too close', () => {
    const frames = drawn(
      [
        { x: 0, y: 0, heading: 0, speed: 0, group: 0 },
        { x: 0.4, y: 0, heading: Math.PI, speed: 0, group: 1 },
      ],
      0,
    );
    expect(closest(frames, 0, 1)).toBeGreaterThan(0.6);
  });

  it('moves apart two strangers on one spot facing one way, walking or standing', () => {
    for (const speed of [0, 1.3]) {
      const frames = drawn(
        [
          { x: 0, y: 0, heading: 0, speed, group: 0 },
          { x: 0, y: 0, heading: 0, speed, group: 1 },
        ],
        0,
      );
      expect(closest(frames, 0, 1)).toBeGreaterThan(0.55);
    }
  });

  it('leaves company walking abreast where it walks', () => {
    const frames = drawn(
      [
        { x: 0, y: 0, heading: 0, speed: 1.2, group: 3 },
        { x: 0, y: 0.5, heading: 0, speed: 1.2, group: 3 },
      ],
      2,
    );
    for (const f of frames) expect(f[1]!.y - f[0]!.y).toBeCloseTo(0.5, 9);
  });

  it('steps round the player standing in the way, who does not move for it', () => {
    const frames = drawn(
      [
        { x: -4, y: 0, heading: 0, speed: 1.4, group: 0 },
        { x: 0, y: 0.05, heading: Math.PI / 2, speed: 0, group: 0, fixed: true },
      ],
      6,
    );
    expect(closest(frames, 0, 1)).toBeGreaterThan(0.55);
  });

  it('passes the player walking at the crowd head on, taking the whole room itself', () => {
    const frames = drawn(
      [
        { x: -4, y: 0, heading: 0, speed: 1.4, group: 0 },
        { x: 4, y: 0, heading: Math.PI, speed: 1.4, group: 1, fixed: true },
      ],
      6,
    );
    expect(closest(frames, 0, 1)).toBeGreaterThan(0.55);
  });

  it('makes room for the police coming up from behind', () => {
    const frames = drawn(
      [
        { x: 0, y: 0, heading: 0, speed: 1, group: 0 },
        { x: -4, y: 0.02, heading: 0, speed: 3, group: 1, fixed: true },
      ],
      4,
    );
    expect(closest(frames, 0, 1)).toBeGreaterThan(0.5);
  });
});

import { describe, expect, it } from 'vitest';
import { FollowCamera, type CameraView } from '../../../src/render/camera/camera.ts';
import { edgeInSight, groundInSight, pastCircle, pastRing, pastSquare } from '../../../src/render/frame/sightline.ts';
import { popIn, type PopInWorld } from '../../../src/render/frame/pop-in.ts';
import { FULL_TIER } from '../../../src/render/frame/quality.ts';
import type { ChunkDrawn } from '../../../src/render/streaming/chunk-tiles.ts';

/** A camera settled on a player at the origin heading east, at `speed` metres a second. */
function cameraOn(view: CameraView, speed: number, aspect = 844 / 390): FollowCamera {
  const camera = new FollowCamera(aspect);
  for (let i = 0; i < 600; i++) {
    camera.update(1 / 60, { x: 0, y: 0, height: 0, heading: 0, speed, driving: true }, { view });
  }
  return camera;
}

/** The farthest ground point in sight, in metres from the player at the origin. */
function farthest(view: CameraView, speed: number): number {
  const sight = groundInSight(cameraOn(view, speed).camera, 0, 750);
  return Math.max(...sight.map((p) => Math.hypot(p.x, p.y)));
}

describe('the ground in sight', () => {
  it('stays within about 165 m of the player top down, even at the top speed of the roster', () => {
    expect(farthest('top-down', 0)).toBeLessThan(80);
    expect(farthest('top-down', 66)).toBeLessThan(170);
    expect(farthest('top-down', 66)).toBeGreaterThan(100);
  });

  it('reaches the haze in the chase views, which see the horizon', () => {
    expect(farthest('third-person', 30)).toBeGreaterThan(700);
    expect(farthest('first-person', 30)).toBeGreaterThan(700);
  });

  it('leaves out what the haze has closed over', () => {
    const sight = groundInSight(cameraOn('third-person', 30).camera, 0, 300);
    expect(Math.max(...sight.map((p) => p.range))).toBeLessThanOrEqual(300);
  });
});

describe('an edge in sight', () => {
  it('is off the screen top down for the traffic, and on it in third person', () => {
    const top = groundInSight(cameraOn('top-down', 30).camera, 0, 750);
    expect(edgeInSight(top, pastSquare(0, 0, 180))).toBe(Infinity);
    const chase = groundInSight(cameraOn('third-person', 30).camera, 0, 750);
    const edge = edgeInSight(chase, pastSquare(0, 0, 180));
    expect(edge).toBeGreaterThan(170);
    expect(edge).toBeLessThan(220);
  });

  it('knows a circle from a square and a ring of chunks', () => {
    expect(pastCircle(0, 0, 100)(80, 80)).toBe(true);
    expect(pastSquare(0, 0, 100)(80, 80)).toBe(false);
    // The player stands in chunk (0, 0); one ring out ends 500 m east of its west edge.
    expect(pastRing(10, 10, 1)(490, 0)).toBe(false);
    expect(pastRing(10, 10, 1)(510, 0)).toBe(true);
  });
});

describe('pop-in', () => {
  const world = (drawn: (x: number, y: number) => ChunkDrawn): PopInWorld => ({ drawnAt: drawn, quality: FULL_TIER, hazeFar: 750 });

  it('finds no hole where every chunk is whole', () => {
    const reading = popIn(cameraOn('third-person', 30).camera, world(() => 'whole'), 0, 0, 0);
    expect(reading.hole).toBe(Infinity);
    expect(reading.late).toBe(Infinity);
  });

  it('finds a hole where a chunk in sight is missing or part built, and old detail apart', () => {
    const camera = cameraOn('third-person', 30).camera;
    const partial = popIn(camera, world((x) => (x > 300 ? 'partial' : 'whole')), 0, 0, 0);
    expect(partial.hole).toBeGreaterThan(290);
    expect(partial.hole).toBeLessThan(330);
    const late = popIn(camera, world((x) => (x > 300 ? 'late' : 'whole')), 0, 0, 0);
    expect(late.hole).toBe(Infinity);
    expect(late.late).toBeLessThan(330);
  });
});

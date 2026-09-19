/**
 * The follow camera of spec section 10.7 (`src/render/camera.ts`).
 *
 * What is pinned here is that the camera reaches the same place whatever the
 * frames it was given to get there. A frame varies in length by a millisecond
 * or two, and a smoothing that is linear in that length turns the variation
 * into camera movement: the judder the tick interpolation of `smooth.ts` takes
 * out of the player would come back through the view.
 */
import { describe, expect, it } from 'vitest';
import { FollowCamera } from '../src/render/camera.ts';

const TARGET = { x: 100, y: 40, height: 5, heading: 0, speed: 0 };
const REST = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };

/** Where the camera stands after following the target for a while, at a frame rate. */
function follow(frames: number, dt: number): number {
  const camera = new FollowCamera(1.7);
  camera.update(dt, REST);
  for (let i = 0; i < frames; i++) camera.update(dt, TARGET);
  return camera.camera.position.x;
}

describe('FollowCamera', () => {
  it('reaches the same place at any frame rate', () => {
    // One long frame, and the same time in ten short ones.
    expect(follow(1, 0.1)).toBeCloseTo(follow(10, 0.01), 9);
    // A tenth of a second at 30 Hz and at 240 Hz.
    expect(follow(3, 1 / 30)).toBeCloseTo(follow(24, 1 / 240), 9);
  });

  it('leaves the focus behind the target rather than on it', () => {
    const near = follow(1, 0.05);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(TARGET.x);
  });

  it('puts the camera straight on the target after a snap', () => {
    const camera = new FollowCamera(1.7);
    camera.update(0.016, REST);
    camera.snap();
    camera.update(0.016, TARGET);
    expect(camera.camera.position.x).toBeCloseTo(TARGET.x, 9);
  });

  it('pulls back for speed over time rather than in one frame', () => {
    const camera = new FollowCamera(1.7);
    camera.update(0.016, REST);
    const rest = camera.camera.position.y;
    const moving = { ...REST, speed: 30, driving: true };
    camera.update(0.016, moving);
    const first = camera.camera.position.y - rest;
    for (let i = 0; i < 600; i++) camera.update(0.016, moving);
    const settled = camera.camera.position.y - rest;
    expect(settled).toBeGreaterThan(0);
    expect(first).toBeLessThan(settled * 0.05);
  });

  it('keeps a player on foot at the base distance, sprinting or not', () => {
    const camera = new FollowCamera(1.7);
    camera.update(0.016, REST);
    const rest = camera.camera.position.y;
    for (let i = 0; i < 600; i++) camera.update(0.016, { ...REST, speed: 5.6, driving: false });
    expect(camera.camera.position.y).toBeCloseTo(rest, 9);
  });
});

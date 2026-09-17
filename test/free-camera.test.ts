/**
 * The developer free camera (`src/render/free-camera.ts`). It is the one half
 * of the tool that runs without a browser: where it stands, where it looks, and
 * how fast it flies.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { CAMERA_PITCH, FollowCamera } from '../src/render/camera.ts';
import {
  EMPTY_FREE_INPUT,
  FAST_MULTIPLIER,
  FREE_SPEED,
  FreeCamera,
  MAX_PITCH,
  MAX_SPEED,
  MIN_SPEED,
  SPEED_STEP,
  SURVEY_HEIGHT,
  SURVEY_PITCH,
} from '../src/render/free-camera.ts';

/** One second of flight with the given keys held. */
function fly(free: FreeCamera, input: Partial<typeof EMPTY_FREE_INPUT>): void {
  free.update(1, { ...EMPTY_FREE_INPUT, ...input });
}

describe('free camera', () => {
  it('takes over from where the game camera stands', () => {
    const follow = new FollowCamera(16 / 9);
    follow.update(1, { x: 120, y: -40, height: 7, heading: 0, speed: 0 });
    const free = new FreeCamera();
    free.from(follow.camera);
    expect(free.x).toBeCloseTo(follow.camera.position.x, 6);
    expect(free.y).toBeCloseTo(follow.camera.position.y, 6);
    expect(free.z).toBeCloseTo(follow.camera.position.z, 6);
    // The game camera looks down at a fixed pitch and never yaws.
    expect(free.pitch).toBeCloseTo(-CAMERA_PITCH, 6);
    expect(free.yaw).toBeCloseTo(0, 6);
  });

  it('surveys from over the ground without moving off the spot', () => {
    const free = new FreeCamera();
    free.x = 400;
    free.z = -120;
    free.yaw = 1.2;
    free.survey(35);
    expect(free.y).toBeCloseTo(35 + SURVEY_HEIGHT, 6);
    expect(free.pitch).toBeCloseTo(SURVEY_PITCH, 6);
    // Where it stands on the map and which way it faces are the session's.
    expect(free.x).toBe(400);
    expect(free.z).toBe(-120);
    expect(free.yaw).toBe(1.2);
  });

  it('holds still with no key held', () => {
    const free = new FreeCamera();
    fly(free, {});
    expect([free.x, free.y, free.z]).toEqual([0, 0, 0]);
  });

  it('moves along the view direction and across it', () => {
    const free = new FreeCamera();
    // Looking down -z, which is up the screen: forward is the map's -y.
    fly(free, { forward: 1 });
    expect(free.x).toBeCloseTo(0, 6);
    expect(free.y).toBeCloseTo(0, 6);
    expect(free.z).toBeCloseTo(-FREE_SPEED, 6);

    free.yaw = Math.PI / 2;
    fly(free, { forward: 1 });
    expect(free.x).toBeCloseTo(-FREE_SPEED, 6);
    expect(free.z).toBeCloseTo(-FREE_SPEED, 6);

    const across = new FreeCamera();
    fly(across, { right: 1 });
    expect(across.x).toBeCloseTo(FREE_SPEED, 6);
    expect(across.z).toBeCloseTo(0, 6);
  });

  it('pitches the forward key and leaves up and down level', () => {
    const free = new FreeCamera();
    free.pitch = -MAX_PITCH;
    fly(free, { forward: 1 });
    // Looking all but straight down, forward is nearly all descent.
    expect(free.y).toBeLessThan(-FREE_SPEED * 0.99);
    expect(Math.hypot(free.x, free.z)).toBeLessThan(FREE_SPEED * 0.02);

    const rise = new FreeCamera();
    rise.pitch = -MAX_PITCH;
    fly(rise, { up: 1 });
    expect(rise.y).toBeCloseTo(FREE_SPEED, 6);
    expect(rise.x).toBeCloseTo(0, 6);
    expect(rise.z).toBeCloseTo(0, 6);
  });

  it('flies faster with the fast key held', () => {
    const free = new FreeCamera();
    fly(free, { forward: 1, fast: true });
    expect(free.z).toBeCloseTo(-FREE_SPEED * FAST_MULTIPLIER, 6);
  });

  it('turns with the mouse and never looks past straight down', () => {
    const free = new FreeCamera();
    free.look(100, 0);
    expect(free.yaw).toBeLessThan(0);
    free.look(0, 100_000);
    expect(free.pitch).toBeCloseTo(-MAX_PITCH, 6);
    free.look(0, -1_000_000);
    expect(free.pitch).toBeCloseTo(MAX_PITCH, 6);
  });

  it('sets the speed by the wheel, between its bounds', () => {
    const free = new FreeCamera();
    free.scaleSpeed(1);
    expect(free.speed).toBeCloseTo(FREE_SPEED * SPEED_STEP, 6);
    for (let i = 0; i < 100; i++) free.scaleSpeed(1);
    expect(free.speed).toBe(MAX_SPEED);
    for (let i = 0; i < 200; i++) free.scaleSpeed(-1);
    expect(free.speed).toBe(MIN_SPEED);
  });

  it('writes its place and its look onto a camera', () => {
    const camera = new PerspectiveCamera(45, 1, 1, 2000);
    const free = new FreeCamera();
    free.x = 10;
    free.y = 80;
    free.z = -30;
    free.yaw = 0.4;
    free.pitch = -0.7;
    free.writeTo(camera);
    expect([camera.position.x, camera.position.y, camera.position.z]).toEqual([10, 80, -30]);
    // Read back in the order the camera was written in, so `from` is its inverse.
    expect(camera.rotation.order).toBe('YXZ');
    const taken = new FreeCamera();
    taken.from(camera);
    expect(taken.pitch).toBeCloseTo(free.pitch, 6);
    expect(taken.yaw).toBeCloseTo(free.yaw, 6);
  });
});

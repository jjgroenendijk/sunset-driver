/**
 * The arithmetic of the touch controls (`src/ui/input/touch.ts`): which browsers get
 * them, where a thumb puts the virtual stick, and what a pinch asks of the
 * camera's speed. It is the half of the pad that runs without a browser.
 */
import { describe, expect, it } from 'vitest';
import { SPEED_STEP } from '../../../src/render/camera/free-camera.ts';
import { isTouchDevice, pinchNotches, STICK_DEAD, STICK_RADIUS, stickVector } from '../../../src/ui/input/touch.ts';

describe('isTouchDevice', () => {
  it('takes a browser whose primary pointer is a finger', () => {
    expect(isTouchDevice({ maxTouchPoints: 5, coarse: true })).toBe(true);
  });

  it('leaves a mouse alone', () => {
    expect(isTouchDevice({ maxTouchPoints: 0, coarse: false })).toBe(false);
  });

  it('leaves a touchscreen laptop on the keys', () => {
    // It reports fingers and still has a mouse, so its primary pointer is fine.
    expect(isTouchDevice({ maxTouchPoints: 10, coarse: false })).toBe(false);
  });

  it('refuses a coarse pointer with no touchscreen behind it', () => {
    expect(isTouchDevice({ maxTouchPoints: 0, coarse: true })).toBe(false);
  });
});

describe('stickVector', () => {
  it('answers nothing inside the dead zone', () => {
    expect(stickVector(STICK_RADIUS * STICK_DEAD * 0.9, 0)).toEqual({ x: 0, y: 0 });
  });

  it('turns the screen over, so a thumb pushed up is forward', () => {
    const push = stickVector(0, -STICK_RADIUS);
    expect(push.y).toBeCloseTo(1, 6);
    expect(push.x).toBeCloseTo(0, 6);
  });

  it('holds at full past the radius, so the thumb may wander', () => {
    const far = stickVector(STICK_RADIUS * 4, 0);
    expect(far.x).toBeCloseTo(1, 6);
    expect(far.y).toBeCloseTo(0, 6);
  });

  it('starts from nothing at the edge of the dead zone rather than jumping', () => {
    const push = stickVector(STICK_RADIUS * STICK_DEAD + 0.01, 0);
    expect(push.x).toBeGreaterThan(0);
    expect(push.x).toBeLessThan(0.02);
  });

  it('takes the dead zone out of the length, so every direction answers alike', () => {
    const straight = stickVector(0, -STICK_RADIUS / 2);
    const corner = stickVector(STICK_RADIUS / Math.sqrt(8), -STICK_RADIUS / Math.sqrt(8));
    expect(Math.hypot(corner.x, corner.y)).toBeCloseTo(Math.hypot(straight.x, straight.y), 6);
  });
});

describe('pinchNotches', () => {
  it('asks for one notch where the gap grows by one step', () => {
    expect(pinchNotches(100, 100 * SPEED_STEP, SPEED_STEP)).toBeCloseTo(1, 6);
  });

  it('asks for less speed as the fingers come together', () => {
    expect(pinchNotches(100, 50, SPEED_STEP)).toBeLessThan(0);
  });

  it('asks for nothing before there are two fingers to measure', () => {
    expect(pinchNotches(0, 120, SPEED_STEP)).toBe(0);
    expect(pinchNotches(120, 0, SPEED_STEP)).toBe(0);
  });
});

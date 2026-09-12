/**
 * The sun the shadow is cast from (`src/render/sky.ts`).
 *
 * `CSMShadowNode` keeps a shadow edge still by snapping each cascade to a texel
 * grid it builds in the light's own frame, so the snap only holds while the
 * light stands still. A game day is 24 real minutes, which turns the sun a
 * quarter of a degree a second. What is pinned here is that the shadow's sun
 * moves in steps of {@link SUN_SHADOW_STEP} while the sky keeps following the
 * true one, and that it never falls a step behind.
 */
import { describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { daylightAt } from '../src/render/daylight.ts';
import { SkyLighting, SUN_SHADOW_STEP } from '../src/render/sky.ts';
import { TICKS_PER_DAY } from '../src/sim/clock.ts';

describe('SkyLighting', () => {
  it('holds the shadow sun still between steps', () => {
    const sky = new SkyLighting(new Scene(), 10, 100);
    sky.set(daylightAt(30000));
    const first = sky.shadowSunDirection.clone();
    // A quarter of the step: a few frames of the day, and no move at all.
    sky.set(daylightAt(30000 + Math.round(TICKS_PER_DAY / (4 * 1440))));
    expect(sky.shadowSunDirection.equals(first)).toBe(true);
    sky.dispose();
  });

  it('follows the sun once it has turned a whole step', () => {
    const sky = new SkyLighting(new Scene(), 10, 100);
    sky.set(daylightAt(30000));
    const first = sky.shadowSunDirection.clone();
    // A minute of the game day turns the sun 15 degrees, far past one step.
    sky.set(daylightAt(30000 + TICKS_PER_DAY / 24));
    expect(sky.shadowSunDirection.equals(first)).toBe(false);
    sky.dispose();
  });

  it('never stands more than a step from the true sun', () => {
    const sky = new SkyLighting(new Scene(), 10, 100);
    let worst = 0;
    // A whole game day, a frame of a 60 Hz display at a time.
    for (let tick = 0; tick < TICKS_PER_DAY; tick += 1) {
      const light = daylightAt(tick);
      sky.set(light);
      worst = Math.max(worst, sky.shadowSunDirection.angleTo(light.sun));
    }
    expect(worst).toBeLessThan(SUN_SHADOW_STEP + 1e-6);
    sky.dispose();
  });
});

/**
 * The mouse look of the chase views (spec section 10.7), and the weapon step
 * the wheel takes in both directions (spec section 11.6).
 */
import { describe, expect, it } from 'vitest';
import { FollowCamera } from '../../../src/render/camera/camera.ts';
import { LOOK_HOLD, LOOK_PER_PIXEL, yawBehind } from '../../../src/render/camera/camera-view.ts';
import { EMPTY_INPUT } from '../../../src/sim/input.ts';
import { createPlayerState } from '../../../src/sim/player/on-foot.ts';
import { createLoadout, currentWeapon, giveWeapon, stepWeapons } from '../../../src/sim/weapons/weapon.ts';

const WALKER = { x: 0, y: 0, height: 0, heading: 0, speed: 0, driving: false };
const DRIVER = { ...WALKER, driving: true };
const FRAME = 1 / 60;

/** A chase camera settled on `target`, with the mouse locked. */
function settled(target: typeof WALKER): FollowCamera {
  const camera = new FollowCamera(1);
  camera.update(FRAME, target, { view: 'third-person', mouse: true });
  return camera;
}

describe('the mouse look', () => {
  it('turns the view right when the mouse moves right, and holds it on foot', () => {
    const camera = settled(WALKER);
    const before = camera.heading;
    camera.look(100, 0);
    camera.update(FRAME, WALKER, { view: 'third-person', mouse: true });
    expect(camera.heading).toBeCloseTo(before - 100 * LOOK_PER_PIXEL, 9);
    // On foot the view stays where the mouse left it, rather than turning back after the player.
    for (let i = 0; i < 300; i++) camera.update(FRAME, WALKER, { view: 'third-person', mouse: true });
    expect(camera.heading).toBeCloseTo(before - 100 * LOOK_PER_PIXEL, 9);
  });

  it('tilts the view down when the mouse moves down', () => {
    const camera = settled(WALKER);
    camera.update(FRAME, WALKER, { view: 'first-person', mouse: true });
    const before = camera.camera.rotation.x;
    camera.look(0, 80);
    camera.update(FRAME, WALKER, { view: 'first-person', mouse: true });
    camera.look(0, 80);
    camera.update(FRAME, WALKER, { view: 'first-person', mouse: true });
    expect(camera.camera.rotation.x).toBeLessThan(before);
  });

  it('looks aside at the wheel, and goes back behind the car once the mouse is still', () => {
    const camera = settled(DRIVER);
    const behind = yawBehind(DRIVER.heading);
    camera.look(300, 0);
    camera.update(FRAME, DRIVER, { view: 'third-person', mouse: true });
    expect(Math.abs(camera.heading - behind)).toBeGreaterThan(0.5);
    const frames = Math.ceil((LOOK_HOLD + 4) / FRAME);
    for (let i = 0; i < frames; i++) camera.update(FRAME, DRIVER, { view: 'third-person', mouse: true });
    expect(camera.heading).toBeCloseTo(behind, 2);
  });

  it('ignores the mouse while the pointer is not locked', () => {
    const camera = settled(WALKER);
    const before = camera.heading;
    camera.look(200, 0);
    camera.update(FRAME, WALKER, { view: 'third-person' });
    expect(camera.heading).toBeCloseTo(before, 9);
  });
});

describe('the weapon step', () => {
  it('walks the carried weapons both ways, one step a tick', () => {
    const loadout = createLoadout();
    giveWeapon(loadout, 'ak-47');
    giveWeapon(loadout, 'mp5');
    const player = createPlayerState();
    const start = currentWeapon(loadout).id;
    stepWeapons(loadout, { ...EMPTY_INPUT, cycle: 1 }, player, 1, 1);
    const next = currentWeapon(loadout).id;
    expect(next).not.toBe(start);
    stepWeapons(loadout, { ...EMPTY_INPUT, cycle: -1 }, player, 1, 2);
    expect(currentWeapon(loadout).id).toBe(start);
    stepWeapons(loadout, { ...EMPTY_INPUT, cycle: -1 }, player, 1, 3);
    expect(currentWeapon(loadout).id).not.toBe(start);
    expect(currentWeapon(loadout).id).not.toBe(next);
  });
});

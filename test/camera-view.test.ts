/**
 * The views of the game camera (spec section 10.7): the turn past a building,
 * the third-person and first-person views, and the setting that picks one.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FollowCamera } from '../src/render/camera.ts';
import { backOf, CAMERA_VIEWS, clearYaw, nextView, yawBehind } from '../src/render/camera-view.ts';
import type { KeyValueStore } from '../src/ui/saves.ts';
import { turned } from '../src/ui/keyboard.ts';
import { DEFAULT_SETTINGS, readSettings, writeSettings } from '../src/ui/settings.ts';

const REST = { x: 0, y: 0, height: 0, heading: 0, speed: 0, driving: false };

/** A tower 100 m tall over the box `x0..x1` by `z0..z1`. */
function tower(x0: number, x1: number, z0: number, z1: number) {
  return (x: number, z: number): number | undefined => (x >= x0 && x <= x1 && z >= z0 && z <= z1 ? 100 : undefined);
}

/** The direction a camera looks along, on the ground. */
function lookOf(camera: FollowCamera): Vector3 {
  const look = new Vector3(0, 0, -1).applyQuaternion(camera.camera.quaternion);
  return look.setY(0).normalize();
}

describe('the turn past a building', () => {
  it('keeps north while nothing stands between', () => {
    expect(clearYaw(REST, 0, 1, 36, () => undefined, new Vector3())).toBe(0);
  });

  it('turns to a heading from which the player is seen', () => {
    // The tower stands south of the player, where the top-down camera does.
    const roofs = tower(-10, 10, 5, 40);
    const yaw = clearYaw(REST, 0, 1, 36, roofs, new Vector3());
    expect(yaw).not.toBe(0);
    const back = backOf(yaw, 1, new Vector3());
    for (let d = 1; d <= 36; d += 1) {
      const top = roofs(back.x * d, back.z * d);
      expect(top === undefined || top < 1.2 + back.y * d).toBe(true);
    }
  });

  it('keeps a clear heading rather than swinging to another', () => {
    const roofs = tower(-10, 10, 5, 40);
    const first = clearYaw(REST, 0, 1, 36, roofs, new Vector3());
    expect(clearYaw(REST, first, 1, 36, roofs, new Vector3())).toBe(first);
  });

  it('stays where the turn left it once north is clear again', () => {
    const turned = clearYaw(REST, 0, 1, 36, tower(-10, 10, 5, 40), new Vector3());
    expect(turned).not.toBe(0);
    expect(clearYaw(REST, turned, 1, 36, () => undefined, new Vector3())).toBe(turned);
  });

  it('turns the camera smoothly, never in one frame', () => {
    const camera = new FollowCamera(1.7);
    camera.update(0.016, REST);
    const roofs = tower(-10, 10, 5, 40);
    camera.update(0.016, REST, { turn: roofs });
    const once = Math.abs(camera.heading);
    expect(once).toBeGreaterThan(0);
    for (let i = 0; i < 300; i++) camera.update(0.016, REST, { turn: roofs });
    expect(Math.abs(camera.heading)).toBeGreaterThan(once * 5);
    // The camera still looks at the player: only the heading changed.
    const at = camera.camera.position;
    const look = new Vector3(0, 0, -1).applyQuaternion(camera.camera.quaternion);
    expect(at.clone().addScaledVector(look, at.length()).length()).toBeLessThan(1e-6);
  });
});

describe('the chase views', () => {
  it('stands behind the player, whichever way they face', () => {
    for (const heading of [0, 1, -2, Math.PI]) {
      const camera = new FollowCamera(1.7);
      camera.update(0.016, { ...REST, heading }, { view: 'third-person' });
      const look = lookOf(camera);
      expect(look.x).toBeCloseTo(Math.cos(heading), 6);
      expect(look.z).toBeCloseTo(Math.sin(heading), 6);
      const at = camera.camera.position;
      expect(at.x * Math.cos(heading) + at.z * Math.sin(heading)).toBeLessThan(-3);
    }
  });

  it('stands at the eyes in first person, looking where the player faces', () => {
    const camera = new FollowCamera(1.7);
    camera.update(0.016, { ...REST, heading: 0.5 }, { view: 'first-person' });
    const at = camera.camera.position;
    expect(at.y).toBeGreaterThan(1.4);
    expect(at.y).toBeLessThan(2);
    expect(Math.hypot(at.x, at.z)).toBeLessThan(1);
    expect(lookOf(camera).x).toBeCloseTo(Math.cos(0.5), 6);
  });

  it('turns after the player rather than with them in third person', () => {
    const camera = new FollowCamera(1.7);
    camera.update(0.016, REST, { view: 'third-person' });
    camera.update(0.016, { ...REST, heading: 1 }, { view: 'third-person' });
    const turned = camera.heading - yawBehind(0);
    expect(Math.abs(turned)).toBeGreaterThan(0);
    expect(Math.abs(turned)).toBeLessThan(0.2);
  });

  it('goes back to north in top down', () => {
    const camera = new FollowCamera(1.7);
    camera.update(0.016, { ...REST, heading: 1 }, { view: 'first-person' });
    camera.update(0.016, REST);
    expect(camera.view).toBe('top-down');
    expect(camera.heading).toBe(0);
    expect(camera.camera.near).toBe(1);
  });
});

describe('the walking keys under a turned view', () => {
  it('walk up the screen, which is where the camera looks', () => {
    for (const yaw of [0, 0.7, -2, Math.PI]) {
      // The walk of `walker-body.ts` moves along (steer, -throttle) on the map.
      const w = turned(1, 0, yaw);
      expect(w.steer).toBeCloseTo(-Math.sin(yaw), 9);
      expect(-w.throttle).toBeCloseTo(-Math.cos(yaw), 9);
      const d = turned(0, 1, yaw);
      expect(d.steer).toBeCloseTo(Math.cos(yaw), 9);
      expect(-d.throttle).toBeCloseTo(-Math.sin(yaw), 9);
    }
  });

  it('hands the keys through untouched while the camera looks north', () => {
    expect(turned(1, -1, 0)).toEqual({ throttle: 1, steer: -1 });
  });
});

/** A storage held in a map, as `localStorage` holds it in the browser. */
function memoryStore(): KeyValueStore {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

describe('the view setting', () => {
  it('starts top down, and steps through every view', () => {
    expect(DEFAULT_SETTINGS.view).toBe('top-down');
    let view = DEFAULT_SETTINGS.view;
    for (let i = 0; i < CAMERA_VIEWS.length; i++) view = nextView(view);
    expect(view).toBe('top-down');
    expect(nextView('top-down')).toBe('third-person');
  });

  it('keeps a choice, and falls back on a value it does not know', () => {
    const store = memoryStore();
    writeSettings(store, { ...DEFAULT_SETTINGS, view: 'first-person', buildingView: 'turn' });
    expect(readSettings(store).view).toBe('first-person');
    expect(readSettings(store).buildingView).toBe('turn');
    store.setItem('sunset-driver.settings', '{"view":"sideways"}');
    expect(readSettings(store).view).toBe('top-down');
  });
});

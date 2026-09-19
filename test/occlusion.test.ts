/**
 * A building between the camera and the player (spec section 10.7): the boxes
 * the chunks carry, the camera that pulls back over them, and the setting that
 * picks what happens.
 */
import { BoxGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FollowCamera, pullOver } from '../src/render/camera.ts';
import { roofOver, ROOF_STRIDE, writeRoof } from '../src/render/roofs.ts';
import type { KeyValueStore } from '../src/ui/saves.ts';
import { DEFAULT_SETTINGS, readSettings, writeSettings } from '../src/ui/settings.ts';

/** The packed box of a building `width` by `depth` by `height`, turned `angle` about the up axis. */
function roofOf(x: number, z: number, width: number, depth: number, height: number, angle = 0): Float32Array {
  // A shell stands on its own origin, as `building-mesh.ts` builds it.
  const hull = new BoxGeometry(width, height, depth).translate(0, height / 2, 0);
  const matrix = new Matrix4().compose(
    new Vector3(x, 0, z),
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle),
    new Vector3(1, 1, 1),
  );
  const out = new Float32Array(ROOF_STRIDE);
  writeRoof(out, 0, hull, matrix);
  return out;
}

describe('roof boxes', () => {
  it('find the tallest building over a point, and nothing over open ground', () => {
    const low = roofOf(0, 0, 20, 20, 10);
    const tall = roofOf(5, 0, 6, 6, 90);
    expect(roofOver([low, tall], 5, 0)?.top).toBeCloseTo(90, 4);
    expect(roofOver([low, tall], -8, 0)?.top).toBeCloseTo(10, 4);
    expect(roofOver([low, tall], 30, 0)).toBeUndefined();
    // The margin grows every footprint.
    expect(roofOver([low], 11, 0)).toBeUndefined();
    expect(roofOver([low], 11, 0, 1.5)?.top).toBeCloseTo(10, 4);
  });

  it('follow the turn of the lot', () => {
    // A long thin building turned a quarter lies along z rather than x.
    const turned = roofOf(0, 0, 40, 4, 20, Math.PI / 2);
    expect(roofOver([turned], 0, 15)).toBeDefined();
    expect(roofOver([turned], 15, 0)).toBeUndefined();
  });
});

describe('the camera over roofs', () => {
  const REST = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };

  it('stands where it always does over open ground', () => {
    const open = new FollowCamera(1.7);
    open.update(0, REST, () => undefined);
    const plain = new FollowCamera(1.7);
    plain.update(0, REST);
    expect(open.camera.position.distanceTo(plain.camera.position)).toBeCloseTo(0, 9);
  });

  it('pulls back along its view until it is over the roof under it', () => {
    const tower = roofOf(0, 25, 40, 30, 120);
    const roofs = (x: number, z: number): number | undefined => roofOver([tower], x, z)?.top;
    const camera = new FollowCamera(1.7);
    camera.update(0, REST, roofs);
    const at = camera.camera.position;
    expect(at.y).toBeGreaterThan(120);
    // Only the distance changed: the camera still looks at the player.
    expect(at.x).toBeCloseTo(0, 9);
    const look = new Vector3(0, 0, -1).applyQuaternion(camera.camera.quaternion);
    expect(at.clone().addScaledVector(look, at.length()).length()).toBeLessThan(1e-6);
  });

  it('climbs past a second roof that the first pull put it over', () => {
    // The camera first stands over the near roof alone. Over it, it has moved
    // back onto the edge of the far one, which stands taller.
    const near = roofOf(0, 22, 40, 24, 50);
    const far = roofOf(0, 50, 40, 34, 100);
    const back = new Vector3(0, 0, 1).applyEuler(new FollowCamera(1.7).camera.rotation);
    const pull = pullOver(new Vector3(), back, 36, (x, z) => roofOver([near, far], x, z)?.top);
    expect(back.y * (36 + pull)).toBeGreaterThan(100);
  });
});

/** A storage held in a map, as `localStorage` holds it in the browser. */
function memoryStore(): KeyValueStore {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

describe('the building view setting', () => {
  it('starts see-through, as GTA Chinatown Wars does', () => {
    expect(readSettings(memoryStore())).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.buildingView).toBe('see-through');
  });

  it('keeps a choice, and falls back on a value it does not know', () => {
    const store = memoryStore();
    writeSettings(store, { buildingView: 'pull-back', muted: true, northUp: true, gore: 'moderate' });
    expect(readSettings(store).buildingView).toBe('pull-back');
    expect(readSettings(store).muted).toBe(true);
    expect(readSettings(store).northUp).toBe(true);
    store.setItem('sunset-driver.settings', '{"buildingView":"sideways"}');
    expect(readSettings(store)).toEqual(DEFAULT_SETTINGS);
    store.setItem('sunset-driver.settings', 'not json');
    expect(readSettings(store)).toEqual(DEFAULT_SETTINGS);
  });
});

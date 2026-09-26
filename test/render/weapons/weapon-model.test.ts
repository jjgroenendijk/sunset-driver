import type { Group, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { PICKUP_MIN_LENGTH, PICKUP_SCALE, PickupModels, pickupScale } from '../../../src/render/weapons/pickups.ts';
import { HeldWeapon, WeaponArt } from '../../../src/render/weapons/weapon.ts';
import { weaponBoxes } from '../../../src/render/weapons/weapon-mesh.ts';
import { createPlayerState } from '../../../src/sim/player/on-foot.ts';
import { dropWeapon } from '../../../src/sim/weapons/pickup.ts';
import { createSimState } from '../../../src/sim/simulation.ts';
import { createLoadout, fitAttachment, giveWeapon, WEAPON_IDS } from '../../../src/sim/weapons/weapon.ts';

/**
 * The weapons of spec section 11.6, drawn: one merged geometry per weapon and
 * what is fitted to it, the weapon in the hands, and the pickups on the ground.
 * Nothing here needs a renderer.
 */
describe('the drawn weapons', () => {
  it('merges each weapon into one coloured geometry, built once per fit', () => {
    const art = new WeaponArt();
    for (const id of WEAPON_IDS) {
      const geometry = art.geometry(id, []);
      if (id === 'fists') {
        expect(geometry, id).toBeUndefined();
        continue;
      }
      // A box is 24 vertices, one set per face so the faces stay flat.
      expect(geometry?.getAttribute('position').count, id).toBe(weaponBoxes(id).length * 24);
      expect(geometry?.getAttribute('color').count, id).toBe(weaponBoxes(id).length * 24);
    }
    const built = art.size;
    expect(art.geometry('m4a1', [])).toBe(art.geometry('m4a1', []));
    expect(art.size).toBe(built);
    // A suppressor is another model, and one the M4 cannot take changes nothing.
    expect(art.geometry('m4a1', ['suppressor'])).not.toBe(art.geometry('m4a1', []));
    expect(art.geometry('model-29', ['suppressor'])).toBe(art.geometry('model-29', []));
    art.dispose();
    expect(art.size).toBe(0);
  });

  it('draws the weapon in the hands on foot, with its attachments, and nothing from a seat', () => {
    const art = new WeaponArt();
    const held = new HeldWeapon(art);
    const loadout = createLoadout();
    const player = createPlayerState();
    const pose = { x: 10, y: 20, height: 3, heading: 0 };
    player.driving = false;
    held.set(loadout, player, pose, 1.8);
    expect(held.shown).toBe(false);
    giveWeapon(loadout, 'ak-47');
    fitAttachment(loadout, 'ak-47', 'optic');
    held.set(loadout, player, pose, 1.8);
    expect(held.shown).toBe(true);
    expect(held.group.position.toArray()).toEqual([10, 3, 20]);
    // The weapon hangs off the hand, which is what a swing turns.
    const hand = held.group.children[0] as Group;
    const mesh = hand.children[0] as Mesh;
    expect(mesh.geometry).toBe(art.geometry('ak-47', ['optic']));
    player.driving = true;
    held.set(loadout, player, pose, 1.8);
    expect(held.shown).toBe(false);
    held.dispose();
    art.dispose();
  });

  it('draws a pickup while it lies, and lets it go when it is taken', () => {
    const art = new WeaponArt();
    const models = new PickupModels(art);
    const state = createSimState(1);
    dropWeapon(state, 'uzi', 32, 0, [], 5, 6, 1);
    dropWeapon(state, 'katana', 0, 0, [], 8, 6, 1);
    models.update(state.pickups, 100);
    expect(models.count).toBe(2);
    expect(models.group.children[0]?.position.toArray()).toEqual([5, 1, 6]);
    state.pickups.shift();
    models.update(state.pickups, 101);
    expect(models.count).toBe(1);
    expect(models.group.children).toHaveLength(1);
    // Two dropped weapons of one kind share one geometry.
    dropWeapon(state, 'katana', 0, 0, [], 9, 6, 1);
    models.update(state.pickups, 102);
    expect(art.size).toBe(2);
    models.dispose();
    art.dispose();
  });

  it('grows the pickup under the mouse, and lets it shrink back', async () => {
    const { PerspectiveCamera, Raycaster, Vector2 } = await import('three');
    const art = new WeaponArt();
    const models = new PickupModels(art);
    const state = createSimState(1);
    dropWeapon(state, 'glock-17', 17, 0, [], 0, 0, 0);
    dropWeapon(state, 'mp5', 30, 0, [], 6, 0, 0);
    models.update(state.pickups, 0, 0);
    models.group.updateMatrixWorld(true);
    // A camera straight above the pistol, looking down through the middle of the view.
    const camera = new PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 30, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(0, 0), camera);
    const pistol = state.pickups[0]?.id as number;
    const smg = state.pickups[1]?.id as number;
    expect(models.pick(ray)).toBe(pistol);
    for (let frame = 0; frame < 30; frame++) models.update(state.pickups, frame, 1 / 60);
    expect(models.grownOf(pistol)).toBeGreaterThan(0.95);
    expect(models.grownOf(smg)).toBe(0);
    // The mouse moves off: nothing is picked, and the pistol shrinks back.
    ray.setFromCamera(new Vector2(0.9, 0.9), camera);
    expect(models.pick(ray)).toBeUndefined();
    for (let frame = 0; frame < 30; frame++) models.update(state.pickups, frame, 1 / 60);
    expect(models.grownOf(pistol)).toBeLessThan(0.05);
    models.dispose();
    art.dispose();
  });

  it('draws a short weapon larger than a long one, so a pistol on the ground is not a speck', () => {
    const art = new WeaponArt();
    expect(pickupScale(art.geometry('m4a1', []))).toBe(PICKUP_SCALE);
    const pistol = art.geometry('glock-17', []);
    pistol?.computeBoundingBox();
    const box = pistol?.boundingBox;
    const scale = pickupScale(pistol);
    expect(scale).toBeGreaterThan(PICKUP_SCALE);
    expect(((box?.max.x ?? 0) - (box?.min.x ?? 0)) * scale).toBeCloseTo(PICKUP_MIN_LENGTH);
    art.dispose();
  });
});

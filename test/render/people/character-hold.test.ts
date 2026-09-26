import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { gripOf, holdOf, holdOver, KICK_TICKS, pointArm } from '../../../src/render/people/character-hold.ts';
import { CharacterModel } from '../../../src/render/people/character.ts';
import { poseFor } from '../../../src/render/people/character-pose.ts';
import { HeldWeapon, WeaponArt } from '../../../src/render/weapons/weapon.ts';
import { DEFAULT_APPEARANCE } from '../../../src/sim/player/character.ts';
import { createPlayerState } from '../../../src/sim/player/on-foot.ts';
import { createLoadout, giveWeapon } from '../../../src/sim/weapons/weapon.ts';

const STILL = { speed: 0, grounded: true, vy: 0, depth: 0, stature: 1.8 };

/** Where the model's right fist is with the arms holding `grip`, aimed or not. */
function fistOf(model: CharacterModel, grip: 'pistol' | 'long', aim: number): Vector3 {
  model.pose(poseFor('stand', 0, STILL), { grip, aim, kick: 0 });
  const fist = model.grip(new Vector3());
  if (fist === undefined) throw new Error('no grip');
  return fist;
}

/** The arms holding a gun (spec sections 11.5, 11.6). */
describe('the hold', () => {
  it('holds a gun in the hands and swings a melee weapon', () => {
    expect(gripOf('melee')).toBe('none');
    expect(gripOf('pistol')).toBe('pistol');
    expect(gripOf('rifle')).toBe('long');
    expect(gripOf('smg')).toBe('long');
    expect(gripOf('thrown')).toBe('one');
  });

  it('points an arm at the point it is asked to reach', () => {
    // Straight ahead is a quarter turn forward, and straight down no turn at all.
    expect(pointArm([0, 1, 0], [1, 1, 0], 0).arm).toBeCloseTo(Math.PI / 2);
    expect(pointArm([0, 1, 0], [0, 0, 0], 0).arm).toBeCloseTo(0);
    // A point across the body, toward -z, is a turn of positive yaw.
    expect(pointArm([0, 1, 0.2], [0.5, 1, 0], 0).yaw).toBeGreaterThan(0);
  });

  it('puts the right fist in front of the body, and raises it to aim', () => {
    const model = new CharacterModel(DEFAULT_APPEARANCE);
    for (const grip of ['pistol', 'long'] as const) {
      const hip = fistOf(model, grip, 0);
      const aimed = fistOf(model, grip, 1);
      expect(hip.x, grip).toBeGreaterThan(0.15);
      expect(aimed.y, grip).toBeGreaterThan(hip.y + 0.1);
      // Aimed, the gun comes in toward the middle of the body.
      expect(Math.abs(aimed.z), grip).toBeLessThan(hip.z);
    }
    model.pose(poseFor('stand', 0, STILL));
    expect(model.grip(new Vector3())).toBeUndefined();
    model.dispose();
  });

  it('takes a long gun in both hands, and a pistol in both only when aimed', () => {
    const pose = (grip: 'pistol' | 'long', aim: number) =>
      holdOver(poseFor('walk', 1, { ...STILL, speed: 3 }), { grip, aim, kick: 0 }, { shoulderX: 0.26, shoulderY: 0.5, reach: 0.5 });
    const free = poseFor('walk', 1, { ...STILL, speed: 3 });
    expect(pose('pistol', 0).armL).toBeCloseTo(free.armL);
    expect(pose('pistol', 1).armL).toBeGreaterThan(1);
    expect(pose('long', 0).armL).toBeGreaterThan(0.8);
  });

  it('kicks the hands at a shot and lets them settle', () => {
    const loadout = createLoadout();
    giveWeapon(loadout, 'glock-17');
    loadout.firedTick = 100;
    expect(holdOf(loadout, 100).kick).toBe(1);
    expect(holdOf(loadout, 100 + KICK_TICKS / 2).kick).toBeGreaterThan(0);
    expect(holdOf(loadout, 100 + KICK_TICKS).kick).toBe(0);
    expect(holdOf(loadout, 99).kick).toBe(0);
  });

  it('draws the gun in the fist that holds it', () => {
    const art = new WeaponArt();
    const held = new HeldWeapon(art);
    const loadout = createLoadout();
    giveWeapon(loadout, 'm4a1');
    const player = createPlayerState();
    player.driving = false;
    const fist = new Vector3(0.3, 1.1, 0.1);
    held.set(loadout, player, { x: 0, y: 0, height: 0, heading: 0 }, 1.8, -1, fist, 1);
    const mesh = held.group.children[0]?.children[0];
    expect(mesh?.position.toArray()).toEqual([0.3, 1.1, 0.1]);
    expect(mesh?.rotation.z).toBeGreaterThan(0);
    held.dispose();
    art.dispose();
  });
});

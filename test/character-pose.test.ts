import { Box3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CharacterModel } from '../src/render/character.ts';
import {
  advancePhase,
  cycleRate,
  poseFor,
  stanceOf,
  STRIDE,
  type CharacterMotion,
} from '../src/render/character-pose.ts';
import { JUMP_SPEED, SPRINT_SPEED, WALK_SPEED } from '../src/sim/on-foot.ts';

/**
 * The player moves (spec sections 11.2, 11.5): the legs and the arms swing at
 * the pace of the ground covered, a jump and a fall hold a pose of their own,
 * and deep water is swum across. `character-pose.ts` is the pure half and
 * `character.ts` the rig it is written into.
 */
const STATURE = 1.78;

function motion(over: Partial<CharacterMotion> = {}): CharacterMotion {
  return { speed: 0, grounded: true, vy: 0, depth: 0, stature: STATURE, ...over };
}

describe('the player pose', () => {
  it('walks the legs and the arms against each other', () => {
    const walking = motion({ speed: WALK_SPEED });
    expect(stanceOf(walking)).toBe('walk');
    const pose = poseFor('walk', Math.PI / 2, walking);
    // A quarter through the cycle one thigh is forward and the other is back,
    // and each arm goes with the other side's leg.
    expect(pose.thighL).toBeGreaterThan(0.2);
    expect(pose.thighR).toBeLessThan(-0.2);
    expect(Math.sign(pose.armL)).toBe(-Math.sign(pose.thighL));
    expect(Math.sign(pose.armR)).toBe(-Math.sign(pose.thighR));
    // The knee bends while its leg swings through, and never the wrong way.
    for (const phase of [0, 1, 2, 3, 4, 5]) {
      const step = poseFor('walk', phase, walking);
      expect(step.kneeL).toBeLessThanOrEqual(0);
      expect(step.kneeR).toBeLessThanOrEqual(0);
    }
  });

  it('swings further and leans more the faster the player goes', () => {
    const slow = poseFor('walk', Math.PI / 2, motion({ speed: WALK_SPEED }));
    const fast = poseFor('walk', Math.PI / 2, motion({ speed: SPRINT_SPEED }));
    expect(fast.thighL).toBeGreaterThan(slow.thighL);
    expect(Math.abs(fast.armL)).toBeGreaterThan(Math.abs(slow.armL));
    expect(fast.lean).toBeGreaterThan(slow.lean);
  });

  it('takes one cycle for every stride walked, whatever the frame rate', () => {
    const seconds = STRIDE / WALK_SPEED;
    let coarse = 0;
    for (let i = 0; i < 4; i++) coarse = advancePhase(coarse, 'walk', WALK_SPEED, seconds / 4);
    let fine = 0;
    for (let i = 0; i < 240; i++) fine = advancePhase(fine, 'walk', WALK_SPEED, seconds / 240);
    expect(coarse).toBeCloseTo(fine, 6);
    // A whole cycle brings the phase back to where it started.
    expect(Math.min(coarse, 2 * Math.PI - coarse)).toBeLessThan(1e-6);
    expect(cycleRate('walk', SPRINT_SPEED)).toBeGreaterThan(cycleRate('walk', WALK_SPEED));
  });

  it('still breathes while standing still', () => {
    expect(stanceOf(motion())).toBe('stand');
    const held = poseFor('stand', Math.PI / 2, motion());
    expect(held.thighL).toBe(0);
    expect(Math.abs(held.armL)).toBeGreaterThan(0);
  });

  it('holds a pose of its own in the air, and tucks on the way up', () => {
    const rising = motion({ grounded: false, vy: JUMP_SPEED });
    const falling = motion({ grounded: false, vy: -JUMP_SPEED });
    expect(stanceOf(rising)).toBe('air');
    const up = poseFor('air', 0, rising);
    const down = poseFor('air', 0, falling);
    // The leading knee is tucked at the top of the jump and reaches for the
    // ground on the way down, and the arms come up with it.
    expect(up.kneeL).toBeLessThan(down.kneeL);
    expect(up.thighL).toBeGreaterThan(down.thighL);
    expect(up.armL).toBeLessThan(down.armL);
    // The air holds its pose: there is no cycle to run.
    expect(cycleRate('air', 3)).toBe(0);
    expect(advancePhase(1.2, 'air', 3, 1)).toBeCloseTo(1.2, 6);
  });

  it('swims in deep water and wades through shallow water', () => {
    const deep = motion({ depth: 1.6, grounded: true });
    const shallow = motion({ depth: 0.9, speed: WALK_SPEED });
    expect(stanceOf(deep)).toBe('swim');
    expect(stanceOf(shallow)).toBe('walk');
    const pose = poseFor('swim', 0, deep);
    // The body lies forward and is carried up to the surface it floats on.
    expect(pose.pitch).toBeLessThan(-1);
    expect(pose.lift).toBeGreaterThan(1);
    expect(pose.lift).toBeLessThan(deep.depth);
  });

  it('turns each arm a full circle a half stroke apart', () => {
    const deep = motion({ depth: 1.6 });
    const reach: number[] = [];
    for (let i = 0; i < 8; i++) {
      const phase = (i / 8) * 2 * Math.PI;
      const pose = poseFor('swim', phase, deep);
      // An arm hanging at 0 points at the feet and at π it points past the
      // head, so the sine of the angle is how far forward it reaches.
      reach.push(Math.sin(pose.armL));
      expect(Math.abs(pose.armL - pose.armR)).toBeCloseTo(Math.PI, 6);
    }
    expect(Math.max(...reach)).toBeGreaterThan(0.9);
    expect(Math.min(...reach)).toBeLessThan(-0.9);
  });
});

describe('the player model', () => {
  it('writes the walk into its rig, and puts nothing through the ground', () => {
    const model = new CharacterModel({ body: 1, skin: 0, hair: 0, hairColour: 0, outfit: 0 });
    const standing = new Box3().setFromObject(model.group);
    model.animate(motion({ speed: WALK_SPEED }), 0.25);
    expect(model.at.stance).toBe('walk');
    expect(model.at.phase).toBeGreaterThan(0);
    const walking = new Box3().setFromObject(model.group);
    // A swung leg and a swung arm reach ahead of the body it started in.
    expect(walking.max.x).toBeGreaterThan(standing.max.x);
    expect(walking.min.x).toBeLessThan(standing.min.x);
    // The model is still the same height: the walk moves it, it does not grow.
    expect(walking.max.y).toBeLessThan(standing.max.y + 0.1);
    model.dispose();
  });

  it('lies forward on the water when it swims', () => {
    const model = new CharacterModel({ body: 1, skin: 0, hair: 0, hairColour: 0, outfit: 0 });
    const height = model.height;
    model.animate(motion({ depth: 0.9 * height, speed: 1 }), 0.1);
    expect(model.at.stance).toBe('swim');
    const bounds = new Box3().setFromObject(model.group);
    // The model's origin is at the feet, which the record hangs under the
    // water; the surface stands that depth above it.
    const surface = 0.9 * height;
    // The body lies down, so it is longer than it is tall.
    expect(bounds.max.x - bounds.min.x).toBeGreaterThan(height * 0.7);
    // And it floats: the body lies at the surface, with the reaching arm over
    // it and the rest of it under.
    expect(bounds.max.y).toBeGreaterThan(surface - 0.6);
    expect(bounds.max.y).toBeLessThan(surface + 0.9);
    expect(bounds.min.y).toBeLessThan(surface);
    model.dispose();
  });
});

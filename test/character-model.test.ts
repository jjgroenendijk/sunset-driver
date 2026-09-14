import { Box3, Mesh, type MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { CharacterModel } from '../src/render/character.ts';
import {
  BODY_TYPES,
  type CharacterAppearance,
  HAIR_STYLES,
  normaliseAppearance,
  randomAppearance,
  resolveAppearance,
  SKIN_TONES,
} from '../src/sim/character.ts';
import { sweepSeeds } from './helpers.ts';

function colours(model: CharacterModel): number[] {
  const found: number[] = [];
  model.group.traverse((object) => {
    if (object instanceof Mesh) found.push((object.material as MeshStandardMaterial).color.getHex());
  });
  return found;
}

describe('the player model', () => {
  it('stands on the ground at the height of its body type', () => {
    for (let body = 0; body < BODY_TYPES.length; body++) {
      const type = BODY_TYPES[body] as (typeof BODY_TYPES)[number];
      const model = new CharacterModel({ body, skin: 0, hair: 0, hairColour: 0, outfit: 0 });
      const bounds = new Box3().setFromObject(model.group);
      expect(bounds.min.y).toBeCloseTo(0, 3);
      expect(bounds.max.y).toBeCloseTo(type.height, 3);
      // Shoulders and arms are the widest part, so the model reads from above.
      // They lie across the way it faces, along local z.
      expect(bounds.max.z - bounds.min.z).toBeGreaterThan(type.shoulder);
      expect(bounds.max.x - bounds.min.x).toBeLessThan(type.shoulder);
      expect(model.height).toBe(type.height);
      model.dispose();
    }
  });

  it('faces local +x, the way a yaw of -heading turns along the heading', () => {
    const tallest = HAIR_STYLES.length - 1;
    const appearance: CharacterAppearance = { body: 1, skin: 0, hair: tallest, hairColour: 0, outfit: 0 };
    const model = new CharacterModel(appearance);
    const parts = resolveAppearance(appearance);
    const centres = (colour: number): number[] => {
      const found: number[] = [];
      model.group.traverse((object) => {
        if (object instanceof Mesh && (object.material as MeshStandardMaterial).color.getHex() === colour) {
          found.push(object.position.x);
        }
      });
      return found;
    };
    // The shoes reach forward and the long hair falls behind.
    for (const x of centres(parts.outfit.shoe)) expect(x).toBeGreaterThan(0);
    expect(Math.min(...centres(parts.hairColour.colour))).toBeLessThan(0);
    model.dispose();
  });

  it('grows no taller when the hair does', () => {
    const tallest = HAIR_STYLES.length - 1;
    const cropped = new CharacterModel({ body: 1, skin: 0, hair: 0, hairColour: 0, outfit: 0 });
    const flowing = new CharacterModel({ body: 1, skin: 0, hair: tallest, hairColour: 0, outfit: 0 });
    const a = new Box3().setFromObject(cropped.group);
    const b = new Box3().setFromObject(flowing.group);
    expect(b.max.y).toBeCloseTo(a.max.y, 3);
    expect(b.min.y).toBeCloseTo(0, 3);
    cropped.dispose();
    flowing.dispose();
  });

  it('shows the chosen skin, hair and outfit colours', () => {
    for (const seed of sweepSeeds(24)) {
      const appearance = randomAppearance(seed);
      const parts = resolveAppearance(appearance);
      const model = new CharacterModel(appearance);
      const used = new Set(colours(model));
      expect(used.has(parts.skin.colour)).toBe(true);
      expect(used.has(parts.hairColour.colour)).toBe(true);
      expect(used.has(parts.outfit.top)).toBe(true);
      model.dispose();
    }
  });

  it('rebuilds on a new choice and keeps no old parts', () => {
    const model = new CharacterModel({ body: 0, skin: 0, hair: 0, hairColour: 0, outfit: 0 });
    const before = model.group.children.length;
    const next: CharacterAppearance = { body: 2, skin: SKIN_TONES.length - 1, hair: 2, hairColour: 3, outfit: 3 };
    model.set(next);
    expect(model.group.children.length).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
    expect(new Set(colours(model)).has(resolveAppearance(next).skin.colour)).toBe(true);
    expect(new Set(colours(model)).has((SKIN_TONES[0] as { colour: number }).colour)).toBe(false);
    model.dispose();
    expect(model.group.children.length).toBe(0);
  });

  it('accepts an appearance that a save left out of range', () => {
    const model = new CharacterModel({ body: 99, skin: -4, hair: 1.9, hairColour: 12, outfit: 7 });
    const parts = resolveAppearance(normaliseAppearance({ body: 99, skin: -4, hair: 1.9, hairColour: 12, outfit: 7 }));
    expect(new Box3().setFromObject(model.group).max.y).toBeCloseTo(parts.body.height, 3);
    model.dispose();
  });
});

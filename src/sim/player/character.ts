/**
 * The player's look (spec section 11.1). Every option is an index into a small
 * table, so the choice is plain serialisable data that travels with the save
 * and, later, with the player over the network. The tables hold the numbers the
 * renderer needs; nothing here touches three.js or the DOM.
 */
import { genRng, Subsystem } from '../../core/rng.ts';

/** An option the player can pick, and what the renderer draws for it. */
export interface Swatch {
  id: string;
  label: string;
  colour: number;
}

export interface BodyType {
  id: string;
  label: string;
  /** Metres from the ground to the top of the head. */
  height: number;
  /** Shoulder and hip width in metres; the silhouette read from above. */
  shoulder: number;
  hip: number;
}

export interface HairStyle {
  id: string;
  label: string;
  /** How far the hair falls below the crown, in metres. 0 is shaved. */
  length: number;
  /** How far it stands out from the skull, in metres. */
  volume: number;
}

export interface Outfit {
  id: string;
  label: string;
  top: number;
  bottom: number;
  shoe: number;
}

export const BODY_TYPES: readonly BodyType[] = [
  { id: 'slim', label: 'Slim', height: 1.72, shoulder: 0.42, hip: 0.32 },
  { id: 'average', label: 'Average', height: 1.78, shoulder: 0.48, hip: 0.38 },
  { id: 'broad', label: 'Broad', height: 1.84, shoulder: 0.58, hip: 0.46 },
];

export const SKIN_TONES: readonly Swatch[] = [
  { id: 'porcelain', label: 'Porcelain', colour: 0xf2d3bd },
  { id: 'sand', label: 'Sand', colour: 0xe0b190 },
  { id: 'olive', label: 'Olive', colour: 0xc08a5e },
  { id: 'bronze', label: 'Bronze', colour: 0x9a6540 },
  { id: 'umber', label: 'Umber', colour: 0x6f4326 },
  { id: 'ebony', label: 'Ebony', colour: 0x4a2b18 },
];

export const HAIR_STYLES: readonly HairStyle[] = [
  { id: 'shaved', label: 'Shaved', length: 0, volume: 0.01 },
  { id: 'crop', label: 'Crop', length: 0.02, volume: 0.03 },
  { id: 'curls', label: 'Curls', length: 0.05, volume: 0.09 },
  { id: 'bob', label: 'Bob', length: 0.14, volume: 0.05 },
  { id: 'long', label: 'Long', length: 0.34, volume: 0.05 },
];

export const HAIR_COLOURS: readonly Swatch[] = [
  { id: 'black', label: 'Black', colour: 0x1b1418 },
  { id: 'brown', label: 'Brown', colour: 0x4a2f1d },
  { id: 'blonde', label: 'Blonde', colour: 0xd8b268 },
  { id: 'auburn', label: 'Auburn', colour: 0x8c3b1e },
  { id: 'grey', label: 'Grey', colour: 0xb3aeb0 },
  { id: 'neon', label: 'Neon', colour: 0xff4fa3 },
];

export const OUTFITS: readonly Outfit[] = [
  { id: 'streetwear', label: 'Streetwear', top: 0xe45a3c, bottom: 0x2b2f42, shoe: 0xf2ede6 },
  { id: 'tracksuit', label: 'Tracksuit', top: 0x3f7fbf, bottom: 0x3f7fbf, shoe: 0x1b1418 },
  { id: 'workwear', label: 'Workwear', top: 0xd8a544, bottom: 0x4a4336, shoe: 0x3a2a1c },
  { id: 'suit', label: 'Suit', top: 0x23202b, bottom: 0x23202b, shoe: 0x151217 },
  { id: 'beachwear', label: 'Beachwear', top: 0x2fbfa5, bottom: 0xf2ede6, shoe: 0xd8a544 },
  { id: 'leather', label: 'Leather jacket', top: 0x2a2320, bottom: 0x2e3a56, shoe: 0x1b1418 },
  { id: 'hoodie', label: 'Hoodie', top: 0x6b6f78, bottom: 0x23252b, shoe: 0xf2ede6 },
  { id: 'hawaiian', label: 'Hawaiian shirt', top: 0xe8a23a, bottom: 0xd9ceb5, shoe: 0x8a5a3a },
  { id: 'camo', label: 'Camo', top: 0x5b6b3a, bottom: 0x4a5530, shoe: 0x3a2a1c },
  { id: 'scrubs', label: 'Scrubs', top: 0x5fb3b3, bottom: 0x5fb3b3, shoe: 0xf2ede6 },
  { id: 'varsity', label: 'Varsity jacket', top: 0x8c1f28, bottom: 0x2b2f42, shoe: 0xf2ede6 },
  { id: 'linen', label: 'Linen suit', top: 0xefe6d2, bottom: 0xcbb994, shoe: 0x8a5a3a },
];

/** The player's look, as saved. Each field indexes the table of the same name. */
export interface CharacterAppearance {
  body: number;
  skin: number;
  hair: number;
  hairColour: number;
  outfit: number;
}

export type CharacterChoiceKey = keyof CharacterAppearance;

/** One row of the character creator: a label and the options behind it. */
export interface CharacterChoice {
  key: CharacterChoiceKey;
  label: string;
  options: readonly { id: string; label: string }[];
}

/** Every choice, in the order the title screen shows them. */
export const CHARACTER_CHOICES: readonly CharacterChoice[] = [
  { key: 'body', label: 'Build', options: BODY_TYPES },
  { key: 'skin', label: 'Skin tone', options: SKIN_TONES },
  { key: 'hair', label: 'Hair', options: HAIR_STYLES },
  { key: 'hairColour', label: 'Hair colour', options: HAIR_COLOURS },
  { key: 'outfit', label: 'Outfit', options: OUTFITS },
];

export const DEFAULT_APPEARANCE: Readonly<CharacterAppearance> = Object.freeze({
  body: 1,
  skin: 2,
  hair: 1,
  hairColour: 1,
  outfit: 0,
});

function optionCount(key: CharacterChoiceKey): number {
  for (const choice of CHARACTER_CHOICES) {
    if (choice.key === key) return choice.options.length;
  }
  return 1;
}

/** Fold any number onto a valid option index, so a hand-edited save still loads. */
function wrapIndex(value: unknown, count: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
  return ((n % count) + count) % count;
}

/** A valid appearance built from whatever a save or a URL offered. */
export function normaliseAppearance(input?: Partial<CharacterAppearance> | null): CharacterAppearance {
  const source = input ?? DEFAULT_APPEARANCE;
  return {
    body: wrapIndex(source.body, BODY_TYPES.length),
    skin: wrapIndex(source.skin, SKIN_TONES.length),
    hair: wrapIndex(source.hair, HAIR_STYLES.length),
    hairColour: wrapIndex(source.hairColour, HAIR_COLOURS.length),
    outfit: wrapIndex(source.outfit, OUTFITS.length),
  };
}

/** Step one choice forward or backward, wrapping at both ends. */
export function cycleChoice(
  appearance: CharacterAppearance,
  key: CharacterChoiceKey,
  delta: number,
): CharacterAppearance {
  const next = normaliseAppearance(appearance);
  next[key] = wrapIndex(next[key] + delta, optionCount(key));
  return next;
}

/** The look a seed gives when the player asks for one rather than picking. */
export function randomAppearance(seed: number): CharacterAppearance {
  const rng = genRng(seed, Subsystem.Character);
  return {
    body: rng.int(0, BODY_TYPES.length - 1),
    skin: rng.int(0, SKIN_TONES.length - 1),
    hair: rng.int(0, HAIR_STYLES.length - 1),
    hairColour: rng.int(0, HAIR_COLOURS.length - 1),
    outfit: rng.int(0, OUTFITS.length - 1),
  };
}

/** The tables an appearance points at, resolved for the renderer. */
export interface ResolvedAppearance {
  body: BodyType;
  skin: Swatch;
  hair: HairStyle;
  hairColour: Swatch;
  outfit: Outfit;
}

export function resolveAppearance(appearance: CharacterAppearance): ResolvedAppearance {
  const a = normaliseAppearance(appearance);
  return {
    body: BODY_TYPES[a.body] as BodyType,
    skin: SKIN_TONES[a.skin] as Swatch,
    hair: HAIR_STYLES[a.hair] as HairStyle,
    hairColour: HAIR_COLOURS[a.hairColour] as Swatch,
    outfit: OUTFITS[a.outfit] as Outfit,
  };
}

/** The label shown for one choice, for the title screen and the pause menu. */
export function optionLabel(appearance: CharacterAppearance, key: CharacterChoiceKey): string {
  const index = wrapIndex(appearance[key], optionCount(key));
  for (const choice of CHARACTER_CHOICES) {
    if (choice.key === key) return choice.options[index]?.label ?? '';
  }
  return '';
}

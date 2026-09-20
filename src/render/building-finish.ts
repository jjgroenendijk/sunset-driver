/**
 * How one building is finished: the material of its walls, how weathered they
 * are, and how it lights up after dark (spec sections 10.3, 10.5).
 *
 * `building-style.ts` says which of the five styles a tall building takes. This
 * says what every building is made of and how it burns at night: a warehouse is
 * corrugated metal and lights whole bays in fluorescent white, a house is
 * siding or stucco and lights a few warm windows, a shop row stays lit late.
 *
 * All of it is drawn from the building's own seed, its kind and the wealth of
 * its district, so the same building is finished the same way in every session.
 *
 * The choice is carried on the geometry, as the colour is: every vertex of a
 * building takes the same {@link FinishCode}, and one material dresses the whole
 * batch. The code is three numbers in 0..1, because `facade-pack.ts` packs the
 * attribute into bytes and a byte is what survives that: the wall and the light
 * are one whole number stepped by {@link FINISH_STEP}, and the lit share and the
 * weathering are read straight off their channels.
 *
 * Pure, and free of three.js, so the geometry tests read it headless.
 */
import { hashInts } from '../core/hash.ts';
import type { BuildingKind } from '../world/buildings.ts';
import type { BuildingStyle } from './building-style.ts';

/**
 * What a wall is made of. The numbers are written into the geometry, so a
 * material is added at the end of the list and never renumbered.
 */
export const WALL_BRICK = 0;
export const WALL_STUCCO = 1;
export const WALL_SIDING = 2;
export const WALL_METAL = 3;
export const WALL_TILE = 4;
export const WALL_CONCRETE = 5;
/** How many there are, which is what the code is packed against. */
export const WALL_KINDS = 6;

/** The colour a building's windows burn at night. Numbered as the walls are. */
export const GLOW_WARM = 0;
export const GLOW_NEUTRAL = 1;
export const GLOW_COOL = 2;
/**
 * The white of an office floor. It is the one light that fills a whole storey
 * rather than a window at a time, and the one that goes out in the small hours.
 */
export const GLOW_FLUORESCENT = 3;
export const GLOW_KINDS = 4;

/**
 * The step of the whole number the first channel carries. A byte holds
 * 255 / {@link FINISH_STEP} steps, and the wall and the light together need
 * {@link WALL_KINDS} × {@link GLOW_KINDS} of them, so the step is as large as
 * it can be: a large step is a code that survives a byte with room to spare.
 */
export const FINISH_STEP = 8;

/** How a building is finished, before it is packed for the geometry. */
export interface BuildingFinish {
  /** Which of the six wall materials its walls are. */
  wall: number;
  /** The colour its windows burn at night. */
  glow: number;
  /** The share of its windows that are lit after dark, 0 to 1. */
  lit: number;
  /** How weathered its walls are: 0 is newly finished, 1 is grimy. */
  age: number;
}

/** What a vertex carries: the code, the lit share and the weathering. */
export type FinishCode = readonly [number, number, number];

/** The finish of a building with no choice recorded: plain stucco, half lit. */
export const PLAIN_FINISH: FinishCode = finishCode({
  wall: WALL_STUCCO,
  glow: GLOW_WARM,
  lit: 0.5,
  age: 0.4,
});

/**
 * The wall materials each kind of building may be finished in, in the order the
 * seed draws from. A warehouse is corrugated metal, a parking garage is raw
 * concrete, and a house is one of the light claddings.
 */
const KIND_WALLS: Record<BuildingKind, readonly number[]> = {
  tower: [WALL_CONCRETE, WALL_BRICK, WALL_TILE, WALL_STUCCO],
  'mid-rise': [WALL_BRICK, WALL_CONCRETE, WALL_STUCCO, WALL_TILE],
  'shop-row': [WALL_BRICK, WALL_STUCCO, WALL_TILE, WALL_BRICK],
  house: [WALL_SIDING, WALL_STUCCO, WALL_BRICK, WALL_SIDING],
  warehouse: [WALL_METAL, WALL_METAL, WALL_CONCRETE, WALL_METAL],
  roadhouse: [WALL_SIDING, WALL_STUCCO, WALL_BRICK, WALL_METAL],
  'parking-garage': [WALL_CONCRETE],
};

/** The wall each styled look insists on, whatever kind of building carries it. */
const STYLE_WALLS: Partial<Record<BuildingStyle, number>> = {
  glass: WALL_CONCRETE,
  brutalist: WALL_CONCRETE,
  deco: WALL_BRICK,
  miami: WALL_STUCCO,
};

/**
 * What each kind of building burns at night, and the share of its windows that
 * are lit. An office lights whole floors in fluorescent white; a block of flats
 * lights a few warm windows; a shop stays lit late in neutral light.
 */
const KIND_LIGHT: Record<BuildingKind, { glow: number; lit: number }> = {
  tower: { glow: GLOW_FLUORESCENT, lit: 0.5 },
  'mid-rise': { glow: GLOW_WARM, lit: 0.35 },
  'shop-row': { glow: GLOW_NEUTRAL, lit: 0.62 },
  house: { glow: GLOW_WARM, lit: 0.3 },
  warehouse: { glow: GLOW_FLUORESCENT, lit: 0.22 },
  roadhouse: { glow: GLOW_NEUTRAL, lit: 0.55 },
  'parking-garage': { glow: GLOW_COOL, lit: 0.72 },
};

/** How far either way from its kind's share a building's own draw may move it. */
const LIT_SPREAD = 0.18;

/** The salts the finish draws on. Each is its own stream off the building's seed. */
const SALT_WALL = 70;
const SALT_GLOW = 71;
const SALT_LIT = 72;
const SALT_AGE = 73;

/**
 * How weathered a wall is: a poor district is grimy and a rich one is kept, and
 * the building's own draw moves it either way, so one street is not all one age.
 */
const AGE_WEALTH = 0.55;
const AGE_SPREAD = 0.3;

/**
 * The finish of one building. `wealth` is its district's, 0 to 1, which is what
 * says how weathered the walls are and how likely a tower is to be an office
 * rather than flats.
 */
export function finishOf(kind: BuildingKind, look: BuildingStyle, seed: number, wealth: number): BuildingFinish {
  const styled = STYLE_WALLS[look];
  const walls = KIND_WALLS[kind];
  const light = KIND_LIGHT[kind];
  // A tall building in a poor district is flats rather than offices, so its
  // windows are warm and a few of them are lit.
  const flats = (kind === 'tower' || kind === 'mid-rise') && unit(seed, SALT_GLOW) > 0.3 + 0.55 * wealth;
  return {
    wall: styled ?? (walls[hashInts(seed, SALT_WALL) % walls.length] as number),
    glow: flats ? GLOW_WARM : light.glow,
    lit: clamp01(light.lit + (unit(seed, SALT_LIT) * 2 - 1) * LIT_SPREAD),
    age: clamp01(1 - AGE_WEALTH * wealth + (unit(seed, SALT_AGE) * 2 - 1) * AGE_SPREAD),
  };
}

/**
 * The finish as the three numbers a vertex carries. The first channel is the
 * wall and the light as one whole number, so both survive being packed into a
 * byte; the other two are read as they are.
 */
export function finishCode(finish: BuildingFinish): FinishCode {
  const code = finish.wall * GLOW_KINDS + finish.glow;
  return [(code * FINISH_STEP) / 255, clamp01(finish.lit), clamp01(finish.age)];
}

/** A number in 0..1 drawn from a seed and a salt, the same one every time. */
function unit(seed: number, salt: number): number {
  return hashInts(seed, salt) / 0x100000000;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

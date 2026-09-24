/**
 * How a building burns after dark (spec section 10.5).
 *
 * `building-finish.ts` gives every building the colour of its window light and
 * the share of its windows that are lit, and writes both on its vertices. This
 * draws them: which windows are on, what colour they burn, how a crown is
 * floodlit and when an aircraft beacon blinks.
 *
 * Nothing here is a light. A light reaches every fragment it can and the scene
 * holds a fixed budget of them (`docs/lighting.md`), so a lit window, a neon
 * strip, a floodlit crown and a beacon are all emissive surfaces, and the bloom
 * of `post.ts` is what makes them read as lamps.
 *
 * The whole night costs two noise fields and no more: one says which windows
 * are lit, and one is the draw a place makes — the colour of a neon strip, the
 * colour of a floodlit crown, the phase a beacon blinks on. A field is the
 * dearest thing the building material evaluates, so the second is drawn once by
 * the caller and handed to all three.
 *
 * `building-material.ts` is the only caller. Only it, the other `*-material.ts`
 * files and `tsl.ts` know about shader nodes.
 */
import { Color } from 'three';
import { GLOW_COOL, GLOW_FLUORESCENT, GLOW_NEUTRAL, GLOW_WARM } from './building-finish.ts';
import { float, fractalNoise, mix, positionWorld, smoothstep, step, vec3, type TslNode } from './tsl.ts';

/**
 * The four colours a window burns in: the warm lamp of a home, the neutral
 * white of a shop, the cool white of a lobby or a deck, and the fluorescent
 * green-white of an office floor.
 */
const GLOW_COLOURS: Record<number, number> = {
  [GLOW_WARM]: 0xffd9a2,
  [GLOW_NEUTRAL]: 0xfff1de,
  [GLOW_COOL]: 0xcadcff,
  [GLOW_FLUORESCENT]: 0xe4fff0,
};

/**
 * How hard a lit window burns, as a multiple of its colour. At 1 it stayed
 * under the bloom threshold of `post.ts` once exposed, and a lit tower read as
 * painted yellow rather than lit.
 */
export const WINDOW_GAIN = 1.1;

/**
 * How much of its light each kind of building loses in the small hours. An
 * office empties, a home turns in, and a shop stays lit late, which is the one
 * thing still burning at three in the morning.
 */
const LATE_DIM: Record<number, number> = {
  [GLOW_WARM]: 0.45,
  [GLOW_NEUTRAL]: 0,
  [GLOW_COOL]: 0.2,
  [GLOW_FLUORESCENT]: 0.8,
};

/** How soft the edge is between a lit window and a dark one. */
const LIT_EDGE = 0.08;

/** The neon of a Deco or a Miami edge after dark, and how hard it burns. */
const NEON_COLOURS = [0xff3d8b, 0x36e6ff, 0xffc93d];
export const NEON_GAIN = 1.4;

/** The colours a crown is floodlit in: plain white light, and a wash of colour. */
const FLOOD_WHITE = 0xfff0d2;
const FLOOD_GAIN = 0.7;

/** The red of an aircraft beacon, and how hard it burns while it is on. */
const BEACON_RED = 0xff2a18;
const BEACON_GAIN = 1.6;
/** The share of its cycle a beacon is lit for. */
const BEACON_ON = 0.22;

/** Metres of the grid the floodlights and the beacons draw their phase from. */
const DRAW_METRES = 34;

/** The colour one building's windows burn, off the light it carries. */
export function glowColour(glow: TslNode): TslNode {
  let colour = rgb(GLOW_COLOURS[GLOW_WARM] as number);
  for (const id of [GLOW_NEUTRAL, GLOW_COOL, GLOW_FLUORESCENT]) {
    colour = mix(colour, rgb(GLOW_COLOURS[id] as number), is(glow, id));
  }
  return colour;
}

/**
 * Which windows of a building are lit, as 1 on a lit one and 0 on a dark one.
 *
 * `cell` is the window grid the caller drew: which column, which floor and
 * which building. An office lights a whole floor at once, so its columns are
 * run together before the field is read; every other kind lights one window at
 * a time.
 *
 * `share` is the building's own share of lit windows and `late` how deep into
 * the night it is, which is what empties an office and leaves a shop burning.
 */
export function litWindows(cell: TslNode, glow: TslNode, share: TslNode, late: TslNode): TslNode {
  const floors = is(glow, GLOW_FLUORESCENT);
  const grid = vec3(mix(cell.x, float(0), floors), cell.y, cell.z);
  const draw = fractalNoise(grid.mul(0.37), 1).mul(0.5).add(0.5);
  // The share is what is lit, so the edge the draw is tested against is what is
  // not. A building that dims late raises that edge as the night wears on.
  const dim = lateDim(glow).mul(late);
  const edge = float(1).sub(share.mul(float(1).sub(dim)));
  return smoothstep(edge.sub(LIT_EDGE), edge.add(LIT_EDGE), draw);
}

/** How much of its light a building loses in the small hours, off its own light. */
function lateDim(glow: TslNode): TslNode {
  let dim = float(LATE_DIM[GLOW_WARM] as number);
  for (const id of [GLOW_NEUTRAL, GLOW_COOL, GLOW_FLUORESCENT]) {
    dim = mix(dim, float(LATE_DIM[id] as number), is(glow, id));
  }
  return dim;
}

/**
 * The colour of a neon strip. A building cannot pass its own seed to a shader,
 * so the colour is drawn from the ground the strip stands over: one building's
 * strips are all one colour, and its neighbour's are another.
 */
export function neonColour(draw: TslNode): TslNode {
  const first = mix(rgb(NEON_COLOURS[0] as number), rgb(NEON_COLOURS[1] as number), step(0.34, draw));
  return mix(first, rgb(NEON_COLOURS[2] as number), step(0.67, draw));
}

/**
 * The light on the crown of a tall building: plain floodlight on some, a wash
 * of the building's own neon colour on others. The same draw picks it, so one
 * building's crown is lit one way from the top of it to the bottom.
 */
export function crownLight(neon: TslNode, draw: TslNode): TslNode {
  return mix(rgb(FLOOD_WHITE), neon, step(0.55, draw)).mul(FLOOD_GAIN);
}

/**
 * The aircraft beacon, as the red it burns while it is on and nothing while it
 * is off. `phase` is the scene's own blink, 0 to 1 once a cycle, and each tower
 * takes its own offset from the draw of the ground it stands on, so a skyline
 * blinks out of step rather than as one lamp.
 */
export function beaconLight(phase: TslNode, draw: TslNode): TslNode {
  const at = phase.add(draw).fract();
  return rgb(BEACON_RED).mul(BEACON_GAIN).mul(float(1).sub(step(BEACON_ON, at)));
}

/**
 * The draw a place makes, in 0..1, over a grid of {@link DRAW_METRES}: the one
 * field the neon, the crowns and the beacons all read. A building cannot pass
 * its own seed to a shader, so the ground it stands on is what tells it from
 * its neighbour.
 */
export function placeDraw(): TslNode {
  const cell = vec3(positionWorld.x.div(DRAW_METRES).floor(), 0, positionWorld.z.div(DRAW_METRES).floor());
  return fractalNoise(cell.mul(0.43), 1).mul(0.5).add(0.5);
}

/** 1 where a light attribute carries exactly `id`, 0 everywhere else. */
function is(glow: TslNode, id: number): TslNode {
  return step(id - 0.5, glow).mul(float(1).sub(step(id + 0.5, glow)));
}

/** A colour constant in the working colour space, as a shader node. */
function rgb(hex: number): TslNode {
  const colour = new Color(hex);
  return vec3(colour.r, colour.g, colour.b);
}

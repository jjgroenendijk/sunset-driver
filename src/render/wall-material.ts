/**
 * What a wall is made of, and what the weather has done to it (spec section
 * 10.3).
 *
 * `building-finish.ts` picks a material for every building and writes it on the
 * vertices; this draws it. Six of them — brick, stucco, siding, corrugated
 * metal, tile and concrete — and the grime, the stains and the faded paint laid
 * over whichever one the wall carries. The build ships no image files, so all of
 * it is arithmetic on the metres the wall carries in its `uv`.
 *
 * The patterns cost no noise field of their own. A field is by far the dearest
 * thing the building material evaluates and it already draws two of them, so
 * every line and course here is a `fract` of the metres across or up the wall,
 * and the two fields it is handed are what break the regularity.
 *
 * A course of brick is 30 cm and the camera sees a wall from 200 m as often as
 * from 20 m, so each fine pattern is faded out with distance rather than left
 * to alias into a shimmer. What is left at that distance is the broad colour,
 * which is what a wall reads as from there anyway.
 *
 * `building-material.ts` is the only caller. Only it, the other `*-material.ts`
 * files and `tsl.ts` know about shader nodes.
 */
import { Color } from 'three';
import {
  WALL_BRICK,
  WALL_CONCRETE,
  WALL_METAL,
  WALL_SIDING,
  WALL_STUCCO,
  WALL_TILE,
} from './building-finish.ts';
import {
  float,
  luminance,
  mix,
  positionView,
  positionWorld,
  smoothstep,
  step,
  uv,
  vec3,
  type TslNode,
} from './tsl.ts';

/** Metres of one course of brick, and of one brick along the course. */
const BRICK = { course: 0.3, along: 0.62, mortar: 0.1 };

/** Metres of one board of siding, and how deep the shadow under its lap runs. */
const SIDING = { board: 0.26, lap: 0.35 };

/** Metres of one rib of corrugated metal. */
const RIB_METRES = 0.35;

/** Metres of one tile, and the share of it the grout takes. */
const TILE = { size: 0.34, grout: 0.14 };

/** Metres of one board of the shuttering a concrete wall is cast against. */
const BOARD_METRES = 0.45;

/** The mortar of a brick wall and the grout of a tiled one. */
const MORTAR = 0xbab2a4;

/**
 * Metres of camera distance a fine pattern fades out over. A course of brick is
 * 30 cm and the game camera stands 40 m to 200 m back, so the fade starts well
 * past the far end of that: faded any nearer, the walls the player drives past
 * are the flat tints this file replaces.
 */
const FINE_NEAR = 150;
const FINE_FAR = 320;

/**
 * Metres of wall over the ground the stain at its foot reaches, and the height
 * the faded paint starts at, halfway up a tall wall.
 */
const STAIN_RISE = 1.8;
const FADE_FROM = 18;

/** Metres of one storey, as the window bands and the grime strokes are spaced. */
const STOREY = 3.2;

/**
 * Metres of wall one column of grime strokes takes. Each column holds one
 * stroke or none, of its own width and length, so the strokes never line up.
 */
const STROKE_COLUMN = 0.9;

/**
 * The shade each mark is painted in, as a multiple of the wall's own colour:
 * darker and cooler, never brown (`docs/art-style.md`). Faded paint goes the
 * other way, toward a paler grey of the same brightness.
 */
const GRIME_SHADE: readonly [number, number, number] = [0.7, 0.72, 0.84];
const STAIN_SHADE: readonly [number, number, number] = [0.8, 0.8, 0.88];
const FADE = 0.28;

/**
 * Metres a stroke's edge is softened over, so it stays one hard edge on screen
 * without stepping into pixels. A painted stroke has an edge, not a fade.
 */
const EDGE = 0.04;

/**
 * The face of a wall in whichever of the six materials the building carries.
 *
 * `wall` is the material as a whole number off the vertex, `grain` and `patch`
 * the two noise fields the caller already drew, and `tint` the building's own
 * colour. Each material is drawn and then blended in on its own number, which
 * is one shader with six branches rather than six materials.
 */
export function wallSurface(tint: TslNode, wall: TslNode, grain: TslNode, patch: TslNode): TslNode {
  const fine = fineness();
  const looks: readonly [number, TslNode][] = [
    [WALL_BRICK, brick(tint, grain, fine)],
    [WALL_SIDING, siding(tint, grain, fine)],
    [WALL_METAL, metal(tint, grain, fine)],
    [WALL_TILE, tiled(tint, patch, fine)],
    [WALL_CONCRETE, concrete(tint, grain, patch, fine)],
  ];
  // Stucco is the one with no pattern of its own, so it is what the blend
  // starts from and what a wall falls back to.
  let surface = tint.mul(float(0.82).add(patch.mul(0.22)).add(grain.mul(0.1)));
  for (const [id, colour] of looks) surface = mix(surface, colour, at(wall, id));
  return surface;
}

/**
 * A wall as the weather leaves it, painted as the art style paints it: flat
 * strokes with hard edges, in a darker and cooler shade of the wall
 * (`docs/art-style.md`). Grime runs down from the sill of each storey, a stain
 * rises from the ground, and the paint high up is faded. `age` is the
 * building's own weathering off its vertices, 0 for a wall that is kept and 1
 * for one that is not: it sets how many strokes a wall carries.
 *
 * Every stroke is a hash of the metres the wall carries in its `uv`, not a
 * noise field, for the reason the materials are: a field here would be the
 * third of the frame.
 */
export function weathered(colour: TslNode, age: TslNode): TslNode {
  const across = uv().x;
  const up = uv().y;
  // One column of wall and one storey of it: each pair draws its own stroke.
  const column = across.div(STROKE_COLUMN).floor();
  const storey = up.div(STOREY).floor();
  const cell = column.add(storey.mul(17.3));
  const inColumn = across.div(STROKE_COLUMN).fract().sub(0.5).abs().mul(STROKE_COLUMN);
  const below = float(1).sub(up.div(STOREY).fract()).mul(STOREY);
  // Whether the stroke is there, how long it runs and how wide it starts.
  const there = step(hash(cell, 0.1), age.mul(0.85));
  const length = hash(cell, 0.7).mul(0.55).add(0.25).mul(STOREY);
  const width = hash(cell, 1.3).mul(0.14).add(0.08);
  // It narrows to a round end as it runs down, as a brush lifted off the wall.
  const reach = width.mul(float(1).sub(below.div(length)).max(0).sqrt());
  const drip = there.mul(edge(inColumn, reach));
  // The stain's top edge waves along the wall, as a wet foot dries unevenly.
  const wave = across.mul(1.7).sin().mul(0.5).add(across.mul(0.43).sin().mul(0.5)).mul(0.35).add(1);
  const stain = edge(up, wave.mul(STAIN_RISE)).mul(step(0.25, age));
  const dirty = mix(colour, colour.mul(vec3(...STAIN_SHADE)), stain);
  const grimy = mix(dirty, colour.mul(vec3(...GRIME_SHADE)), drip);
  // The faded paint is one flat band over a waving line high on a tall wall.
  // The metres are the wall's own, off its `uv`, so a house on a hill is not
  // weathered as if it stood at the height of the hill.
  const faded = float(1).sub(edge(up, wave.mul(FADE_FROM))).mul(age).mul(FADE);
  return mix(grimy, vec3(0.82, 0.8, 0.76).mul(luminance(grimy)), faded);
}

/** 1 below `limit` and 0 above it, with the one short edge a painted stroke has. */
function edge(value: TslNode, limit: TslNode): TslNode {
  return float(1).sub(smoothstep(limit.sub(EDGE), limit.add(EDGE), value));
}

/** A number from 0 to 1 for a whole number, the same on every call and every GPU near enough. */
function hash(n: TslNode, salt: number): TslNode {
  return n.mul(12.9898).add(salt * 78.233).sin().mul(43758.5453).fract();
}

/** Brick: courses of stretchers, each course offset half a brick from the one below. */
function brick(tint: TslNode, grain: TslNode, fine: TslNode): TslNode {
  const row = uv().y.div(BRICK.course).floor();
  const bed = uv().y.div(BRICK.course).fract();
  const head = uv().x.div(BRICK.along).add(row.mul(0.5)).fract();
  const joint = line(bed, BRICK.mortar).add(line(head, BRICK.mortar * BRICK.course / BRICK.along)).mul(fine);
  // Each brick is fired its own shade, drawn from the course and the brick.
  const kiln = row.mul(1.7).add(uv().x.div(BRICK.along).floor().mul(0.9)).sin().mul(0.07);
  const clay = tint.mul(float(0.7).add(kiln).add(grain.mul(0.14)));
  return mix(clay, rgb(MORTAR).mul(0.8), joint.mul(0.85));
}

/** Siding: horizontal boards, each throwing a shadow on the one below it. */
function siding(tint: TslNode, grain: TslNode, fine: TslNode): TslNode {
  const board = uv().y.div(SIDING.board).fract();
  const shade = float(1).sub(smoothstep(0, SIDING.lap, board).mul(0.22).mul(fine));
  return tint.mul(float(0.86).add(grain.mul(0.12))).mul(shade);
}

/** Corrugated metal: ribs running up the wall, as a triangle wave across it. */
function metal(tint: TslNode, grain: TslNode, fine: TslNode): TslNode {
  const rib = uv().x.div(RIB_METRES).fract().sub(0.5).abs().mul(0.8).mul(fine);
  return tint.mul(float(0.92).sub(rib).add(grain.mul(0.1)));
}

/** Tile: a grid of glazed squares on a grout bed. */
function tiled(tint: TslNode, patch: TslNode, fine: TslNode): TslNode {
  const grout = line(uv().x.div(TILE.size).fract(), TILE.grout).add(line(uv().y.div(TILE.size).fract(), TILE.grout));
  const glaze = tint.mul(float(0.84).add(patch.mul(0.24)));
  return mix(glaze, rgb(MORTAR).mul(0.9), grout.mul(fine).mul(0.7));
}

/** Concrete: raw, with the marks of the boards it was cast against. */
function concrete(tint: TslNode, grain: TslNode, patch: TslNode, fine: TslNode): TslNode {
  const board = positionWorld.y.div(BOARD_METRES).fract().sub(0.5).abs().mul(0.16).mul(fine);
  return tint.mul(float(0.74).add(board).add(patch.mul(0.2)).add(grain.mul(0.1)));
}

/** 1 where a fine pattern is near enough to draw, falling to 0 in the distance. */
function fineness(): TslNode {
  return float(1).sub(smoothstep(FINE_NEAR, FINE_FAR, positionView.z.abs()));
}

/** 1 inside a joint of `share` of a repeat, 0 on the face either side of it. */
function line(at: TslNode, share: number): TslNode {
  return float(1).sub(step(share, at));
}

/** 1 where the wall attribute carries exactly `id`, 0 everywhere else. */
function at(wall: TslNode, id: number): TslNode {
  return step(id - 0.5, wall).mul(float(1).sub(step(id + 0.5, wall)));
}

/** A colour constant in the working colour space, as a shader node. */
function rgb(hex: number): TslNode {
  const colour = new Color(hex);
  return vec3(colour.r, colour.g, colour.b);
}

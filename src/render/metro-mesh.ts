/**
 * The stairs down to a metro station: where they stand, and what they are made
 * of (spec section 13.3).
 *
 * The line is underground and claims no ground, so the only thing drawn of it
 * is the way in. `src/world/metro.ts` says where that is — the middle of the
 * pavement beside the road a station's parcel is entered from — and this builds
 * a stairwell there: a well sunk between two parapets, six treads walking down
 * into the dark, a handrail along each parapet and a lit sign on a mast beside
 * the mouth.
 *
 * The camera looks down on the city, and nothing under the ground is drawn: the
 * ground is a surface, so a step cut below it is behind it and never seen. The
 * descent is therefore built above the pavement and shallow — each tread lower
 * and darker than the one before it, on a floor almost black — which from the
 * height the game is played at reads as a stair going under the street. A well
 * really cut into the ground would show the pavement at the bottom of it.
 *
 * The well runs along the road rather than across it: a pavement is 2.5 m wide
 * and a stair is longer than that, so a player walks in from the side, as they
 * do on a real street. The mouth is at the `+z` end of the local frame and the
 * treads walk toward `-z`; `+x` points at the road.
 *
 * Nothing here touches the renderer or TSL, so the tests read it directly.
 */
import { BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WorldChunk } from '../world/chunks.ts';
import type { MetroEntrance } from '../world/metro.ts';
import type { SurfaceAt } from './pavement-mesh.ts';
import { vergeRise } from './road-section.ts';

/** One entrance, in the places the scene works in. */
export interface MetroStair {
  /** Where the middle of the well stands, and the pavement it stands on. */
  x: number;
  y: number;
  height: number;
  /** Radians, from the stairs toward the road (`src/world/metro.ts`). */
  heading: number;
}

/** Half the width of the well the treads walk down, in metres. */
const WELL_HALF = 0.9;

/** Half the length of the well, along the road. */
const WELL_END = 2.2;

/** The parapet each side of the well: how thick, and how tall above the pavement. */
const WALL_THICK = 0.2;
const WALL_HEIGHT = 0.9;

/** The metal handrail capping each parapet. */
const RAIL_WIDTH = 0.22;
const RAIL_THICK = 0.07;

/** Treads walking down into the dark, and metres of well between one and the next. */
const TREADS = 6;
const TREAD_GOING = 0.45;
const TREAD_DEPTH = 0.26;

/** How far the first tread stands over the pavement, and the last one. */
const TREAD_TOP = 0.18;
const TREAD_LAST = 0.03;

/** The floor of the well, a little over the pavement so the ground never shows through it. */
const FLOOR_RISE = 0.04;

/** The sign on its mast beside the mouth: how tall the mast, and how big the plate. */
const MAST_HEIGHT = 2.4;
const MAST_THICK = 0.12;
const PLATE_THICK = 0.08;
const PLATE_HEIGHT = 0.62;
const PLATE_WIDTH = 0.9;

/** The concrete of the parapets, the painted steel of the rails and the sign's face. */
const CONCRETE = 0x9a9691;
const METAL = 0x4b4f52;
const SIGN = 0x5ad08a;

/** The floor of the well, and the treads from the top one to the bottom one. */
const DARK = 0x0b0d10;
const TREAD_LIT = 0x8d8a86;
const TREAD_DIM = 0x1e2024;

/** How hard the sign burns once the street lamps are on. */
export const SIGN_GLOW = 4;

/**
 * The entrances standing in one chunk, in station order. A station is one
 * place, so the chunk that holds that place draws it and no other chunk does.
 */
export function stairsIn(
  chunk: WorldChunk,
  entrances: readonly MetroEntrance[],
  surfaceAt: SurfaceAt,
): MetroStair[] {
  const { bounds } = chunk;
  const out: MetroStair[] = [];
  for (const at of entrances) {
    if (at.x < bounds.minX || at.x >= bounds.maxX || at.y < bounds.minY || at.y >= bounds.maxY) continue;
    // Asked with the entrance's own tier, so the stairs stand on the pavement
    // of the road they belong to rather than on a street that ends beside it.
    // The kerb stands over the bed that answer gives, as it does under a street
    // lamp: a stair left on the bed is buried to the top of its treads.
    const height = surfaceAt(at.x, at.y, at.tier) + vergeRise(at.tier);
    out.push({ x: at.x, y: at.y, height, heading: at.heading });
  }
  return out;
}

/** Where one entrance stands, as a batch wants it: its own frame, in the world. */
export function stairPlace(stair: MetroStair): Matrix4 {
  const toward = new Vector3(Math.cos(stair.heading), 0, Math.sin(stair.heading));
  const up = new Vector3(0, 1, 0);
  const side = new Vector3().crossVectors(toward, up);
  return new Matrix4().makeBasis(toward, up, side).setPosition(stair.x, stair.height, stair.y);
}

/**
 * One entrance, built about the middle of its well: `+x` toward the road, `+z`
 * the way the mouth opens, and `y` 0 at the pavement. Every entrance in the
 * world is the same object, so a chunk grows one copy of it.
 */
export function metroStairGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [floor(), ...treads(), ...parapets(), backWall(), ...sign()];
  const merged = mergeGeometries(parts);
  for (const geometry of parts) geometry.dispose();
  return merged;
}

/** The dark floor the treads walk down, which is what the well is seen as from above. */
function floor(): BufferGeometry {
  return box(WELL_HALF * 2, FLOOR_RISE, WELL_END * 2, 0, FLOOR_RISE / 2, 0, DARK);
}

/**
 * The treads. Each is lower and darker than the one before it, so the stair
 * walks away from the street and into the dark under it.
 */
function treads(): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (let i = 0; i < TREADS; i++) {
    const t = i / (TREADS - 1);
    const height = TREAD_TOP + (TREAD_LAST - TREAD_TOP) * t;
    const z = WELL_END - TREAD_DEPTH / 2 - i * TREAD_GOING;
    out.push(box(WELL_HALF * 2, height, TREAD_DEPTH, 0, height / 2, z, shade(TREAD_LIT, TREAD_DIM, t)));
  }
  return out;
}

/** The parapet each side of the well, and the handrail capping it. */
function parapets(): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const x = WELL_HALF + WALL_THICK / 2;
  const length = WELL_END * 2 + WALL_THICK;
  for (const side of [-1, 1]) {
    out.push(box(WALL_THICK, WALL_HEIGHT, length, x * side, WALL_HEIGHT / 2, 0, CONCRETE));
    out.push(box(RAIL_WIDTH, RAIL_THICK, length, x * side, WALL_HEIGHT + RAIL_THICK / 2, 0, METAL));
  }
  return out;
}

/** The wall closing the far end, so the well is open only where it is walked into. */
function backWall(): BufferGeometry {
  const width = (WELL_HALF + WALL_THICK) * 2;
  const z = -WELL_END - WALL_THICK / 2;
  return box(width, WALL_HEIGHT, WALL_THICK, 0, WALL_HEIGHT / 2, z, CONCRETE);
}

/**
 * The sign: a mast outside the parapet at the mouth, and the plate it carries,
 * turned to face the road so a driver reads it. The plate is the one surface
 * that lights up after dark.
 */
function sign(): BufferGeometry[] {
  const x = WELL_HALF + WALL_THICK + MAST_THICK / 2;
  const z = WELL_END - MAST_THICK;
  const plate = box(PLATE_THICK, PLATE_HEIGHT, PLATE_WIDTH, x, MAST_HEIGHT - PLATE_HEIGHT / 2, z, SIGN);
  glow(plate, SIGN_GLOW);
  return [box(MAST_THICK, MAST_HEIGHT, MAST_THICK, x, MAST_HEIGHT / 2, z, METAL), plate];
}

/** One box of an entrance, moved into place and painted. */
function box(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  colour: number,
): BufferGeometry {
  const geometry = new BoxGeometry(width, height, depth);
  geometry.translate(x, y, z);
  const count = geometry.getAttribute('position').count;
  const tint = new Color(colour);
  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colours.set([tint.r, tint.g, tint.b], i * 3);
  geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
  glow(geometry, 0);
  return geometry;
}

/** How hard a box burns after dark. Every box carries one, because a batch merges them all. */
function glow(geometry: BufferGeometry, amount: number): void {
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('glow', new Float32BufferAttribute(new Float32Array(count).fill(amount), 1));
}

/** A colour `t` of the way from one to another. */
function shade(from: number, to: number, t: number): number {
  return new Color(from).lerp(new Color(to), t).getHex();
}

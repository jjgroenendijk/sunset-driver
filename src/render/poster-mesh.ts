/**
 * Where the harm-reduction posters of spec section 19 hang, and the boards
 * they are printed on.
 *
 * A poster is fly-posted on a building that is already standing, so nothing
 * here moves a wall or claims a piece of ground: `building-mesh.ts` has placed
 * the shell, and this hangs a board on the front of it. The board is a quad
 * with its texture coordinates cut to one cell of the poster atlas
 * (`poster-art.ts`), so a chunk's posters are one batch whichever of the
 * designs they carry.
 *
 * Which buildings carry one is a pure function of the building's own seed and
 * the district it stands in: a poorer district carries more of them, a
 * wilderness district none, and the same seed hangs the same posters in the
 * same places every time. Spec section 19 wants the information where it is
 * needed rather than everywhere.
 *
 * Two sizes, both the 5:7 of a printed sheet. A house or a shop row takes a
 * sheet flat on the wall by its door. A mid-rise, a warehouse or a garage takes
 * the billboard the spec asks for, and that one stands on the front of the roof
 * and leans back: the camera of spec section 10.7 looks down from 60 m, and an
 * upright board is a line to it. The roadside hoardings of spec section 13.1
 * are advertising and a different job.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import { BufferAttribute, Matrix4, PlaneGeometry, type BufferGeometry } from 'three';
import { hashInts } from '../core/hash.ts';
import type { BuildingKind } from '../world/buildings.ts';
import type { Zone } from '../world/types.ts';
import type { BuildingLookup, BuildingPlacement } from './building-mesh.ts';
import { FOUNDATION } from './building-plan.ts';
import { POSTER_ART, POSTER_CELL_WIDTH } from './poster-art.ts';
import { boardFrame, wallFaceOf } from './wall-face.ts';

/** One board, in the places the scene works in. */
export interface Poster {
  /** Which of `POSTER_ART` it is printed with. */
  design: number;
  /** The middle of the board: where it hangs on the map, and how high. */
  x: number;
  y: number;
  height: number;
  /** Unit vector the wall it stands on looks along, in the map's axes. */
  outX: number;
  outY: number;
  /**
   * Radians the printed face is lifted from that, towards the sky. A sheet on a
   * wall is 0; a hoarding on a roof leans back, so the camera 60 m up reads it.
   */
  tilt: number;
  /** Metres across the board and metres down it. */
  width: number;
  tall: number;
}

/** A board and where it hangs, as a batch wants it. */
export interface PosterPart {
  geometry: BufferGeometry;
  matrix: Matrix4;
}

/** The two sizes a poster is printed at, in metres. Both are the 5:7 of a sheet. */
const SHEET_WIDTH = 1.2;
const BOARD_WIDTH = 4;
const SHEET_RATIO = 7 / 5;

/** Metres the sheet stands off the wall it is fixed to, so it never fights the facade for a pixel. */
const PROUD = 0.06;

/** Metres from the pavement to the middle of a sheet by a door. */
const SHEET_HEIGHT = 2.1;

/**
 * Radians a hoarding leans back from upright. The camera of spec section 10.7
 * looks down from 60 m, and a board upright against a wall is a line to it: a
 * hoarding stands on the roof at the front of the building and leans back over
 * it, so its face looks up the way the camera looks down. It is where a real
 * one stands, and the one angle at which it can be read at all.
 */
const BOARD_TILT = 0.7;

/**
 * The walls a hoarding may stand on, in metres. Lower than this and the board
 * is taller than the building; higher and it stands above the street it is
 * meant to be read from.
 */
const BOARD_MIN_WALL = 6;
const BOARD_MAX_WALL = 26;

/** Metres of clear wall left beside a board and above a sheet. */
const WALL_CLEARANCE = 0.8;

/**
 * Which board a kind of building carries, if it carries one at all. A tower
 * carries none: its roof stands too far over the street to be read from one,
 * and its wall is the generated glass of spec section 10.3.
 */
const BOARD_KIND: Partial<Record<BuildingKind, 'sheet' | 'board'>> = {
  'shop-row': 'sheet',
  house: 'sheet',
  roadhouse: 'sheet',
  'mid-rise': 'board',
  warehouse: 'board',
  'parking-garage': 'board',
};

/**
 * Buildings of a zone in a thousand that carry a poster, before the district's
 * wealth moves it. The inner ring carries the most: it is where the clinic and
 * the exchange of spec section 19 stand. A suburb and the wilderness carry
 * none, so the whole map is not papered.
 */
const ZONE_RATE: Partial<Record<Zone, number>> = {
  core: 60,
  inner: 110,
  industrial: 80,
  outskirts: 35,
};

/** How much of the rate the richest district keeps. A poster follows the need, not the money. */
const WEALTH_FALL = 0.8;

/** The hashes: whether a building carries a board, which design, and which end of the wall. */
const CARRY_SALT = 1;
const DESIGN_SALT = 2;
const SIDE_SALT = 3;

/**
 * The posters of one chunk, in the order its buildings are held. Call it before
 * the shells are packed into their batches: it measures the shell that was
 * really built, so a board hangs on the wall rather than at the size the
 * massing asked for.
 */
export function postersIn(placements: readonly BuildingPlacement[], lookup: BuildingLookup): Poster[] {
  const out: Poster[] = [];
  for (const placed of placements) {
    const building = placed.building;
    const size = BOARD_KIND[building.kind];
    if (size === undefined) continue;
    const district = lookup.districtOf(building);
    const rate = ZONE_RATE[district.zone];
    if (rate === undefined) continue;
    if (hashInts(building.seed, CARRY_SALT) % 1000 >= rate * (1 - district.wealth * WEALTH_FALL)) continue;
    const poster = posterOn(placed, size);
    if (poster !== undefined) out.push(poster);
  }
  return out;
}

/**
 * Which end of a building's frontage its poster takes, 1 or -1. The
 * advertising of `sign-mesh.ts` stands a billboard on the same roofs and takes
 * the other end, so the two never fight for one place.
 */
export function posterSide(seed: number): number {
  return hashInts(seed, SIDE_SALT) % 2 === 0 ? 1 : -1;
}

/** The board on one building, or nothing where its wall has no room for one. */
function posterOn(placed: BuildingPlacement, size: 'sheet' | 'board'): Poster | undefined {
  // The wall that was really built, in the scene's axes: see `wall-face.ts`.
  const wallFace = wallFaceOf(placed);
  if (wallFace === undefined) return undefined;
  const { along, up, out, at: middleOfWall, wall, halfWall, face } = wallFace;

  const board = size === 'board';
  const width = board ? BOARD_WIDTH : SHEET_WIDTH;
  const tall = width * SHEET_RATIO;
  if (halfWall * 2 < width + WALL_CLEARANCE * 2) return undefined;
  if (board && (wall < BOARD_MIN_WALL || wall > BOARD_MAX_WALL)) return undefined;
  if (!board && SHEET_HEIGHT + tall / 2 + WALL_CLEARANCE > wall) return undefined;

  // A sheet is flat on the wall at the height of a door. A hoarding stands on
  // the front of the roof and leans back over it: its foot is at the top of the
  // wall, so its middle is up and behind that by the lean.
  const tilt = board ? BOARD_TILT : 0;
  const middle = board ? wall + (Math.cos(tilt) * tall) / 2 : SHEET_HEIGHT;
  const stand = board ? face - (Math.sin(tilt) * tall) / 2 : face + PROUD;

  const seed = placed.building.seed;
  const side = posterSide(seed);
  const reach = Math.max(0, halfWall - width / 2 - WALL_CLEARANCE);
  const at = middleOfWall
    .clone()
    .addScaledVector(along, side * reach)
    .addScaledVector(up, middle + FOUNDATION)
    .addScaledVector(out, stand);
  return {
    design: hashInts(seed, DESIGN_SALT) % POSTER_ART.length,
    x: at.x,
    y: at.z,
    height: at.y,
    outX: out.x,
    outY: out.z,
    tilt,
    width,
    tall,
  };
}

/**
 * The boards of a chunk, ready for a batch: a quad each, cut to the design it
 * carries, and the frame that hangs it on its wall.
 */
export function posterParts(posters: readonly Poster[]): PosterPart[] {
  return posters.map((poster) => ({ geometry: posterGeometry(poster), matrix: boardFrame(poster) }));
}

/**
 * One board, face on, about its own middle. The texture coordinates are moved
 * into the poster's cell of the atlas, which is what lets every design share
 * one material and so one draw call.
 */
export function posterGeometry(poster: Poster): BufferGeometry {
  const geometry = new PlaneGeometry(poster.width, poster.tall);
  const uv = geometry.getAttribute('uv') as BufferAttribute;
  const array = uv.array as Float32Array;
  // Half a texel in from each edge of the cell. The cells sit against one
  // another with no gutter, and a board taken to the very edge of its own would
  // pick up a line of its neighbour's paper along the side.
  const atlas = POSTER_CELL_WIDTH * POSTER_ART.length;
  const from = (poster.design * POSTER_CELL_WIDTH + 0.5) / atlas;
  const span = (POSTER_CELL_WIDTH - 1) / atlas;
  for (let i = 0; i < array.length; i += 2) {
    array[i] = from + (array[i] as number) * span;
    // A `DataTexture` holds its first row at `v` 0, and `poster-art.ts` draws
    // the top of the sheet first, so the board reads upside down unless `v` is
    // turned over here.
    array[i + 1] = 1 - (array[i + 1] as number);
  }
  uv.needsUpdate = true;
  return geometry;
}

/**
 * Draw calls a chunk spends on its posters: one batch where it holds buildings
 * at all, and nothing where it holds none. `chunk-cost.ts` adds this to the
 * rest; which of those buildings really carries one is not asked until the
 * shells are built.
 */
export function posterDrawCalls(buildings: number): number {
  return buildings > 0 ? 1 : 0;
}

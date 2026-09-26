/**
 * Where the advertising of spec section 13.1 hangs: shop signage over a
 * storefront, and billboards on the roofs above it.
 *
 * Like the posters of `poster-mesh.ts`, a sign is hung on a building that is
 * already standing, so nothing here moves a wall or claims a piece of ground.
 * Two shapes, both the 4:1 of the atlas cell `sign-art.ts` draws:
 *
 * - A **fascia** over a shopfront. It is flat on the wall in the band above the
 *   door, where a real one is, and it names the trade of spec section 16.1 that
 *   is really sold behind it wherever the building holds a shop.
 * - A **billboard** on the front of a roof, leaning back over it. The camera of
 *   spec section 10.7 looks down, so an upright board is a line to it; the lean
 *   is what puts the face where the camera is. It takes the end of the roof the
 *   harm-reduction hoarding of spec section 19 did not (`posterSide`), so the
 *   two never fight for one place.
 *
 * Which cell a sign carries is the pair of its district's culture (spec section
 * 8.3) and its design, so a neighbourhood's high street is read off its
 * signage. A sign in the core and the inner districts is neon and lights after
 * dark (spec section 13.4); one out in the suburbs is paint and never does.
 * Whether it lights is carried as the colour of its tube on the board's own
 * vertices, which is how `sign-material.ts` lights the one without lighting the
 * other from a single batch.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import { BufferAttribute, Matrix4, PlaneGeometry, type BufferGeometry } from 'three';
import { hashInts } from '../../core/hash.ts';
import type { Building, BuildingKind } from '../../world/city/buildings.ts';
import { SHOP_KINDS, type Shop, type ShopKind } from '../../world/city/shops.ts';
import type { Zone } from '../../world/types.ts';
import type { BuildingLookup, BuildingPlacement } from '../buildings/building-mesh.ts';
import { FOUNDATION } from '../buildings/building-plan.ts';
import { posterSide } from './poster-mesh.ts';
import {
  adDesign,
  AD_WORDS,
  CULTURE_LOOKS,
  cultureRow,
  SIGN_CELL_HEIGHT,
  SIGN_CELL_WIDTH,
  SIGN_CULTURES,
  SIGN_DESIGNS,
  tradeDesign,
  type CultureLook,
} from './sign-art.ts';
import { boardFrame, wallFaceOf } from './wall-face.ts';

/** One board, in the places the scene works in. */
export interface Sign {
  /** Which column of the sign atlas it is printed with, and which row. */
  design: number;
  culture: number;
  /** The middle of the board: where it hangs on the map, and how high. */
  x: number;
  y: number;
  height: number;
  /** Unit vector the wall it stands on looks along, in the map's axes. */
  outX: number;
  outY: number;
  /** Radians the printed face is lifted from that, towards the sky. A fascia is 0. */
  tilt: number;
  /** Metres across the board and metres down it. */
  width: number;
  tall: number;
  /**
   * The colour the tube burns after dark, as `0xrrggbb`, or 0 for a painted
   * board that never lights. `signs.ts` hands the lit ones a light.
   */
  neon: number;
  /**
   * Where in its own cycle a failing tube is, 0 to 1, and 0 for a tube that
   * does not fail. A city with every neon flickering together is a city with
   * one broken sign in it, so the phase is the sign's own.
   */
  flicker: number;
}

/** A board and where it hangs, as a batch wants it. */
export interface SignPart {
  geometry: BufferGeometry;
  matrix: Matrix4;
}

/** What a building's trade is, where it holds one. {@link shopTrades} is how one is built. */
export type TradeLookup = (building: Building) => ShopKind | undefined;

/** A sign is the 4:1 of the atlas cell it is printed with, so its height follows its width. */
const SIGN_RATIO = 1 / 4;

/** Metres the fascia stands off the wall it is fixed to, so it never fights the facade for a pixel. */
const PROUD = 0.08;

/** The widest and the narrowest fascia, in metres. A frontage too narrow for one carries none. */
const FASCIA_MAX_WIDTH = 6;
const FASCIA_MIN_WIDTH = 2.4;

/**
 * Metres from the pavement to the middle of a fascia, and the least its lower
 * edge may stand over one. A low roadhouse cannot carry its sign that high, so
 * the board slides down its wall until it fits and is dropped where the fit
 * would put it in the doorway.
 */
const FASCIA_HEIGHT = 3.9;
const FASCIA_FOOT = 2.1;

/** Metres across a billboard, and the clear wall left beside one and over a fascia. */
const BILLBOARD_WIDTH = 9;
const WALL_CLEARANCE = 0.8;

/**
 * Radians a billboard leans back from upright, which is the lean of the
 * harm-reduction hoardings for the same reason (spec section 10.7).
 */
const BILLBOARD_TILT = 0.7;

/**
 * The roofs a billboard may stand on, in metres. Lower and the board is taller
 * than the building; higher and it stands too far over the street to be read
 * from one.
 */
const BILLBOARD_MIN_WALL = 8;
const BILLBOARD_MAX_WALL = 28;

/**
 * Which board a kind of building carries. A storefront and a roadhouse carry
 * their own sign; the flat wide roofs carry the advertising. A tower carries
 * neither: its wall is the generated glass of spec section 10.3 and its roof is
 * too far up to read.
 */
const SIGN_KIND: Partial<Record<BuildingKind, 'fascia' | 'billboard'>> = {
  'shop-row': 'fascia',
  roadhouse: 'fascia',
  'mid-rise': 'billboard',
  warehouse: 'billboard',
  'parking-garage': 'billboard',
};

/**
 * Buildings of a zone in a thousand that carry a billboard, before the
 * district's density moves it. A suburb and the wilderness carry none: nobody
 * buys a hoarding over a street nobody drives down.
 */
const BILLBOARD_RATE: Partial<Record<Zone, number>> = {
  core: 220,
  inner: 260,
  industrial: 150,
  outskirts: 90,
};

/** How much of that rate the emptiest district keeps. A hoarding follows the traffic. */
const DENSITY_FLOOR = 0.5;

/**
 * Signs of a zone in a thousand that are neon rather than paint (spec section
 * 13.4). The nightlife of the inner districts burns the most of it, and a
 * suburban high street is dark by ten.
 */
const NEON_RATE: Partial<Record<Zone, number>> = {
  core: 800,
  inner: 650,
  industrial: 150,
  suburban: 120,
  outskirts: 250,
};

/** The least neon a beach neighbourhood carries, whatever zone it stands in: it is a party strip after dark. */
const BEACH_NEON = 700;

/** Neon tubes in a thousand that have failed and flicker (spec section 13.1). */
const FLICKER_RATE = 160;

/** The phases a failing tube may be at. Whole steps, so the flicker is a stutter and not a drift. */
const FLICKER_PHASES = 16;

/**
 * The hashes: the board, the advertisement, the trade, whether it lights,
 * whether its tube fails, and where in its cycle a failing one is.
 */
const CARRY_SALT = 11;
const AD_SALT = 12;
const TRADE_SALT = 13;
const NEON_SALT = 14;
const FLICKER_SALT = 15;
const PHASE_SALT = 16;

/**
 * What each building sells, from the shops a world was dealt. A building the
 * shops never landed on answers undefined, and its fascia advertises a trade of
 * its own instead: a shop row is a row of storefronts and only one of them is
 * enterable (spec section 16.1).
 */
export function shopTrades(shops: readonly Shop[]): TradeLookup {
  const trades = new Map<number, ShopKind>();
  for (const shop of shops) trades.set(shop.building, shop.kind);
  return (building) => trades.get(building.id);
}

/**
 * The signs of one chunk, in the order its buildings are held. Call it before
 * the shells are packed into their batches: it measures the shell that was
 * really built, so a board hangs on the wall rather than at the size the
 * massing asked for.
 */
export function signsIn(
  placements: readonly BuildingPlacement[],
  lookup: BuildingLookup,
  tradeOf: TradeLookup,
): Sign[] {
  const out: Sign[] = [];
  for (const placed of placements) {
    const building = placed.building;
    const shape = SIGN_KIND[building.kind];
    if (shape === undefined) continue;
    const district = lookup.districtOf(building);
    if (shape === 'billboard') {
      const rate = BILLBOARD_RATE[district.zone];
      if (rate === undefined) continue;
      const density = DENSITY_FLOOR + district.density * (1 - DENSITY_FLOOR);
      if (hashInts(building.seed, CARRY_SALT) % 1000 >= rate * density) continue;
    }
    const sign = signOn(placed, shape, cultureRow(district.culture), designOf(building, shape, tradeOf));
    if (sign === undefined) continue;
    sign.neon = neonOf(building.seed, district.zone, sign.culture);
    sign.flicker = flickerOf(building.seed, sign.neon);
    out.push(sign);
  }
  return out;
}

/** Which cell of its culture's row a building's board carries. */
function designOf(building: Building, shape: 'fascia' | 'billboard', tradeOf: TradeLookup): number {
  // A hoarding sells nothing on the premises, and neither does a roadhouse bar:
  // both take an advertisement. A storefront names its trade — the one it
  // really holds where the shops landed on it, and one of its own where they
  // did not.
  if (shape === 'billboard' || building.kind === 'roadhouse') {
    return adDesign(hashInts(building.seed, AD_SALT) % AD_WORDS.length);
  }
  const trade = tradeOf(building);
  return tradeDesign(trade ?? (SHOP_KINDS[hashInts(building.seed, TRADE_SALT) % SHOP_KINDS.length] as ShopKind));
}

/** The colour a sign's tube burns after dark, or 0 where it is painted board. */
function neonOf(seed: number, zone: Zone, culture: number): number {
  const rate = Math.max(NEON_RATE[zone] ?? 0, SIGN_CULTURES[culture] === 'beach' ? BEACH_NEON : 0);
  if (hashInts(seed, NEON_SALT) % 1000 >= rate) return 0;
  return (CULTURE_LOOKS[culture] as CultureLook).neon;
}

/**
 * Where a sign's tube is in its own failing cycle, and 0 for a tube that burns
 * steadily. A painted board never flickers, having nothing to fail.
 */
function flickerOf(seed: number, neon: number): number {
  if (neon === 0) return 0;
  if (hashInts(seed, FLICKER_SALT) % 1000 >= FLICKER_RATE) return 0;
  // Never 0: that is the value a steady tube carries.
  return ((hashInts(seed, PHASE_SALT) % FLICKER_PHASES) + 1) / FLICKER_PHASES;
}

/** The board on one building, or nothing where its wall has no room for one. */
function signOn(
  placed: BuildingPlacement,
  shape: 'fascia' | 'billboard',
  culture: number,
  design: number,
): Sign | undefined {
  // The wall that was really built, in the scene's axes: see `wall-face.ts`.
  const face = wallFaceOf(placed);
  if (face === undefined) return undefined;
  const billboard = shape === 'billboard';
  const width = billboard ? BILLBOARD_WIDTH : Math.min(face.halfWall * 2 - WALL_CLEARANCE * 2, FASCIA_MAX_WIDTH);
  if (width < (billboard ? BILLBOARD_WIDTH : FASCIA_MIN_WIDTH)) return undefined;
  const tall = width * SIGN_RATIO;
  if (face.halfWall * 2 < width + WALL_CLEARANCE * 2) return undefined;

  // A billboard stands on the front of the roof and leans back over it: its
  // foot is the top of the wall, so its middle is up and behind that by the
  // lean. A fascia is flat on the wall in the band over the door, and slides
  // down a low wall until it fits under the roof.
  const tilt = billboard ? BILLBOARD_TILT : 0;
  if (billboard && (face.wall < BILLBOARD_MIN_WALL || face.wall > BILLBOARD_MAX_WALL)) return undefined;
  const middle = billboard
    ? face.wall + (Math.cos(tilt) * tall) / 2
    : Math.min(FASCIA_HEIGHT, face.wall - tall / 2 - WALL_CLEARANCE);
  if (!billboard && middle - tall / 2 < FASCIA_FOOT) return undefined;
  const stand = billboard ? face.face - (Math.sin(tilt) * tall) / 2 : face.face + PROUD;

  // A fascia is centred on the frontage, where a shopfront is. A billboard
  // takes the end of the roof the harm-reduction hoarding left.
  const reach = billboard ? Math.max(0, face.halfWall - width / 2 - WALL_CLEARANCE) : 0;
  const at = face.at
    .clone()
    .addScaledVector(face.along, -posterSide(placed.building.seed) * reach)
    .addScaledVector(face.up, middle + FOUNDATION)
    .addScaledVector(face.out, stand);
  return {
    design,
    culture,
    x: at.x,
    y: at.z,
    height: at.y,
    outX: face.out.x,
    outY: face.out.z,
    tilt,
    width,
    tall,
    neon: 0,
    flicker: 0,
  };
}

/**
 * The boards of a chunk, ready for a batch: a quad each, cut to the cell it
 * carries, and the frame that hangs it on its wall.
 */
export function signParts(signs: readonly Sign[]): SignPart[] {
  return signs.map((sign) => ({ geometry: signGeometry(sign), matrix: boardFrame(sign) }));
}

/**
 * One board, face on, about its own middle. The texture coordinates are moved
 * into the sign's cell of the atlas grid and its tube colour is written on
 * every vertex, which is what lets every design, every culture and the painted
 * boards among them share one material and so one draw call.
 */
export function signGeometry(sign: Sign): BufferGeometry {
  const geometry = new PlaneGeometry(sign.width, sign.tall);
  const uv = geometry.getAttribute('uv') as BufferAttribute;
  const array = uv.array as Float32Array;
  // Half a texel in from each edge of the cell. The cells sit against one
  // another with no gutter, and a board taken to the very edge of its own would
  // pick up a line of its neighbour's board along the side.
  const across = SIGN_CELL_WIDTH * SIGN_DESIGNS.length;
  const down = SIGN_CELL_HEIGHT * SIGN_CULTURES.length;
  const fromU = (sign.design * SIGN_CELL_WIDTH + 0.5) / across;
  const spanU = (SIGN_CELL_WIDTH - 1) / across;
  const fromV = (sign.culture * SIGN_CELL_HEIGHT + 0.5) / down;
  const spanV = (SIGN_CELL_HEIGHT - 1) / down;
  for (let i = 0; i < array.length; i += 2) {
    array[i] = fromU + (array[i] as number) * spanU;
    // A `DataTexture` holds its first row at `v` 0, and `sign-art.ts` draws the
    // top of the board first, so the sign reads upside down unless `v` is
    // turned over here.
    array[i + 1] = fromV + (1 - (array[i + 1] as number)) * spanV;
  }
  uv.needsUpdate = true;
  // Whether this board lights, and where its tube is in a failing cycle. Both
  // are per vertex because a batch merges a chunk's boards into one mesh: there
  // is no per-sign uniform left by the time the material runs.
  geometry.setAttribute('neon', new BufferAttribute(filled(uv.count, sign.neon === 0 ? 0 : 1), 1));
  geometry.setAttribute('flicker', new BufferAttribute(filled(uv.count, sign.flicker), 1));
  return geometry;
}

/** One number written on every vertex of a board. */
function filled(vertices: number, value: number): Float32Array {
  return new Float32Array(vertices).fill(value);
}

/**
 * Draw calls a chunk spends on its signs: one batch where it holds buildings at
 * all, and nothing where it holds none. `chunk-cost.ts` adds this to the rest;
 * which of those buildings really carries one is not asked until the shells are
 * built.
 */
export function signDrawCalls(buildings: number): number {
  return buildings > 0 ? 1 : 0;
}

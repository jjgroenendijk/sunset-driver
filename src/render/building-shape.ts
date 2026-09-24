/**
 * The shape a tall building is massed in (spec section 10.3).
 *
 * `building-plan.ts` says how much ground a building covers and how high it
 * stands. This says what stands in that box: a plain extrusion, an L, a U, a
 * ring around a courtyard, a slim tower on a wider podium, or a stack of
 * setbacks. The shape is a handful of boxes, and `building-mesh.ts` builds one
 * generated facade per box and stands them together.
 *
 * A shape is drawn in fractions of the massing rather than in metres, because
 * the same building is built three ways: a generated facade at near detail, a
 * block at mid detail and one massing box per storey band at far detail. The
 * three are laid out on different rectangles — a generated facade is given the
 * massing less its cornices — so the fractions are what keeps the silhouette
 * the same and the skyline from jumping where the detail steps.
 *
 * Every choice comes from the building's own seed, so the same building is
 * massed the same way in every session.
 *
 * Two rules hold the street wall of spec section 10.3 together, and every plan
 * below keeps them:
 *
 * - The first box covers the whole footprint and stands on the ground. That is
 *   what reaches the side edges the lot shares, so a row of buildings has no
 *   daylight between its walls.
 * - Nothing stands outside the footprint. The shape is inside the massing, the
 *   massing inside the lot, and the sweep checks the lot.
 *
 * Pure, and free of three.js.
 */
import { hashInts } from '../core/hash.ts';
import type { BuildingKind } from '../world/buildings.ts';

/** How a tall building is massed. */
export type BuildingPlan = 'box' | 'step' | 'ell' | 'u' | 'court' | 'podium' | 'setbacks';

/** A rectangle of a shape, in fractions: of the footprint across, of the height up. */
export interface ShapePart {
  /** The middle of the rectangle, from -0.5 at one edge of the footprint to 0.5 at the other. */
  x: number;
  z: number;
  /** How much of the footprint it covers each way, from 0 to 1. */
  width: number;
  depth: number;
  /** Where it stands, from 0 on the ground to 1 at the top of the massing. */
  from: number;
  to: number;
  /**
   * The rectangle of its roof the dresser may fill, in the same fractions, or
   * undefined where nothing goes on it. It is the part's own rectangle unless
   * another part stands on that roof: a podium offers the strip in front of its
   * tower, and a setback tier that another tier stands on offers nothing, since
   * the ledge it leaves rings the tier above and the dresser lays out
   * rectangles.
   */
  terrace: { x: number; z: number; width: number; depth: number } | undefined;
}

/** How a tall building is massed, and what its facade is built on. */
export interface BuildingShape {
  plan: BuildingPlan;
  /** The boxes it is composed of, the one on the ground first. */
  parts: ShapePart[];
  /** Metres of one storey, and of one bay of the facade. */
  floorHeight: number;
  bayWidth: number;
}

/** One rectangle of a shape in metres of the building's own frame. */
export interface ShapeBox {
  /** The middle of the rectangle in the building's own frame. */
  x: number;
  z: number;
  width: number;
  depth: number;
  /** Metres from the ground to the foot of the box and to the top of it. */
  from: number;
  to: number;
  /** Which corner is cut to face a junction, as {@link BuildingMassing.chamfer}. */
  chamfer: number;
  /** The clear rectangle of its roof, in metres, or undefined. */
  terrace: { x: number; z: number; width: number; depth: number } | undefined;
}

/**
 * The generator's bay and its storey, in metres, before a building varies them.
 * Both are wider than a real tower's: the camera looks down from 60 m, and every
 * window it cannot see is geometry the frame pays for.
 */
export const BAY_WIDTH = 4.2;
export const FLOOR_HEIGHT = 4;

/**
 * How much wider than the plainest one a bay and a storey grow. Neighbours in
 * one row differ in both, so the row reads as a street of buildings rather than
 * as one long block; the variation runs upward only, because a narrower bay is
 * another pier and another window on every floor of a tower, and a generated
 * facade is the dearest thing a chunk builds.
 */
const BAY_SPREAD = 0.62;
const FLOOR_SPREAD = 0.26;

/** Metres of footprint each plan needs each way before it is worth massing. */
const PLAN_ROOM: Readonly<Record<BuildingPlan, { width: number; depth: number; height: number }>> = {
  box: { width: 0, depth: 0, height: 0 },
  step: { width: 17, depth: 0, height: 0 },
  ell: { width: 22, depth: 20, height: 0 },
  u: { width: 26, depth: 20, height: 0 },
  court: { width: 28, depth: 24, height: 0 },
  podium: { width: 18, depth: 14, height: 45 },
  setbacks: { width: 16, depth: 13, height: 55 },
};

/** The plans each tall kind is massed in, and the share of buildings each takes. */
const PLANS: Readonly<Record<string, readonly { plan: BuildingPlan; share: number }[]>> = {
  tower: [
    { plan: 'box', share: 0.3 },
    { plan: 'setbacks', share: 0.3 },
    { plan: 'podium', share: 0.25 },
    { plan: 'ell', share: 0.15 },
  ],
  'mid-rise': [
    { plan: 'box', share: 0.48 },
    { plan: 'step', share: 0.2 },
    { plan: 'ell', share: 0.16 },
    { plan: 'u', share: 0.09 },
    { plan: 'court', share: 0.07 },
  ],
};

/** Metres of terrace a podium keeps in front of its tower, where its lot allows. */
const TERRACE_DEPTH = 6;

/** Storeys a podium stands, at the fewest and at the most. */
const PODIUM_STOREYS = { low: 2, high: 5 };

/**
 * The shape a building is massed in. Only a tower and a mid-rise are massed;
 * every other kind is its footprint, extruded, which is what a house or a
 * warehouse is.
 */
export function shapeOf(
  seed: number,
  kind: BuildingKind,
  massing: { width: number; depth: number; height: number },
  shared: Shared = { left: false, right: false },
  want?: BuildingPlan,
): BuildingShape {
  const floorHeight = FLOOR_HEIGHT * (1 + FLOOR_SPREAD * unit(seed, 31));
  const bayWidth = BAY_WIDTH * (1 + BAY_SPREAD * unit(seed, 32));
  const plan = planOf(seed, kind, massing, shared, want);
  return { plan, parts: partsOf(plan, seed, massing, floorHeight, shared), floorHeight, bayWidth };
}

/** Which side edges of a lot carry a neighbour's wall: `left` is the lot's +x side. */
export interface Shared {
  left: boolean;
  right: boolean;
}

/**
 * Which plan a building takes: the one its share of the draw lands in, if its
 * lot has room for it.
 *
 * An L cuts its notch out of one back corner, and a wall the lot shares must
 * stand on that edge from the front of the lot to the back of it, so an L needs
 * a side edge with no neighbour against it to cut into. A lot walled on both
 * sides is built as a box instead.
 *
 * A style of spec section 10.3 may ask for a plan by name — an Art Deco tower
 * is a stack of setbacks, whatever its seed drew — and it is given it wherever
 * the lot has room, and a box where it has not.
 */
function planOf(
  seed: number,
  kind: BuildingKind,
  massing: { width: number; depth: number; height: number },
  shared: Shared,
  want?: BuildingPlan,
): BuildingPlan {
  const table = PLANS[kind];
  if (table === undefined) return 'box';
  if (want !== undefined) return fits(want, massing) ? want : 'box';
  let draw = unit(seed, 30);
  for (const entry of table) {
    draw -= entry.share;
    if (draw > 0) continue;
    if (entry.plan === 'ell' && shared.left && shared.right) return 'box';
    return fits(entry.plan, massing) ? entry.plan : 'box';
  }
  return 'box';
}

/** Whether a lot leaves a plan the room {@link PLAN_ROOM} asks of it. */
function fits(plan: BuildingPlan, massing: { width: number; depth: number; height: number }): boolean {
  const room = PLAN_ROOM[plan];
  return massing.width >= room.width && massing.depth >= room.depth && massing.height >= room.height;
}

/** A rectangle of the footprint, with its own roof offered to the dresser. */
function piece(x: number, z: number, width: number, depth: number, from: number, to: number): ShapePart {
  return { x, z, width, depth, from, to, terrace: { x, z, width, depth } };
}

/** The whole footprint: the box every plan starts from. */
function whole(from: number, to: number): ShapePart {
  return piece(0, 0, 1, 1, from, to);
}

function partsOf(
  plan: BuildingPlan,
  seed: number,
  massing: { width: number; depth: number; height: number },
  floorHeight: number,
  shared: Shared,
): ShapePart[] {
  switch (plan) {
    case 'step':
      return step(seed);
    case 'ell':
      return wings(seed, 1, shared);
    case 'u':
      return wings(seed, 0, shared);
    case 'court':
      return court(seed);
    case 'podium':
      return podium(seed, massing, floorHeight);
    case 'setbacks':
      return setbacks(seed, massing.height);
    default:
      return [whole(0, 1)];
  }
}

/**
 * A front wing the width of the lot, with one side wing behind it for an L and
 * two for a U. The front wing is what holds the street wall; the side wings run
 * back from it and leave the middle of the back of the lot open, which is the
 * light well a deep building needs.
 *
 * An L's one wing is the shorter of the two, so the building steps down towards
 * the back of its lot and its roof is a terrace.
 */
function wings(seed: number, sides: number, shared: Shared): ShapePart[] {
  const front = 0.42 + unit(seed, 33) * 0.16;
  // A U has two wings to fit across the back of the lot and a notch to leave
  // between them, so each of them is narrower than the one wing of an L.
  const arm = sides === 1 ? 0.4 + unit(seed, 34) * 0.16 : 0.26 + unit(seed, 34) * 0.1;
  // The front wing fills the frontage; the side wings run back from it.
  const parts: ShapePart[] = [piece(0, 0.5 - front / 2, 1, front, 0, 1)];
  const behind = 1 - front;
  // The one wing of an L stands on the side the notch may not be cut out of:
  // the wall the lot shares has to reach the back of the lot. The lot's `left`
  // side edge is the one at local +x.
  const free = shared.left ? 1 : shared.right ? -1 : unit(seed, 35) < 0.5 ? -1 : 1;
  for (const side of sides === 1 ? [free] : [-1, 1]) {
    const to = sides === 1 ? 0.6 + unit(seed, 36) * 0.4 : 1;
    const x = side * (0.5 - arm / 2);
    const z = -0.5 + behind / 2;
    parts.push(piece(x, z, arm, behind, 0, to));
  }
  return parts;
}

/**
 * The footprint cut in two across the frontage, each half standing to its own
 * height. A lot of the inner ring is wide and shallow, so this is the one plan
 * that fits almost all of them, and a pair of halves a storey or three apart is
 * what breaks a row of mid-rise blocks into a street of buildings. Each half
 * keeps the whole depth of the lot, so both side edges carry a wall from the
 * front of the lot to the back of it.
 */
function step(seed: number): ShapePart[] {
  const share = 0.42 + unit(seed, 46) * 0.16;
  const drop = 0.6 + unit(seed, 47) * 0.28;
  const low = unit(seed, 48) < 0.5;
  return [
    piece(-0.5 + share / 2, 0, share, 1, 0, low ? drop : 1),
    piece(0.5 - (1 - share) / 2, 0, 1 - share, 1, 0, low ? 1 : drop),
  ];
}

/** Four wings around a courtyard: the block of a dense inner ring, with light in the middle. */
function court(seed: number): ShapePart[] {
  const across = 0.26 + unit(seed, 37) * 0.08;
  const along = 0.28 + unit(seed, 38) * 0.08;
  const middle = 1 - 2 * along;
  return [
    piece(0, 0.5 - along / 2, 1, along, 0, 1),
    piece(0, -0.5 + along / 2, 1, along, 0, 1),
    piece(0.5 - across / 2, 0, across, middle, 0, 1),
    piece(-0.5 + across / 2, 0, across, middle, 0, 1),
  ];
}

/**
 * A slim tower on a wider base of two to five storeys. The tower is built from
 * the ground, not from the podium roof: its own shopfront is then buried inside
 * the podium rather than standing fifteen metres over the street, and the two
 * share one wall down to the pavement.
 *
 * The tower is pushed towards the back of the lot, so what the podium roof
 * leaves clear is one rectangle over the street rather than a ledge ringing the
 * tower. That rectangle is the terrace the roof dresser fills.
 */
function podium(seed: number, massing: { depth: number; height: number }, floorHeight: number): ShapePart[] {
  const storeys = PODIUM_STOREYS.low + Math.floor(unit(seed, 39) * (PODIUM_STOREYS.high - PODIUM_STOREYS.low + 1));
  const top = Math.min(0.5, (storeys * floorHeight) / massing.height);
  const width = 0.56 + unit(seed, 40) * 0.18;
  // A lot of the core is wide and shallow, so the tower is drawn in mostly
  // across the frontage; what it gives up in depth is however much the terrace
  // in front of it needs to be worth laying anything out on.
  const depth = Math.min(0.78, Math.max(0.5, 1 - (TERRACE_DEPTH + 0.5) / massing.depth));
  // Against the back edge but for the margin the ledge keeps behind it.
  const z = -0.5 + depth / 2 + 0.04;
  const terrace = { x: 0, z: (z + depth / 2 + 0.5) / 2, width: 1, depth: 0.5 - z - depth / 2 };
  return [
    { ...whole(0, top), terrace },
    piece(0, z, width, depth, 0, 1),
  ];
}

/**
 * Two or three tiers, each drawn in from the one below it: the setback tower of
 * spec section 10.3, and a taper on the tallest. Each tier is its own building
 * from its own ledge upward, so the generator caps it with a cornice and a
 * parapet and the step reads as a ledge rather than as a cut.
 */
function setbacks(seed: number, height: number): ShapePart[] {
  const tiers = height >= 90 ? 3 : 2;
  const parts: ShapePart[] = [];
  let from = 0;
  let inset = 0;
  for (let i = 0; i < tiers; i++) {
    // The lower tiers take the larger share of the height, so the building
    // stands on its base rather than balancing on it.
    const share = i === tiers - 1 ? 1 - from : (1 - from) * (0.5 + unit(seed, 42 + i) * 0.12);
    const take = i === 0 ? 0 : 0.09 + unit(seed, 45 + i) * 0.07;
    inset += take;
    const span = 1 - 2 * inset;
    const top = i === tiers - 1;
    const tier = { x: 0, z: 0, width: span, depth: span, from, to: from + share };
    parts.push({ ...tier, terrace: top ? { x: 0, z: 0, width: span, depth: span } : undefined });
    from += share;
  }
  return parts;
}

/**
 * A shape in metres: its boxes laid out on a rectangle, and the height they
 * stand to. The chamfer is given to the box that holds the corner it cuts,
 * which is the one on the ground at the front of the lot.
 */
export function boxesOf(
  shape: BuildingShape,
  rect: { width: number; depth: number },
  height: number,
  chamfer: number,
): ShapeBox[] {
  return shape.parts.map((part) => ({
    x: part.x * rect.width,
    z: part.z * rect.depth,
    width: part.width * rect.width,
    depth: part.depth * rect.depth,
    from: part.from * height,
    to: part.to * height,
    chamfer: part.from === 0 && holdsCorner(part, chamfer) ? chamfer : 0,
    terrace:
      part.terrace === undefined
        ? undefined
        : {
            x: part.terrace.x * rect.width,
            z: part.terrace.z * rect.depth,
            width: part.terrace.width * rect.width,
            depth: part.terrace.depth * rect.depth,
          },
  }));
}

/** Whether a part reaches the front corner a chamfer cuts. */
function holdsCorner(part: ShapePart, chamfer: number): boolean {
  if (chamfer === 0) return false;
  const near = 1e-6;
  return part.z + part.depth / 2 >= 0.5 - near && chamfer * part.x + part.width / 2 >= 0.5 - near;
}

/** A number in 0..1 from a building's seed, for the draws the shape makes. */
function unit(seed: number, salt: number): number {
  return hashInts(seed, salt) / 0x100000000;
}

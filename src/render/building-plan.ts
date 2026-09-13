/**
 * How big a building is and where on its lot it may stand (spec section 10.3).
 *
 * `building-mesh.ts` builds the geometry; this says what ground it is built on.
 * The massing is the lot less a margin, and the margin is what keeps a shell
 * off the ground beside it. A side edge the lot shares with another lot needs
 * none, because the ground past it carries the neighbour's wall: that is what
 * makes the core and the inner ring one street wall rather than a row of boxes
 * with daylight between them.
 *
 * A generated facade is asked for {@link CORNICE} less again, because its
 * cornices, string courses and crown all overhang the footprint it is given,
 * and {@link roomFor} is how much ground that leaves it. What still reaches
 * past the room is taken in by the scale of the placement, which
 * `building-mesh.ts` measures.
 *
 * Pure, and free of three.js: the massing of a building is a handful of
 * numbers in its own frame.
 */
import { hashInts } from '../core/hash.ts';
import type { Building, BuildingKind } from '../world/buildings.ts';
import type { RoadEdge, RoadGraph } from '../world/graph.ts';
import type { District, Point } from '../world/types.ts';

/** Which batch a building's shell belongs to, and so how it is generated. */
export type BuildingBatch = 'facade' | 'block';

/** The box a building's shell fills, in its own frame. */
export interface BuildingMassing {
  /** Metres along the frontage. */
  width: number;
  /** Metres from the front of the lot to the back of it. */
  depth: number;
  /** Metres from the ground to the top of the walls, before any roof. */
  height: number;
  /**
   * Metres the shell is moved along the frontage from the middle of the lot.
   * The margin is taken only on the sides that need it, so a lot with a wall
   * against one side alone does not stand in the middle of itself. Positive
   * moves it towards the lot's first corner, which is local +x.
   */
  offset: number;
  /**
   * Which front corner is cut away to face a junction: 1 the corner at the first
   * point of the lot, -1 the corner at the second, 0 neither. Only a generated
   * facade takes one.
   */
  chamfer: number;
}

/**
 * Metres the shell stands in from the edge of its lot, so two neighbours never
 * meet. It is taken on the front and the back of every lot, and on a side edge
 * with nothing against it. A side edge shared with another lot takes none: the
 * ground past it carries the neighbour's wall, and a wall with a margin on both
 * of its sides is a slot cut through the street wall of spec section 10.3.
 */
const KIND_MARGIN: Record<BuildingKind, number> = {
  tower: 0.5,
  'mid-rise': 0.5,
  'parking-garage': 0.5,
  'shop-row': 0.4,
  house: 0.9,
  warehouse: 0.8,
  roadhouse: 1.2,
};

/**
 * Metres a generated facade reaches out past the footprint it is given: the
 * cornices of its base, its string courses and its crown all overhang. The
 * footprint is shrunk by this much on every side that has to stay clear of the
 * ground beside it, so the shell stands inside the lot there; a side edge the
 * lot shares keeps none, and the cornices hang over the wall past it.
 */
export const CORNICE = 2;

/**
 * Metres of float error the sweeps allow a shell past an edge it shares, which
 * it is placed exactly on.
 */
const WALL_SLACK = 0.01;

/**
 * The most a shell is stretched along the frontage to fill a wall it shares.
 * A generated facade comes back narrower than the massing it was asked for, by
 * however much less than {@link CORNICE} its cornices really overhang; the
 * stretch is what takes that up. A tenth is wider than any facade measures
 * short, and a bay a tenth wider than its neighbour's is not something the
 * camera sees from 60 m up.
 */
const MAX_STRETCH = 1.25;

/** Metres of facade the generator needs each way. A lot narrower than this takes a block. */
const MIN_FACADE = 8;

/** Metres each way the massing is never allowed below, however small the lot. */
const MIN_MASSING = 4;

/** How tall each kind stands, before the district and the lot have their say. */
const KIND_HEIGHT: Record<BuildingKind, { low: number; high: number }> = {
  tower: { low: 48, high: 150 },
  'mid-rise': { low: 14, high: 34 },
  // Three to five open decks.
  'parking-garage': { low: 9, high: 16 },
  'shop-row': { low: 7.5, high: 11.5 },
  house: { low: 4.5, high: 9.5 },
  warehouse: { low: 7, high: 13 },
  roadhouse: { low: 4, high: 6 },
};

/**
 * How many times its own narrow side a building may stand. A tower buys its room
 * upwards, but a tall one needs a lot to stand on: this is what keeps a narrow
 * corner lot from carrying a spire.
 */
const MAX_SLENDERNESS = 7;

/**
 * How much of a tall building's height comes from its district and from the
 * skyline over its lot. What is left comes from its own seed. The skyline has
 * the larger share, so the city is tall in the middle and falls away from it
 * rather than stopping at the edge of the core.
 */
const DISTRICT_SHARE = 0.25;
const SKYLINE_SHARE = 0.45;

/** Metres the base of a building is sunk, so no daylight shows under a wall on a slope. */
export const FOUNDATION = 0.5;

/** Metres of the chamfer cut off a corner that faces a junction, at most. */
export const CHAMFER_WIDTH = 3;
/** Metres a lot corner may stand from a junction and still be cut for it. */
const CHAMFER_REACH = 16;
/** Edges leaving a node before it counts as a junction rather than a bend. */
const JUNCTION_DEGREE = 3;

/**
 * The massing of a building, from its lot, its kind, the district it stands in
 * and the skyline over it.
 */
export function massingOf(building: Building, district: District, chamfer: number): BuildingMassing {
  const flat = plan(building);
  const span = KIND_HEIGHT[building.kind];
  const crowd = building.kind === 'tower' ? (district.density + district.wealth) / 2 : district.density;
  // The district and the skyline have their say on the kinds that grow tall; a
  // house is a house wherever it stands.
  const tall = building.kind === 'tower' || building.kind === 'mid-rise';
  const t = tall
    ? unit(building.seed, 1) * (1 - DISTRICT_SHARE - SKYLINE_SHARE) + crowd * DISTRICT_SHARE + building.skyline * SKYLINE_SHARE
    : unit(building.seed, 1);
  // A tall building needs a lot to stand on: its own narrow side is what caps it.
  const ceiling = Math.min(span.high, Math.max(span.low, Math.min(flat.width, flat.depth) * MAX_SLENDERNESS));
  return {
    width: flat.width,
    depth: flat.depth,
    height: span.low + (ceiling - span.low) * t,
    offset: flat.offset,
    chamfer,
  };
}

/**
 * The ground a building's shell covers, before its height is known: the lot
 * less the margin on each side that needs one. A lot walled on one side only
 * keeps its far side clear and reaches the wall, so the shell is moved half the
 * margin towards it.
 */
export function plan(building: Building): { width: number; depth: number; offset: number } {
  const margin = KIND_MARGIN[building.kind];
  const left = building.shared.left ? 0 : margin;
  const right = building.shared.right ? 0 : margin;
  return {
    width: Math.max(MIN_MASSING, building.width - left - right),
    depth: Math.max(MIN_MASSING, building.depth - 2 * margin),
    offset: (right - left) / 2,
  };
}

/**
 * The ground a building's shell may cover: its lot, and {@link WALL_SLACK} past
 * every side edge it shares.
 *
 * A shell reaches a shared edge exactly, because the wall past it is the
 * neighbour's and a margin there would be a slot in the street wall. Landing on
 * a line is not something floating point does to the millimetre, so the sweeps
 * allow a centimetre there and the lot itself everywhere else. A shared edge
 * never faces a road — the lot at the end of a run shares nothing — so this
 * cannot put a wall on the carriageway.
 */
export function standingGround(building: Building): Point[] {
  const lot = building.lot;
  const f0 = lot[0] as Point;
  const f1 = lot[1] as Point;
  const span = Math.hypot(f1.x - f0.x, f1.y - f0.y) || 1;
  // Along the front edge, from the first corner towards the second: the way out
  // of the lot across the side edge at the second corner.
  const t = { x: (f1.x - f0.x) / span, y: (f1.y - f0.y) / span };
  const left = building.shared.left ? WALL_SLACK : 0;
  const right = building.shared.right ? WALL_SLACK : 0;
  const out = (corner: Point, reach: number): Point => ({ x: corner.x + t.x * reach, y: corner.y + t.y * reach });
  return [out(f0, -left), out(f1, right), out(lot[2] as Point, right), out(lot[3] as Point, -left)];
}

/**
 * Which batch a building belongs to. A tower and a mid-rise take a generated
 * facade, but only where the lot leaves the generator room for its bays once the
 * cornices have been allowed for; a narrower one is built as a block.
 */
export function batchOf(kind: BuildingKind, massing: { width: number; depth: number }): BuildingBatch {
  if (kind !== 'tower' && kind !== 'mid-rise') return 'block';
  const footprint = facadeFootprint(massing);
  return footprint.width >= MIN_FACADE && footprint.depth >= MIN_FACADE ? 'facade' : 'block';
}

/**
 * The footprint a generated facade is given: the massing less the reach of its
 * cornices on every side.
 *
 * The allowance is the same on a shared side edge as on any other, because a
 * wider footprint is more bays, and a bay is the dearest geometry a chunk of
 * the core builds. The shell that comes back is stretched along the frontage
 * instead, which `building-mesh.ts` does once it has measured it.
 */
export function facadeFootprint(massing: { width: number; depth: number }): { width: number; depth: number } {
  return { width: massing.width - 2 * CORNICE, depth: massing.depth - 2 * CORNICE };
}

/** How a shell is scaled to stand in the massing it was built for. */
export interface Fit {
  /** The scale along the frontage, which is `x` in the building's own frame. */
  along: number;
  /** The scale across it and upwards. It stays uniform, so nothing stands squat. */
  across: number;
}

/**
 * How much a shell has to be taken in to stand inside its massing, and so
 * inside its lot and off the road, from the ground the built shell really
 * covers.
 *
 * A generated facade reaches out past the footprint it was given by however
 * much its cornices and its crown overhang, and by more of it on a narrow tower
 * than on a wide one, so the shell is measured rather than trusted. Nothing is
 * ever made larger that way: a shell that fits is left alone.
 *
 * A wall with a neighbour against it is the one thing that is made larger. Such
 * a shell has to reach the edge of the lot, where a facade built on a footprint
 * a whole {@link CORNICE} narrower than the massing lands a metre short of it,
 * and a wall a metre short at both ends is a slot cut through the street wall.
 * So it is stretched along the frontage by what it measures short, up to
 * {@link MAX_STRETCH}. Stretching costs no geometry, where a wider footprint
 * would be another bay on every tower of the core.
 */
export function fitOf(covers: { width: number; depth: number }, massing: BuildingMassing, shared: boolean): Fit {
  const room = covers.width > 0 ? massing.width / covers.width : 1;
  const across = Math.min(1, room, covers.depth > 0 ? massing.depth / covers.depth : 1);
  return { along: shared ? Math.max(across, Math.min(MAX_STRETCH, room)) : across, across };
}

/**
 * Which front corner of a lot is cut away, if either. The lot fronts one road
 * graph edge, so the junctions that can face it are the two ends of that edge; a
 * corner within reach of one takes the chamfer, and the nearer corner wins where
 * both are.
 */
export function chamferOf(building: Building, graph: RoadGraph): number {
  const edge = graph.edges[building.road] as RoadEdge | undefined;
  if (edge === undefined) return 0;
  let best = CHAMFER_REACH;
  let side = 0;
  for (const node of [edge.from, edge.to]) {
    const at = graph.nodes[node];
    if (at === undefined || graph.degree(node) < JUNCTION_DEGREE) continue;
    // The first point of the lot is the corner that stands at local +x, the
    // second the one at -x: the frame runs along the frontage the other way.
    const corners = [building.lot[0] as Point, building.lot[1] as Point];
    for (let i = 0; i < corners.length; i++) {
      const corner = corners[i] as Point;
      const distance = Math.hypot(at.x - corner.x, at.y - corner.y);
      if (distance >= best) continue;
      best = distance;
      side = i === 0 ? 1 : -1;
    }
  }
  return side;
}

/** A number in 0..1 from a building's seed, for the draws the renderer makes. */
function unit(seed: number, salt: number): number {
  return hashInts(seed, salt) / 0x100000000;
}

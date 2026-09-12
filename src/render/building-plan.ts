/**
 * How big a building is and where on its lot it may stand (spec section 10.3).
 *
 * `building-mesh.ts` builds the geometry; this says what ground it is built on.
 * The massing is the lot less a margin, and the margin is what keeps a shell
 * off the ground beside it. A generated facade is asked for {@link CORNICE}
 * less again, because its cornices, string courses and crown all overhang the
 * footprint it is given. What still reaches past the massing is taken in by the
 * scale of the placement, which `building-mesh.ts` measures.
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
   * Which front corner is cut away to face a junction: 1 the corner at the first
   * point of the lot, -1 the corner at the second, 0 neither. Only a generated
   * facade takes one.
   */
  chamfer: number;
}

/** Metres the shell stands in from the edge of its lot, so two neighbours never meet. */
const KIND_MARGIN: Record<BuildingKind, number> = {
  tower: 0.5,
  'mid-rise': 0.5,
  'shop-row': 0.4,
  house: 0.9,
  warehouse: 0.8,
  roadhouse: 1.2,
};

/**
 * Metres a generated facade reaches out past the footprint it is given: the
 * cornices of its base, its string courses and its crown all overhang. The
 * footprint is shrunk by this much on every side, so the whole shell stands
 * inside the lot.
 */
export const CORNICE = 2;

/** Metres of facade the generator needs each way. A lot narrower than this takes a block. */
const MIN_FACADE = 8;

/** Metres each way the massing is never allowed below, however small the lot. */
const MIN_MASSING = 4;

/** How tall each kind stands, before the district and the lot have their say. */
const KIND_HEIGHT: Record<BuildingKind, { low: number; high: number }> = {
  tower: { low: 48, high: 150 },
  'mid-rise': { low: 14, high: 34 },
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

/** How much of a building's height comes from the district rather than its own seed. */
const DISTRICT_SHARE = 0.45;

/** Metres of the chamfer cut off a corner that faces a junction, at most. */
export const CHAMFER_WIDTH = 3;
/** Metres a lot corner may stand from a junction and still be cut for it. */
const CHAMFER_REACH = 16;
/** Edges leaving a node before it counts as a junction rather than a bend. */
const JUNCTION_DEGREE = 3;

/** Metres the base of a building is sunk, so no daylight shows under a wall on a slope. */
export const FOUNDATION = 0.5;

/** The massing of a building, from its lot, its kind and the district it stands in. */
export function massingOf(building: Building, district: District, chamfer: number): BuildingMassing {
  const flat = plan(building);
  const span = KIND_HEIGHT[building.kind];
  // The district has its say on the kinds that grow tall; a house is a house
  // wherever it stands.
  const crowd = building.kind === 'tower' ? (district.density + district.wealth) / 2 : district.density;
  const pull = building.kind === 'tower' || building.kind === 'mid-rise' ? DISTRICT_SHARE : 0;
  const t = unit(building.seed, 1) * (1 - pull) + crowd * pull;
  // A tall building needs a lot to stand on: its own narrow side is what caps it.
  const ceiling = Math.min(span.high, Math.max(span.low, Math.min(flat.width, flat.depth) * MAX_SLENDERNESS));
  return { width: flat.width, depth: flat.depth, height: span.low + (ceiling - span.low) * t, chamfer };
}

/** The ground a building's shell covers, before its height is known. */
export function plan(building: Building): { width: number; depth: number } {
  const margin = KIND_MARGIN[building.kind];
  return {
    width: Math.max(MIN_MASSING, building.width - 2 * margin),
    depth: Math.max(MIN_MASSING, building.depth - 2 * margin),
  };
}

/**
 * Which batch a building belongs to. A tower and a mid-rise take a generated
 * facade, but only where the lot leaves the generator room for its bays once the
 * cornices have been allowed for; a narrower one is built as a block.
 */
export function batchOf(kind: BuildingKind, massing: { width: number; depth: number }): BuildingBatch {
  if (kind !== 'tower' && kind !== 'mid-rise') return 'block';
  return facadeFootprint(massing).width >= MIN_FACADE && facadeFootprint(massing).depth >= MIN_FACADE
    ? 'facade'
    : 'block';
}

/** The footprint a generated facade is given: the massing less the reach of its cornices. */
export function facadeFootprint(massing: { width: number; depth: number }): { width: number; depth: number } {
  return { width: massing.width - 2 * CORNICE, depth: massing.depth - 2 * CORNICE };
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

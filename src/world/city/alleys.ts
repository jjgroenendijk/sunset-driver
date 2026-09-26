/**
 * The alley of a dense block (spec section 6.2): the bins, the loading bays and
 * the shortcut behind the buildings.
 *
 * An alley is a service lane inside one block, not a second street network. It
 * was once laid as another streamline fill, seeded along every street at half
 * the street spacing, and that put a road every forty metres through downtown
 * and left each block in strips. So the lane is planned per block instead:
 *
 * - A street is walked, and at every block along it the ground each side is
 *   measured out to the next road. That distance is the block's depth, and the
 *   lane goes down the middle of it, so it stands between the two streets
 *   rather than at a spacing taken from the zone table.
 * - Open ground, where nothing stands within reach, is not a block and takes no
 *   lane.
 * - A block too shallow to leave a strip worth building on each side takes
 *   none either. A strip has to be deep enough for the zone's own lots, front
 *   to back, and to come to the zone's `minBuilt` in area. Downtown that asks
 *   for about sixty metres of block, so the lane appears where the grid is
 *   wide and nowhere else.
 * - The candidates are laid shallowest block first, so the lane runs down the
 *   long axis of its block and halves the short side. The fill then refuses
 *   every later candidate inside the same block, because the lane already laid
 *   stands within the clearance of it. One block, one alley.
 *
 * The lane itself is traced by the same fill machinery as a street. This file
 * only says where one is worth laying.
 */
import { dist } from '../../core/math.ts';
import { compareNumbers } from '../../core/sort.ts';
import { atan2, cos, sin } from '../../core/libm.ts';
import type { FillSeed, PlanAt } from '../roads/fill.ts';
import type { RoadNetwork } from '../roads/road-network.ts';
import { ALLEY, DEAD_END_SPACINGS } from '../roads/road-trace.ts';
import { footprintHalfWidth } from '../roads/tiers.ts';
import type { Point, RoadCurve } from '../types.ts';

/** Metres between the samples that measure a block's depth out from a street. */
const PROBE_STEP = 6;
/**
 * How far past the zone's own street spacing a block may reach before the
 * ground counts as open rather than as a block. A block a half wider than the
 * spacing is still a block; twice as wide is a gap in the grid.
 */
const PROBE_REACH = 1.5;

/** What the ground under a street says about the alley it could carry. */
export interface AlleyGround {
  /** Ground an alley may stand on at all: paved, and dense enough to want one. */
  within: (x: number, y: number) => boolean;
  /** The smallest strip a lane may leave beside it: metres front to back, and square metres. */
  minStrip: (x: number, y: number) => { depth: number; area: number };
  /** Metres of the block's long side here, which is how far a strip beside a lane runs. */
  blockLength: (x: number, y: number) => number;
  /** Metres between neighbouring streets here, as the zone's own spacing has it. */
  streetGap: (x: number, y: number) => number;
}

/** What the fill lays for an alley, wherever one is seeded. */
export function alleyPlan(ground: AlleyGround): PlanAt {
  return (x, y) => ({
    tier: 'alley',
    params: ALLEY,
    // A lane runs the length of its block before it may rejoin the street that
    // seeded it, so it never doubles straight back into it.
    spacing: ground.blockLength(x, y),
    // A quarter of the street spacing: wide enough to refuse a second lane in
    // the same block, narrow enough that the streets each side of the first do
    // not refuse it.
    clearance: ground.streetGap(x, y) / 4,
    deadEnd: ground.streetGap(x, y) * 0.5 * DEAD_END_SPACINGS,
    within: ground.within,
  });
}

/** One place an alley could go, and how deep the block it would halve is. */
interface Candidate {
  seed: FillSeed;
  depth: number;
}

/**
 * Where every alley worth laying would go, shallowest block first. The order is
 * what makes a lane run down the long axis of its block: the shallow side of a
 * block is measured from the street that runs along its long side, so that
 * candidate is taken and the one across it is refused.
 */
export function alleySeeds(streets: readonly RoadCurve[], network: Pick<RoadNetwork, 'nearest'>, ground: AlleyGround): FillSeed[] {
  const found: Candidate[] = [];
  for (const curve of streets) {
    if (curve.tier === 'street') streetCandidates(curve, network, ground, found);
  }
  // Shallowest first, and the place itself breaks a tie, so the order is the
  // same on every machine whatever order the streets were laid in.
  found.sort(
    (p, q) => compareNumbers(p.depth, q.depth) || compareNumbers(p.seed.x, q.seed.x) || compareNumbers(p.seed.y, q.seed.y),
  );
  return found.map((candidate) => candidate.seed);
}

/** The places along one street an alley could go, a street gap apart, pushed onto `found`. */
function streetCandidates(curve: RoadCurve, network: Pick<RoadNetwork, 'nearest'>, ground: AlleyGround, found: Candidate[]): void {
  const points = curve.points;
  let run: number | undefined;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const seg = dist(a.x, a.y, b.x, b.y);
    if (seg === 0) continue;
    const step = ground.streetGap(b.x, b.y);
    // A deck or a bore has no block beside it: there is no ground there at all.
    const structure = curve.bridges.includes(i) || curve.tunnels.includes(i);
    run = (run ?? step / 2) + seg;
    if (run < step || structure) continue;
    run -= step;
    if (!ground.within(b.x, b.y)) continue;
    const along = atan2(b.y - a.y, b.x - a.x);
    for (const hand of [1, -1]) {
      const candidate = sideCandidate(curve, network, ground, b, along, hand, step);
      if (candidate !== undefined) found.push(candidate);
    }
  }
}

/** The alley across the block on one side of a street at a point, or undefined where the block takes none. */
function sideCandidate(curve: RoadCurve, network: Pick<RoadNetwork, 'nearest'>, ground: AlleyGround, b: Point, along: number, hand: number, step: number): Candidate | undefined {
  const nx = -sin(along) * hand;
  const ny = cos(along) * hand;
  const depth = blockDepth(network, b, nx, ny, step * PROBE_REACH, curve.id);
  if (depth === undefined) return undefined;
  const strip = depth / 2 - footprintHalfWidth('alley');
  const least = ground.minStrip(b.x, b.y);
  if (strip < least.depth || strip * ground.blockLength(b.x, b.y) < least.area) return undefined;
  const x = b.x + (nx * depth) / 2;
  const y = b.y + (ny * depth) / 2;
  return { depth, seed: { x, y, along, parent: curve.id, depth: 0, onParent: false } };
}

/**
 * How deep the block on one side of a street is: the metres out to the next
 * road, sampled a step at a time. Nothing within reach means open ground rather
 * than a block, and open ground takes no alley.
 */
function blockDepth(network: Pick<RoadNetwork, 'nearest'>, from: Point, nx: number, ny: number, reach: number, parent: number): number | undefined {
  for (let out = PROBE_STEP; out <= reach; out += PROBE_STEP) {
    const hit = network.nearest(from.x + nx * out, from.y + ny * out, PROBE_STEP, parent);
    if (hit !== undefined) return dist(from.x, from.y, hit.x, hit.y);
  }
  return undefined;
}

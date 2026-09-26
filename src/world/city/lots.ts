/**
 * How a parcel's frontage is cut into lots (spec section 10.3).
 *
 * `buildings.ts` is the door onto this: it asks for the lots of a parcel and
 * says what stands on each of them. This file is the cut itself, and
 * `lot-geom.ts` the arithmetic it runs on.
 *
 * A lot is laid on the frontage: the run of the parcel's boundary that stands
 * on the ground a road claims. Every lot therefore has a road along its front
 * edge, and a building is entered from the road the way a driver reaches it.
 *
 * Three rules make a street a wall of buildings rather than a row of boxes with
 * daylight between them.
 *
 * A lot reaches half way across the block where the ground opposite fronts a
 * road of its own, so two rows back to back each get half of it. The row laid
 * first used to take the whole depth its zone asks for, which left a block 40 m
 * across built on one side and empty on the other.
 *
 * In the core and the inner ring the lots of one run share their side edges:
 * `LotSpec.attached` is set, the gap is nothing, and the side edge of a lot is
 * the bisector of its own frontage and its neighbour's, so a wall that follows
 * a bend has neither a wedge nor an overlap in it. Elsewhere a zone keeps its
 * gardens and its driveways.
 *
 * Where two runs of one parcel meet at a corner, the run laid first takes the
 * corner and the second starts behind the building standing on it. That is a
 * plain corner block: the corner is built on, and neither street has a notch.
 *
 * A lot never leaves its parcel, and two lots of one parcel never overlap.
 * Nothing is laid and then pushed off its neighbour (spec section 1.2): a lot
 * is laid at the depth that fits, or it is not laid at all.
 */
import { ringArea, type Point, type Region } from '../../core/geom.ts';
import { atan2, hypot } from '../../core/libm.ts';
import type { RoadEdge, RoadGraph } from '../roads/graph.ts';
import {
  MM,
  distanceSquaredToLine,
  insideRegion,
  isConvex,
  lengthOf,
  nearestSquared,
  pointAlong,
  rayToBoundary,
  ringsClash,
  round,
  sampleRing,
  step,
} from './lot-geom.ts';
import type { Parcel } from './parcels.ts';
import { footprintHalfWidth } from '../roads/tiers.ts';
import type { Zone } from '../types.ts';

/** How a zone cuts its frontage into lots. Metres throughout. */
export interface LotSpec {
  /** Frontage one lot wants. The run is divided into whole lots about this wide. */
  width: number;
  /** Frontage below which the run is left uncut rather than divided again. */
  minWidth: number;
  /** How far back from the road a lot reaches when the parcel has the room. */
  depth: number;
  /** Depth below which a lot is dropped rather than squeezed in. */
  minDepth: number;
  /** How far the front edge stands back from the parcel boundary. */
  setback: number;
  /** Metres of open ground between one lot and the next along the frontage. */
  gap: number;
  /**
   * True where the buildings of a street share their walls. The lots of one run
   * then touch along their side edges, which is what makes a street a canyon,
   * and the gap such a zone keeps is nothing.
   */
  attached: boolean;
}

export const ZONE_LOTS: Record<Zone, LotSpec> = {
  // Downtown and the ring around it build a street wall: party walls, no gap.
  core: { width: 24, minWidth: 13, depth: 28, minDepth: 14, setback: 0.5, gap: 0, attached: true },
  inner: { width: 22, minWidth: 12, depth: 26, minDepth: 11, setback: 1, gap: 0, attached: true },
  industrial: { width: 45, minWidth: 20, depth: 45, minDepth: 15, setback: 3, gap: 4, attached: false },
  // Gardens and driveways: a deep setback and room between the houses.
  suburban: { width: 16, minWidth: 9, depth: 20, minDepth: 8, setback: 4, gap: 3, attached: false },
  outskirts: { width: 30, minWidth: 12, depth: 28, minDepth: 10, setback: 6, gap: 8, attached: false },
  wilderness: { width: 34, minWidth: 14, depth: 30, minDepth: 12, setback: 8, gap: 20, attached: false },
};

/** Metres between the points of a parcel boundary that are asked which road runs along them. */
const FRONT_STEP = 4;
/**
 * Metres past the ground a road claims that a boundary still counts as
 * frontage. `parcels.ts` allows the same slack when it asks which roads run
 * along a parcel, so the two agree on where a parcel meets its road.
 */
export const FRONT_REACH = 2;
/** Samples a frontage run needs before a lot is laid on it: a corner is not a frontage. */
const MIN_RUN_SAMPLES = 2;
/**
 * The depths a lot is tried at, as a share of the depth the ground allows it. A
 * lot that does not fit is shortened rather than moved, so its front stays on
 * the road; the zone's own least depth is the floor under every try.
 */
const DEPTH_TRIES = [1, 0.7, 0.45];
/**
 * Metres of open ground two detached lots of one parcel keep between them. A
 * lot that comes closer than this to one already laid is shortened, and dropped
 * where even its zone's least depth comes closer, so the sweep can ask a
 * detached zone for daylight rather than for overlap.
 */
const LOT_CLEARANCE = 0.1;
/**
 * Metres two attached lots may overlap: one millimetre, the grid their corners
 * are rounded onto. They share a side edge, so the question to ask there is
 * overlap and not daylight, and the rounding of a shared corner is not a clash.
 */
const LOT_TOUCH = MM;
/** Metres along a frontage between the probes that find where a corner building ends. */
const PROBE_STEP = 2;
/**
 * The least squarely a boundary must cross a ray for the ground behind it to
 * count as the other side of the block, as a sine: an eighth of a turn either
 * way of square.
 */
const MIN_ACROSS = 0.707;
/**
 * The least a side edge may lean away from its front edge's own normal, as a
 * cosine. A frontage that bends harder than this inside one lot takes a square
 * side edge instead, because a bisector that flat folds the lot over itself.
 */
const MIN_MITRE = 0.5;

/** A lot before it is given a building. */
export interface Lot {
  /** Four corners wound anticlockwise: the two of the front edge first, then the back. */
  corners: Point[];
  area: number;
  /**
   * Metres across the lot: the widest box that stands inside it, square to its
   * front edge and in the middle of it. That is the frontage itself only where
   * the side edges do not lean; see {@link widthOf}.
   */
  width: number;
  /** Metres from the front edge to the back of the lot. */
  depth: number;
  front: Point;
  facing: number;
  road: number;
  /**
   * Which side edges of the lot another lot of the same row lies against: the
   * edge at the first corner of the front edge, and the edge at the second.
   * Only an attached zone shares an edge at all, and only where the neighbour
   * was laid: a lot the row dropped leaves its neighbour's edge bare.
   */
  shared: Shared;
}

/** Which of a lot's two side edges carry a neighbour's wall. */
export interface Shared {
  /** The edge at the first corner of the front edge. */
  left: boolean;
  /** The edge at the second. */
  right: boolean;
}

/** The daylight a zone keeps between two of its lots. Attached lots touch instead. */
function lotDaylight(spec: LotSpec): number {
  return spec.attached ? -LOT_TOUCH : LOT_CLEARANCE;
}

/**
 * Cut one parcel's frontage into lots, in the order the boundary runs.
 *
 * Each run of boundary along one road is divided into whole lots of about the
 * width the zone wants, so a frontage is covered evenly rather than left with a
 * stub at its far end. A lot that will not fit is shortened, and dropped only
 * where even the zone's least depth overhangs the parcel or reaches a lot
 * already laid.
 */
export function lotsOf(parcel: Parcel, graph: RoadGraph): Lot[] {
  const spec = ZONE_LOTS[parcel.zone];
  const daylight = lotDaylight(spec);
  const runs = frontagesOf(parcel, graph);
  // Every frontage sample of the parcel, which is how a lot asks whether the
  // ground opposite it fronts a road of its own.
  const fronts: Point[] = [];
  for (const run of runs) for (const point of run.points) fronts.push(point);
  const out: Lot[] = [];
  for (const run of runs) {
    const whole = lotCount(run.length, spec);
    if (whole === 0) continue;
    // The corner of a parcel belongs to the run laid first. This one starts
    // behind the building standing on it and ends short of the next corner.
    const nominal = run.length / whole - spec.gap;
    const probe = {
      spec,
      region: parcel.region,
      fronts,
      placed: out,
      daylight,
    };
    const from = freeFrom(run, spec, probe, nominal);
    const to = freeTo(run, spec, probe, nominal);
    const count = to > from ? lotCount(to - from, spec) : 0;
    if (count === 0) continue;
    const row = rowOf(run, spec, from, (to - from) / count, count);
    const laid: (Lot | undefined)[] = [];
    for (let i = 0; i < count; i++) {
      const lot = lotAt(row, i, parcel.region, fronts, out, daylight);
      laid.push(lot);
      if (lot !== undefined) out.push(lot);
    }
    markWalls(laid, spec);
  }
  return out;
}

/**
 * Say which side edges of a row carry a neighbour's wall.
 *
 * Both lots at a boundary take the same side edge, so where the zone builds a
 * street wall the ground past that edge is the neighbour's. The renderer keeps
 * its facade clear of every other edge and reaches to this one, which is what
 * leaves no slot in the wall. A lot the row dropped shares nothing: there is no
 * wall on that side to stand against.
 */
function markWalls(laid: readonly (Lot | undefined)[], spec: LotSpec): void {
  if (!spec.attached) return;
  for (let i = 0; i < laid.length; i++) {
    const lot = laid[i];
    if (lot === undefined) continue;
    lot.shared = { left: laid[i - 1] !== undefined, right: laid[i + 1] !== undefined };
  }
}

/** How many lots a run of frontage is divided into; none when it is too short for one. */
function lotCount(length: number, spec: LotSpec): number {
  let count = Math.max(1, Math.round(length / spec.width));
  while (count > 1 && length / count - spec.gap < spec.minWidth) count--;
  return length / count - spec.gap >= spec.minWidth ? count : 0;
}

/**
 * One run of frontage divided into lots, before any of them is laid.
 *
 * The row is cut first so that a lot knows its neighbours. Where the zone
 * builds a street wall, the side edge between two lots is the bisector of the
 * two frontages meeting there: both lots take the same edge, so a wall along a
 * bend has no wedge in it and the two lots cannot overlap.
 */
interface Row {
  run: Frontage;
  spec: LotSpec;
  /** The two ends of each lot's stretch of frontage, before the setback. */
  from: Point[];
  to: Point[];
  /** Which way each lot's front edge faces into the parcel. */
  into: Point[];
  /** Which way the side edge at each boundary runs into the parcel, one more than there are lots. */
  side: Point[];
  /** How far along a side edge one metre of depth is. */
  reach: number[];
}

function rowOf(run: Frontage, spec: LotSpec, start: number, pitch: number, count: number): Row {
  const from: Point[] = [];
  const to: Point[] = [];
  const into: Point[] = [];
  for (let i = 0; i < count; i++) {
    // The gap the zone keeps is taken off both ends of the pitch, so an
    // attached zone's lots meet exactly at the boundary between them.
    const a = pointAlong(run.points, start + i * pitch + spec.gap / 2);
    const b = pointAlong(run.points, start + (i + 1) * pitch - spec.gap / 2);
    const span = hypot(b.x - a.x, b.y - a.y);
    from.push(a);
    to.push(b);
    // Across the frontage, into the parcel: the outer ring is wound
    // anticlockwise, so the ground it encloses is on the left of the walk.
    into.push(span > 0 ? { x: -(b.y - a.y) / span, y: (b.x - a.x) / span } : { x: 0, y: 0 });
  }
  const side: Point[] = [];
  const reach: number[] = [];
  for (let i = 0; i <= count; i++) {
    const own = into[Math.min(i, count - 1)] as Point;
    const other = into[Math.max(0, i - 1)] as Point;
    const dx = own.x + other.x;
    const dy = own.y + other.y;
    const span = hypot(dx, dy);
    // Only an attached lot meets its neighbour at all, and a lot at the end of
    // a run has no neighbour there to share an edge with.
    const lean = spec.attached && i > 0 && i < count && span > 0 ? (dx * own.x + dy * own.y) / span : 0;
    if (lean >= MIN_MITRE) {
      side.push({ x: dx / span, y: dy / span });
      reach.push(1 / lean);
    } else {
      side.push({ x: own.x, y: own.y });
      reach.push(1);
    }
  }
  return { run, spec, from, to, into, side, reach };
}

/**
 * One lot of a row, or nothing where no depth the zone accepts stands inside
 * the parcel and clear of the lots already laid.
 *
 * The deepest try that fits wins, so a shallow strip of ground carries a
 * shallow building rather than none.
 */
function lotAt(
  row: Row,
  i: number,
  region: Region,
  fronts: readonly Point[],
  placed: readonly Lot[],
  daylight: number,
): Lot | undefined {
  const spec = row.spec;
  const a = row.from[i] as Point;
  const b = row.to[i] as Point;
  const frontage = hypot(b.x - a.x, b.y - a.y);
  if (frontage < spec.minWidth) return undefined;
  const left = row.side[i] as Point;
  const right = row.side[i + 1] as Point;
  const leftReach = row.reach[i] as number;
  const rightReach = row.reach[i + 1] as number;
  const f0 = step(a, left, spec.setback * leftReach);
  const f1 = step(b, right, spec.setback * rightReach);
  const into = row.into[i] as Point;
  const deepest = Math.min(spec.depth, roomFor(region, fronts, f0, f1, into, spec));
  if (deepest < spec.minDepth) return undefined;
  for (const share of DEPTH_TRIES) {
    const depth = Math.max(spec.minDepth, deepest * share);
    if (depth > deepest + MM) continue;
    const corners = [
      round(f0),
      round(f1),
      round(step(f1, right, depth * rightReach)),
      round(step(f0, left, depth * leftReach)),
    ];
    if (!isConvex(corners)) continue;
    // A leaning side edge makes the lot a trapezoid, so what stands on it is
    // narrower than its frontage.
    const width = widthOf(corners);
    if (width < spec.minWidth) continue;
    if (clashesWith(corners, placed, daylight)) continue;
    if (!insideRegion(corners, region)) continue;
    return {
      corners,
      area: ringArea(corners),
      width,
      depth,
      front: round({ x: (f0.x + f1.x) / 2, y: (f0.y + f1.y) / 2 }),
      facing: facingOf(corners),
      road: row.run.road,
      // The row says which of these edges has a neighbour against it, once it
      // knows which of its lots were laid.
      shared: { left: false, right: false },
    };
  }
  return undefined;
}

/**
 * Which way a lot looks: out of it, across its own front edge, at the road.
 *
 * The front edge and not the frontage under it. A setback taken along two side
 * edges that lean different ways turns the one slightly against the other, and
 * what a facade is parallel to is the edge it stands on.
 */
function facingOf(corners: readonly Point[]): number {
  const f0 = corners[0] as Point;
  const f1 = corners[1] as Point;
  return atan2(-(f1.x - f0.x), f1.y - f0.y);
}

/**
 * Metres across a lot: the widest building that stands inside it.
 *
 * The renderer builds a box of this width in the middle of the lot, square to
 * its front edge, and leans it onto the side edges only where the lot shares
 * one. The front and back edges of a lot are parallel, so the box is
 * bounded by whichever of the two leaning side edges comes nearer the middle —
 * on a frontage that curves one way the lot is a parallelogram, and its
 * frontage is then wider than anything that fits inside it.
 */
function widthOf(corners: readonly Point[]): number {
  const f0 = corners[0] as Point;
  const f1 = corners[1] as Point;
  const span = hypot(f1.x - f0.x, f1.y - f0.y);
  if (span === 0) return 0;
  const tx = (f1.x - f0.x) / span;
  const ty = (f1.y - f0.y) / span;
  let middleX = 0;
  let middleY = 0;
  for (const corner of corners) {
    middleX += corner.x / corners.length;
    middleY += corner.y / corners.length;
  }
  const along = (p: Point): number => (p.x - middleX) * tx + (p.y - middleY) * ty;
  const left = Math.max(along(f0), along(corners[3] as Point));
  const right = Math.min(along(f1), along(corners[2] as Point));
  return 2 * Math.min(-left, right);
}

/** True when a ring reaches any of the lots already laid on the parcel. */
function clashesWith(ring: readonly Point[], placed: readonly Lot[], daylight: number): boolean {
  for (const lot of placed) if (ringsClash(ring, lot.corners, daylight)) return true;
  return false;
}

/**
 * How deep a lot may reach at a place on the frontage.
 *
 * The room is what the parcel leaves in front of it: the first boundary a ray
 * into the parcel meets. Where that boundary fronts a road of its own, the two
 * rows share the block, so each takes half of what is left once the far row's
 * setback and the daylight between their backs are allowed for. Without that
 * the row laid first takes the depth its zone asks for and the other side of a
 * narrow block is left empty.
 *
 * A block too narrow for two rows of the zone's least depth is not shared: one
 * deep row is worth more there than two the zone would drop.
 */
function roomFor(region: Region, fronts: readonly Point[], f0: Point, f1: Point, into: Point, spec: LotSpec): number {
  let least = Infinity;
  for (const from of [f0, f1, { x: (f0.x + f1.x) / 2, y: (f0.y + f1.y) / 2 }]) {
    const hit = rayToBoundary(region, from, into);
    if (hit.room <= 0) return 0;
    const opposite = step(from, into, hit.room);
    // A boundary running alongside the ray is the street down the side of a
    // corner lot, not the one across the block: it bounds the lot but it does
    // not share the ground behind it.
    const shared =
      hit.across > MIN_ACROSS && hit.room > FRONT_STEP && nearestSquared(fronts, opposite) < FRONT_STEP * FRONT_STEP;
    // Half the block each, but only where half is still a lot. A block too
    // narrow for two rows carries one deep row rather than none.
    const half = (hit.room - spec.setback - LOT_CLEARANCE) / 2;
    least = Math.min(least, shared && half >= spec.minDepth ? half : hit.room);
  }
  return Math.max(0, least);
}

/**
 * The offset a run's lots may start at: the first place a lot of the run's own
 * width stands clear of every lot already laid on the parcel. At a corner that
 * is where the building on the corner ends, so one street takes the corner and
 * the other starts behind it.
 *
 * The scan reaches no further than the depth the zone builds, because that is
 * as far along a frontage as a lot on the run beside it can reach. A run still
 * blocked there starts at nothing and its own lots are shortened, which is what
 * happens where a parcel is too tight for the zone whatever is tried.
 */
function freeFrom(run: Frontage, spec: LotSpec, probe: Probe, width: number): number {
  for (let at = 0; at <= spec.depth && at + width <= run.length + MM; at += PROBE_STEP) {
    if (!probeClashes(run, probe, at, width)) return at;
  }
  return 0;
}

/** The offset a run's lots may end at, found the same way from the far end. */
function freeTo(run: Frontage, spec: LotSpec, probe: Probe, width: number): number {
  for (let at = run.length; at >= run.length - spec.depth && at - width >= -MM; at -= PROBE_STEP) {
    if (!probeClashes(run, probe, at - width, width)) return at;
  }
  return run.length;
}

/** What a probe of a frontage is tested against. */
interface Probe {
  spec: LotSpec;
  region: Region;
  fronts: readonly Point[];
  placed: readonly Lot[];
  daylight: number;
}

/**
 * True when a lot at this offset would reach a lot already laid. The probe is
 * square and as deep as the ground there allows, which is the deepest any lot
 * of the run is laid at that place, so a place it clears every lot clears.
 */
function probeClashes(run: Frontage, probe: Probe, at: number, width: number): boolean {
  if (probe.placed.length === 0) return false;
  const a = pointAlong(run.points, at);
  const b = pointAlong(run.points, at + width);
  const span = hypot(b.x - a.x, b.y - a.y);
  if (span === 0) return false;
  const spec = probe.spec;
  const into = { x: -(b.y - a.y) / span, y: (b.x - a.x) / span };
  const f0 = step(a, into, spec.setback);
  const f1 = step(b, into, spec.setback);
  const depth = Math.min(spec.depth, roomFor(probe.region, probe.fronts, f0, f1, into, spec));
  if (depth < spec.minDepth) return false;
  return clashesWith([f0, f1, step(f1, into, depth), step(f0, into, depth)], probe.placed, probe.daylight);
}

/** One run of a parcel's boundary that stands along a single road. */
interface Frontage {
  /** The boundary itself, sampled every {@link FRONT_STEP} metres. */
  points: Point[];
  /** Metres of it. */
  length: number;
  /** The graph edge that runs along it. */
  road: number;
}

/**
 * The runs of a parcel's boundary that stand along a road.
 *
 * Only the outer ring is walked: a hole is ground the parcel encloses, and
 * nothing reaches it. The boundary is sampled at a fixed step rather than at
 * its corners, because a straight stretch of frontage can be one long edge and
 * a rounded one a crowd of short ones.
 *
 * A sample belongs to the nearest of the roads the parcel already lists, and a
 * run ends where that road changes, so a corner gives one run per road and each
 * lot fronts one of them.
 */
function frontagesOf(parcel: Parcel, graph: RoadGraph): Frontage[] {
  const ring = parcel.region.outer;
  const samples = sampleRing(ring, FRONT_STEP);
  if (samples.length < MIN_RUN_SAMPLES) return [];
  const roads = parcel.roads.map((edge) => ({
    edge,
    points: graph.edgePoints(edge),
    reachSquared: (footprintHalfWidth((graph.edges[edge] as RoadEdge).tier) + FRONT_REACH) ** 2,
  }));
  const along: number[] = [];
  for (const sample of samples) {
    let found = -1;
    let best = Infinity;
    for (const road of roads) {
      const d = distanceSquaredToLine(sample, road.points);
      if (d > road.reachSquared || d >= best) continue;
      best = d;
      found = road.edge;
    }
    along.push(found);
  }

  // The ring is a loop, so a run may pass its first sample. Start where the
  // frontage breaks, and take the whole loop as one run where it never does.
  const count = samples.length;
  let start = 0;
  while (start < count && (along[start] as number) === (along[(start + count - 1) % count] as number)) start++;
  if (start === count) start = 0;

  const out: Frontage[] = [];
  let run: Point[] = [];
  let road = -1;
  const flush = (): void => {
    if (road >= 0 && run.length >= MIN_RUN_SAMPLES) out.push({ points: run, length: lengthOf(run), road });
    run = [];
  };
  for (let i = 0; i < count; i++) {
    const at = (start + i) % count;
    const edge = along[at] as number;
    if (edge !== road) {
      flush();
      road = edge;
    }
    run.push(samples[at] as Point);
  }
  flush();
  return out;
}

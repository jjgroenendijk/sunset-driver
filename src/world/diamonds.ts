/**
 * The ramps of an interchange (spec section 6.2: a highway has on and off
 * ramps and junctions only at interchanges). An arterial never meets a highway
 * at grade. Where it reaches one of the highway's interchanges it is given a
 * diamond instead, decided in the same `RoadNetwork.add` that lays it:
 *
 * - An arterial that ends on the interchange is cut back to a foot on the
 *   ground, and two ramps link the foot to the highway: an off-ramp from the
 *   carriageway on its side, and an on-ramp back onto it. That is half a
 *   diamond.
 * - An arterial that runs through the interchange is carried over the highway
 *   on an overpass, and each foot of the overpass takes the same two ramps.
 *   That is the whole diamond, four ramps.
 *
 * Traffic keeps to the right, so the ramps on the right of the highway's own
 * direction serve the carriageway that runs that way: the off-ramp leaves it
 * before the interchange and the on-ramp joins it after. The ramps of the other
 * side land on the same two places, for the other carriageway. A ramp is a
 * one-way arterial (`RoadCurve.ramp`), driven from its first point to its last.
 *
 * This file plans the ramps and nothing else: where they land on the highway,
 * the line each one takes, and whether the ground and the roads already laid
 * allow it. The network lays them.
 */
import { hypot, sin, tan } from '../core/libm.ts';
import { toSegment } from './crossing-line.ts';
import type { DraftLine } from './crossing-plan.ts';
import { crossPoint, TRACE_MEET, type Trail } from './network-clearance.ts';
import { curveDistances } from './ribbon.ts';
import { selfOverlap } from './self-overlap.ts';
import { footprintHalfWidth, TIERS } from './tiers.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/** Metres along an arterial from the interchange to the foot of a half diamond, the nearest tried first. */
export const HALF_FEET = [60, 75, 50] as const;
/** Metres further out than the foot of an overpass that the ramps leave the arterial, so their junction stands off its ramp. */
export const FOOT_MARGIN = 15;
/**
 * How far along the highway from the foot a ramp lands, as a share of how far
 * the foot stands from the highway, the likeliest first. The landing has to
 * stand on the ground, which the highway keeps to for `INTERCHANGE_CLEAR` each
 * side of the interchange, and the foot of an overpass stands some 120 m out:
 * the nearer shares are for it.
 */
const SPREADS = [1.2, 1.05, 0.9, 0.75, 0.6, 0.45] as const;
/**
 * The angles, in radians, a ramp meets the highway at, the gentlest tried
 * first: 40°, 55°, 70°. The tracer asks 35° of every meeting (`TRACE_MEET`).
 * The ramp bends from the line it leaves the foot on to this one. The foot of
 * an overpass stands so far out that a ramp leaving the arterial at 35° can
 * only reach the clear ground at the steeper angles.
 */
const LANDING_ANGLES = [40, 55, 70].map((degrees) => (degrees * Math.PI) / 180);
/** Metres along the highway a landing keeps from any other junction on it. */
const LANDING_GAP = 35;
/** Longest piece of a ramp, in metres: each is vetted on the ground as a step of its own. */
const PIECE = 12;
/** Metres an arterial's point on an interchange is moved along the highway so the two cross inside a segment. */
const NUDGE = 1.5;

/** What the planner asks of the network. */
export interface DiamondNetwork {
  readonly curves: readonly RoadCurve[];
  canRun(a: Point, b: Point, tier: RoadTier): boolean;
  stepOk(a: Point, b: Point, tier: RoadTier, trail?: Trail, meet?: Point): boolean;
  curvesAt(p: Point): number[];
  sharedAt(curve: number, index: number): boolean;
}

/** A ramp as planned: its line in the direction of travel, and where it lands on which highway. */
export interface RampPlan {
  points: Point[];
  exit: boolean;
  highway: number;
  /** The place it lands on; it may be a point of the highway already. */
  landing: Point;
}

/** A highway through the interchange, and the index of its point there. */
export interface HighwayMeet {
  highway: RoadCurve;
  at: number;
}

/** A place on the highway a ramp lands on. */
interface Landing {
  segment: number;
  at: Point;
}

/**
 * The two ramps of one foot, or undefined where either cannot be laid. `foot`
 * is the index of the foot in `road`, the arterial as it will be laid; `meets`
 * are the highways through the interchange, the one it runs through first.
 * Each ramp lands on the first of them it fits: a highway that leaves the
 * interchange as a radial often stands in the way of a ramp to the one it
 * leaves, and takes the ramp instead. `planned` are ramps of the same
 * interchange already planned, which these keep off except where they share an
 * end.
 */
export function rampsAt(
  network: DiamondNetwork,
  road: DraftLine,
  foot: number,
  meets: readonly HighwayMeet[],
  planned: readonly RampPlan[] = [],
): RampPlan[] | undefined {
  const f = road.points[foot] as Point;
  const out: RampPlan[] = [];
  for (const exit of [true, false]) {
    const ramp = firstRamp(network, road, foot, f, meets, exit, [...planned, ...out]);
    if (ramp === undefined) return undefined;
    out.push(ramp);
  }
  return out;
}

/** The first ramp from a foot that fits, over the highways in order and the landings of each nearest first. */
function firstRamp(
  network: DiamondNetwork,
  road: DraftLine,
  foot: number,
  f: Point,
  meets: readonly HighwayMeet[],
  exit: boolean,
  planned: readonly RampPlan[],
): RampPlan | undefined {
  for (const { highway, at } of meets) {
    const last = highway.points.length - 1;
    const h = highway.points[at] as Point;
    const before = highway.points[Math.max(0, at - 1)] as Point;
    const after = highway.points[Math.min(last, at + 1)] as Point;
    const span = hypot(after.x - before.x, after.y - before.y);
    if (span === 0) continue;
    const t = { x: (after.x - before.x) / span, y: (after.y - before.y) / span };
    // The right hand of the highway's own direction, which is how `route-sample.ts` reads it.
    const right = { x: -t.y, y: t.x };
    const across = (f.x - h.x) * right.x + (f.y - h.y) * right.y;
    if (Math.abs(across) < footprintHalfWidth('highway') + footprintHalfWidth('ramp')) continue;
    // Right of the highway the carriageway runs with it: the exit leaves it
    // before the interchange and the entry joins it after.
    const way = (exit ? -1 : 1) * Math.sign(across);
    const distances = curveDistances(highway.points);
    const from = (distances[at] as number) + (f.x - h.x) * t.x + (f.y - h.y) * t.y;
    // A landing of the other side's ramps is tried first: the two
    // carriageways' ramps share their landings.
    const shared: number[] = [];
    for (const other of planned) {
      if (other.highway !== highway.id || other.exit === exit) continue;
      const along = alongAt(highway, distances, other.landing) - from;
      if (along * way > 0) shared.push(Math.abs(along) / Math.abs(across));
    }
    for (const angle of LANDING_ANGLES) {
      for (const spread of [...shared, ...SPREADS]) {
        const landing = landingAt(network, highway, distances, from + way * spread * Math.abs(across), planned);
        if (landing === undefined) continue;
        // The ramp leaves the foot towards a control point on the line that
        // meets the highway at `angle`, halfway back from the landing.
        const back = (spread * Math.abs(across)) / 2;
        const rise = back * tan(angle) * Math.sign(across);
        const control = { x: landing.at.x - way * back * t.x + rise * right.x, y: landing.at.y - way * back * t.y + rise * right.y };
        const line = rampLine(f, control, landing.at);
        if (!rampOk(network, road, foot, line, planned)) continue;
        return { points: exit ? line.slice().reverse() : line, exit, highway: highway.id, landing: landing.at };
      }
    }
  }
  return undefined;
}

/**
 * The place `along` metres down the highway where a ramp may land: on the
 * ground, no deck, bore or lift under it, both halves of the segment it cuts
 * within the highway's grade, and a gap clear of every other
 * junction the highway carries or `planned` ramps land on. A place already a
 * landing of another ramp is taken again, which is how the two sides of a
 * diamond share them.
 */
function landingAt(
  network: DiamondNetwork,
  highway: RoadCurve,
  distances: Float32Array,
  along: number,
  planned: readonly RampPlan[],
): Landing | undefined {
  const last = highway.points.length - 1;
  if (along <= 0 || along >= (distances[last] as number)) return undefined;
  let segment = 0;
  while (segment + 1 < last && (distances[segment + 1] as number) < along) segment++;
  if (highway.bridges.includes(segment) || highway.tunnels.includes(segment)) return undefined;
  if ((highway.lift?.[segment] ?? 0) !== 0 || (highway.lift?.[segment + 1] ?? 0) !== 0) return undefined;
  const from = distances[segment] as number;
  const to = distances[segment + 1] as number;
  const a = highway.points[segment] as Point;
  const b = highway.points[segment + 1] as Point;
  const u = to > from ? (along - from) / (to - from) : 0;
  const at = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  // Each half of the segment the landing cuts has to carry the highway: a
  // short half can climb harder than the whole segment did.
  if (!network.canRun(a, at, 'highway') || !network.canRun(at, b, 'highway')) return undefined;
  // The ramps planned with this one are not laid yet, so their landings are
  // no points of the highway: they keep the same gap.
  for (const other of planned) {
    const gap = hypot(other.landing.x - at.x, other.landing.y - at.y);
    if (gap > 1e-3 && gap < LANDING_GAP) return undefined;
  }
  for (let i = 0; i <= last; i++) {
    const gap = Math.abs((distances[i] as number) - along);
    if (gap >= LANDING_GAP || !network.sharedAt(highway.id, i)) continue;
    // A landing already made: every road on it is the highway or a ramp.
    const p = highway.points[i] as Point;
    const landed = hypot(p.x - at.x, p.y - at.y) < 1e-3;
    if (!landed || network.curvesAt(p).some((c) => c !== highway.id && (network.curves[c] as RoadCurve).ramp === undefined)) return undefined;
  }
  return { segment, at };
}

/** Metres along a highway to the place on it nearest `p`. */
function alongAt(highway: RoadCurve, distances: Float32Array, p: Point): number {
  let best = Infinity;
  let along = 0;
  for (let i = 0; i + 1 < highway.points.length; i++) {
    const a = highway.points[i] as Point;
    const b = highway.points[i + 1] as Point;
    const off = toSegment(p, a, b);
    if (off >= best) continue;
    best = off;
    const d = hypot(b.x - a.x, b.y - a.y);
    const u = d > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (d * d))) : 0;
    along = (distances[i] as number) + u * d;
  }
  return along;
}

/**
 * The line of a ramp from the foot to its landing: a quadratic curve that
 * leaves the foot towards `control` and meets the landing from it, in pieces
 * of at most {@link PIECE}.
 */
function rampLine(foot: Point, control: Point, landing: Point): Point[] {
  const reach = hypot(control.x - foot.x, control.y - foot.y) + hypot(landing.x - control.x, landing.y - control.y);
  const n = Math.max(1, Math.ceil(reach / PIECE));
  const out: Point[] = [];
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    const a = (1 - u) * (1 - u);
    const b = 2 * u * (1 - u);
    const c = u * u;
    out.push({ x: a * foot.x + b * control.x + c * landing.x, y: a * foot.y + b * control.y + c * landing.y });
  }
  return out;
}

/**
 * True where a ramp may be laid from the foot: the ground carries every piece,
 * the network allows every step and the meeting with the highway, and it keeps
 * off the arterial and the other ramps except where it shares an end with them.
 */
function rampOk(network: DiamondNetwork, road: DraftLine, foot: number, line: readonly Point[], planned: readonly RampPlan[]): boolean {
  const start = line[0] as Point;
  const landing = line[line.length - 1] as Point;
  if (selfOverlap(line, 'ramp') !== undefined) return false;
  const trail: Trail = { crossed: [], start };
  for (let k = 0; k + 1 < line.length; k++) {
    const a = line[k] as Point;
    const b = line[k + 1] as Point;
    if (!network.canRun(a, b, 'ramp')) return false;
    if (!network.stepOk(a, b, 'ramp', trail, k + 2 === line.length ? landing : undefined)) return false;
  }
  if (trail.crossed.length > 0) return false;
  if (!keepsOff(line, road.points, road.tier, road.points[foot] as Point)) return false;
  for (const other of planned) {
    const shared = [start, landing].find((p) => other.points.some((q) => hypot(q.x - p.x, q.y - p.y) < 1e-6));
    if (!keepsOff(line, other.points, 'ramp', shared)) return false;
  }
  return true;
}

/**
 * True where a ramp keeps off another line: it never crosses it, and every
 * point of it stands a footprint's reach clear, or, near the end the two share,
 * as clear as leaving it at the least angle a trace meets a road at.
 */
function keepsOff(ramp: readonly Point[], other: readonly Point[], tier: RoadTier, shared: Point | undefined): boolean {
  const reach = footprintHalfWidth('ramp') + footprintHalfWidth(tier);
  const sine = sin(TRACE_MEET);
  for (let i = 0; i + 1 < ramp.length; i++) {
    for (let j = 0; j + 1 < other.length; j++) {
      const at = crossPoint(ramp[i] as Point, ramp[i + 1] as Point, other[j] as Point, other[j + 1] as Point);
      if (at !== undefined && (shared === undefined || hypot(at.x - shared.x, at.y - shared.y) > 1e-3)) return false;
    }
  }
  for (const p of ramp) {
    const off = shared === undefined ? Infinity : hypot(p.x - shared.x, p.y - shared.y);
    const need = Math.min(reach, off * sine);
    for (let j = 0; j + 1 < other.length; j++) {
      if (toSegment(p, other[j] as Point, other[j + 1] as Point) < need - 1e-6) return false;
    }
  }
  return true;
}

/**
 * True where a road would lay its carriageway on a ramp away from the ramp's
 * two ends. A ramp takes no junction on the way, so a road that comes that
 * near it without crossing it is never joined to it, and the tracer can walk a
 * road there: a step it forces is not vetted.
 */
export function onRamp(ramps: readonly RoadCurve[], line: DraftLine): boolean {
  if (ramps.length === 0) return false;
  const box = boxOf(line.points);
  for (const ramp of ramps) {
    const clear = (TIERS.ramp.width + TIERS[line.tier].width) / 2;
    const other = boxOf(ramp.points);
    if (other.minX > box.maxX + clear || other.maxX < box.minX - clear || other.minY > box.maxY + clear || other.maxY < box.minY - clear) continue;
    const free = clear + footprintHalfWidth(line.tier);
    const ends = [ramp.points[0] as Point, ramp.points[ramp.points.length - 1] as Point];
    for (const p of ramp.points) {
      if (ends.some((e) => hypot(e.x - p.x, e.y - p.y) < free)) continue;
      for (let j = 0; j + 1 < line.points.length; j++) {
        if (line.bridges.includes(j) || line.tunnels.includes(j)) continue;
        if (toSegment(p, line.points[j] as Point, line.points[j + 1] as Point) < clear) return true;
      }
    }
  }
  return false;
}

/** The box a line stands in. */
function boxOf(points: readonly Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

// ------------------------------------------------------------ the arterial

/** True where a segment of a line lies plainly on the ground: no deck, no bore and no lift at either end. */
function plain(line: DraftLine, segment: number): boolean {
  if (line.bridges.includes(segment) || line.tunnels.includes(segment)) return false;
  return (line.lift?.[segment] ?? 0) === 0 && (line.lift?.[segment + 1] ?? 0) === 0;
}

/** A line the other way round, its structures with it. */
function reversed(line: DraftLine): DraftLine {
  const last = line.points.length - 1;
  const flip = (segments: readonly number[]): number[] => segments.map((s) => last - 1 - s).sort((a, b) => a - b);
  const out: DraftLine = {
    ...line,
    points: line.points.slice().reverse(),
    bridges: flip(line.bridges),
    tunnels: flip(line.tunnels),
    interchanges: line.interchanges.map((i) => last - i).sort((a, b) => a - b),
  };
  if (line.slots !== undefined) out.slots = flip(line.slots);
  if (line.lift !== undefined) out.lift = line.lift.slice().reverse();
  return out;
}

/** The part of a line from point `start` to point `end`, its structures with it. */
export function sliceLine(line: DraftLine, start: number, end: number): DraftLine {
  const keep = (segments: readonly number[]): number[] => segments.filter((s) => s >= start && s < end).map((s) => s - start);
  const out: DraftLine = {
    ...line,
    points: line.points.slice(start, end + 1),
    bridges: keep(line.bridges),
    tunnels: keep(line.tunnels),
    interchanges: line.interchanges.filter((i) => i >= start && i <= end).map((i) => i - start),
  };
  if (line.slots !== undefined) out.slots = keep(line.slots);
  if (line.lift !== undefined) out.lift = line.lift.slice(start, end + 1);
  return out;
}

/**
 * A line with a point put in `along` metres from its start, and the index of
 * that point. The segment it falls in must lie plainly on the ground, so the
 * point takes no lift and splits no deck. Where a point of the line already
 * stands there, that point is the one.
 */
export function withPointAlong(line: DraftLine, along: number): { line: DraftLine; index: number } | undefined {
  const distances = curveDistances(line.points);
  const last = line.points.length - 1;
  if (along < 0 || along > (distances[last] as number)) return undefined;
  for (let k = 0; k <= last; k++) if (Math.abs((distances[k] as number) - along) < 1e-3) return { line, index: k };
  let segment = 0;
  while (segment + 1 < last && (distances[segment + 1] as number) < along) segment++;
  if (!plain(line, segment)) return undefined;
  const a = line.points[segment] as Point;
  const b = line.points[segment + 1] as Point;
  const u = (along - (distances[segment] as number)) / ((distances[segment + 1] as number) - (distances[segment] as number));
  const at = segment + 1;
  const shift = (segments: readonly number[]): number[] => segments.map((s) => (s >= at ? s + 1 : s));
  const out: DraftLine = {
    ...line,
    points: [...line.points.slice(0, at), { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, ...line.points.slice(at)],
    bridges: shift(line.bridges),
    tunnels: shift(line.tunnels),
    interchanges: line.interchanges.map((i) => (i >= at ? i + 1 : i)),
  };
  if (line.slots !== undefined) out.slots = shift(line.slots);
  if (line.lift !== undefined) out.lift = [...line.lift.slice(0, at), 0, ...line.lift.slice(at)];
  return { line: out, index: at };
}

/**
 * The line of an arterial that ends on an interchange, cut back `distance`
 * metres from that end to the foot of its ramps. What is cut away has to lie
 * plainly on the ground and meet nothing on the way (`occupied`), since the
 * ramps take its place. Undefined where too little of the road is left.
 */
export function cutBack(line: DraftLine, atStart: boolean, distance: number, occupied: (p: Point) => boolean): DraftLine | undefined {
  const forward = atStart ? reversed(line) : line;
  const last = forward.points.length - 1;
  const total = curveDistances(forward.points)[last] as number;
  if (total - distance < 2 * footprintHalfWidth(forward.tier)) return undefined;
  const cut = withPointAlong(forward, total - distance);
  if (cut === undefined) return undefined;
  const end = cut.index;
  const full = cut.line;
  for (let s = end; s < full.points.length - 1; s++) if (!plain(full, s)) return undefined;
  for (let k = end + 1; k < full.points.length - 1; k++) if (occupied(full.points[k] as Point)) return undefined;
  const out = sliceLine(full, 0, end);
  return atStart ? reversed(out) : out;
}

/**
 * The line of an arterial that runs through an interchange with the point on
 * it taken out, so it crosses the highway instead of meeting it. Both segments
 * either side have to lie plainly on the ground. With `nudge`, the point is
 * moved there instead of taken out: a line straight through the interchange
 * crosses the highway exactly on one of its points, which is no crossing
 * inside either road, so the network would never see it.
 */
export function dropPoint(line: DraftLine, k: number, nudge?: Point): DraftLine | undefined {
  if (!plain(line, k - 1) || !plain(line, k)) return undefined;
  if (nudge !== undefined) return { ...line, points: line.points.map((p, i) => (i === k ? nudge : p)) };
  const shift = (segments: readonly number[]): number[] => segments.filter((s) => s !== k - 1 && s !== k).map((s) => (s > k ? s - 1 : s));
  const out: DraftLine = {
    ...line,
    points: [...line.points.slice(0, k), ...line.points.slice(k + 1)],
    bridges: shift(line.bridges),
    tunnels: shift(line.tunnels),
    interchanges: line.interchanges.filter((i) => i !== k).map((i) => (i > k ? i - 1 : i)),
  };
  if (line.slots !== undefined) out.slots = shift(line.slots);
  if (line.lift !== undefined) out.lift = [...line.lift.slice(0, k), ...line.lift.slice(k + 1)];
  return out;
}

/**
 * Where to move the point of an arterial on an interchange so the line
 * crosses the highway inside one of its segments: a little along the highway,
 * and a little on along the arterial, off the highway's line.
 */
export function nudgeOff(line: DraftLine, k: number, highway: RoadCurve, at: number): Point {
  const p = line.points[k] as Point;
  const next = highway.points[at + 1] as Point;
  const along = hypot(next.x - p.x, next.y - p.y);
  const ahead = line.points[k + 1] as Point;
  const onward = hypot(ahead.x - p.x, ahead.y - p.y);
  const step = Math.min(NUDGE, along / 2);
  return {
    x: p.x + ((next.x - p.x) / along) * step + ((ahead.x - p.x) / onward) * (NUDGE / 3),
    y: p.y + ((next.y - p.y) / along) * step + ((ahead.y - p.y) / onward) * (NUDGE / 3),
  };
}

/**
 * The feet of the overpass that carries a road over the highway near `over`:
 * the last point on the ground before the lifted run nearest that place, and
 * the first after it. Undefined where the road is not lifted there, or the run
 * reaches either end of the road.
 */
export function overpassFeet(line: DraftLine, over: Point): [number, number] | undefined {
  const lift = line.lift;
  if (lift === undefined) return undefined;
  let nearest = -1;
  let best = Infinity;
  for (let k = 0; k < line.points.length; k++) {
    const p = line.points[k] as Point;
    const d = hypot(p.x - over.x, p.y - over.y);
    if ((lift[k] ?? 0) > 0 && d < best) {
      best = d;
      nearest = k;
    }
  }
  if (nearest < 0) return undefined;
  let from = nearest;
  while (from > 0 && (lift[from] ?? 0) > 0) from--;
  let to = nearest;
  while (to < line.points.length - 1 && (lift[to] ?? 0) > 0) to++;
  if ((lift[from] ?? 0) > 0 || (lift[to] ?? 0) > 0) return undefined;
  return [from, to];
}

// ------------------------------------------------------------ the infield

/**
 * The ground inside each foot of a diamond: the off-ramp from its landing to
 * the foot, the on-ramp from the foot to its landing, and the highway back
 * between the two landings, one ring per foot. Nothing is built there
 * (`parcels.ts`): the ground between a ramp and the roads it links is left
 * open, as one piece, rather than cut into the slivers a block of that shape
 * would give.
 */
export function interchangeInfields(roads: readonly RoadCurve[]): Point[][] {
  const out: Point[][] = [];
  for (const exit of roads) {
    if (exit.ramp?.exit !== true) continue;
    const foot = exit.points[exit.points.length - 1] as Point;
    const entry = roads.find((r) => r.ramp?.exit === false && r.ramp.arterial === exit.ramp?.arterial && same(r.points[0] as Point, foot));
    if (entry === undefined) continue;
    const from = exit.points[0] as Point;
    const to = entry.points[entry.points.length - 1] as Point;
    const ring = [...exit.points, ...entry.points.slice(1)];
    const highway = roads[exit.ramp.highway] as RoadCurve;
    if (entry.ramp?.highway === highway.id) ring.push(...between(highway.points, to, from));
    out.push(ring);
  }
  return out;
}

/** True where two places are one point of the network. */
function same(a: Point, b: Point): boolean {
  return hypot(a.x - b.x, a.y - b.y) < 1e-6;
}

/** The points of a line strictly between two of its own points, in the order from `from` to `to`. */
function between(points: readonly Point[], from: Point, to: Point): Point[] {
  const i = points.findIndex((p) => same(p, from));
  const j = points.findIndex((p) => same(p, to));
  if (i < 0 || j < 0) return [];
  return i < j ? points.slice(i + 1, j) : points.slice(j + 1, i).reverse();
}

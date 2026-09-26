/**
 * How the crowd is put down on the pavements (spec sections 5.3, 13.1, 20.1).
 *
 * Each directed run of a road with a pavement gets people from its tier's
 * `walkers` and its district. Each person gets:
 *
 * - A loop of the road graph that starts on their own run (`walkOut`), so they
 *   stay a person of their district.
 * - A lane: metres right of the middle of the pavement, most of them on the
 *   right of the way they walk, so the two ways a pavement is walked pass.
 * - Sometimes company: a pair or a three who walk one loop side by side at one
 *   pace. The first of them owns the walk; the others keep beside them.
 * - Sometimes a habit of jaywalking: the loop leaves one pavement in the
 *   middle of a street, slants over the road, and comes back the same way a
 *   few legs later, so it still closes on the side it started.
 * - A plan (`pedestrian-walk.ts`): the pauses they make and the lights they
 *   wait at, timed to the signals from the tick their lap starts on.
 */
import { hashInts } from '../../core/hash.ts';
import { rngFor, Subsystem, type Rng } from '../../core/rng.ts';
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import { TIERS } from '../../world/roads/tiers.ts';
import type { District, Zone } from '../../world/types.ts';
import { signalCrossings } from './pedestrian-crossing.ts';
import { lookOf, strideOf, type PedestrianLook } from './pedestrian-look.ts';
import type { Pavements, WalkLeg, WalkRoute } from './pedestrian-route.ts';
import { planAt, planWalk, stopsOf, type PlanPoint, type WalkPlan } from './pedestrian-walk.ts';
import { SIGNAL_CYCLE, type TrafficSignals } from '../traffic/signals.ts';
import { backOf, walkOut } from '../traffic/traffic-tour.ts';

/** How busy each zone's pavements are, as a share of the tier's walkers. */
const ZONE_PEDESTRIANS: Record<Zone, number> = {
  core: 1,
  inner: 0.75,
  industrial: 0.25,
  suburban: 0.3,
  outskirts: 0.1,
  wilderness: 0.03,
};

/** Metres a walk covers before it turns back, so a person stays in their own few blocks. */
const WALK_REACH = 700;

/** Metres a loop of pavement has to be before a walk ends on it: once round a city block. */
const WALK_LOOP = 250;

/** How often a person walks with company, by zone: the chance they are the first of a pair or a three. */
const COMPANY: Record<Zone, number> = {
  core: 0.12,
  inner: 0.2,
  industrial: 0.08,
  suburban: 0.18,
  outskirts: 0.12,
  wilderness: 0.25,
};

/** How often a person jaywalks, by zone. */
const JAYWALK: Record<Zone, number> = {
  core: 0.1,
  inner: 0.14,
  industrial: 0.12,
  suburban: 0.05,
  outskirts: 0.04,
  wilderness: 0,
};

/** Metres between two people who walk side by side. */
const ABREAST = 0.62;

/** Metres of a person's lane from the edge of the pavement, at the least. */
const LANE_EDGE = 0.3;

/** Metres a run needs before anybody crosses it in the middle, and the least room past the cut. */
const JAY_MIN = 45;

/** The keys of the streams the crowd draws from, so none shifts another. */
const EDGE_STREAM = 1;
const PERSON_STREAM = 2;
const KERB_STREAM = 5;

/** One person of the crowd: how they look, and the walk they keep to. */
export interface AmbientPedestrian {
  id: number;
  look: PedestrianLook;
  zone: Zone;
  /** The side of the road the loop starts on: +1 right of the first edge's direction, -1 left. */
  side: number;
  /** The tick of the loop they stand at on tick 0. */
  phase: number;
  /** Ticks once round the loop. */
  period: number;
  /** Whole walk cycles once round the loop. */
  strides: number;
  route: WalkRoute;
  plan: WalkPlan;
  /** The person whose walk this one keeps to: their own id, or the first of their company. */
  lead: number;
  /** Metres right of the lead's lane this one walks: 0 for the lead. */
  beside: number;
  /** How many walk together, the lead included. */
  company: number;
  /** True for somebody whose loop crosses a road where there is no crossing. */
  bold: boolean;
}

/** What placing a crowd reads. */
export interface PlaceContext {
  seed: number;
  graph: RoadGraph;
  pavements: Pavements;
  signals?: TrafficSignals;
  file(id: number, edge: number): void;
}

/** Put the people of one directed run of road down, and lay out each one's walk. */
export function placeOnEdge(ctx: PlaceContext, edge: RoadEdge, district: Pick<District, 'zone' | 'density'>, people: AmbientPedestrian[]): void {
  const zone = district.zone;
  const busy = ZONE_PEDESTRIANS[zone] * (0.5 + 0.5 * district.density);
  const expected = (edge.length / 1000) * TIERS[edge.tier].walkers * busy;
  const rng = rngFor(ctx.seed, 0, Subsystem.Pedestrians, hashInts(EDGE_STREAM, edge.id));
  const count = Math.floor(expected + rng.float());
  let placed = 0;
  while (placed < count) {
    const id = people.length;
    const walk = rngFor(ctx.seed, 0, Subsystem.Pedestrians, hashInts(PERSON_STREAM, id));
    const look = lookOf(zone, walk);
    const side = walk.chance(0.5) ? 1 : -1;
    const company = companyOf(zone, walk);
    const edges = loopFrom(ctx.graph, edge.id, walk);
    const bold = company === 1 && walk.chance(JAYWALK[zone]);
    const legs = legsOf(ctx.graph, edges, side, bold ? walk : undefined);
    const shift = laneOf(ctx.graph, edges, company, walk);
    const route = ctx.pavements.route(legs, shift);
    const stops = stopsOf(ctx.graph, route, zone, walk);
    const crossings = ctx.signals === undefined ? [] : signalCrossings(ctx.pavements, ctx.graph, route, ctx.signals, kerbDepth(ctx.seed, id));
    const sync = walk.int(0, SIGNAL_CYCLE - 1);
    const plan = planWalk({ route, pace: look.speed, stride: strideOf(look.gait, look.height), crossings, stops, signals: ctx.signals, sync });
    const period = plan.period;
    const strides = Math.round(route.length / plan.stride);
    // Somewhere along the run they were placed on, which is the first leg of the loop.
    const along = ((placed + walk.range(0.2, 0.8)) / count) * (route.toCorner[0] as number);
    const phase = phaseAt(plan, along, sync, crossings.length > 0);
    const jaywalks = legs.some((leg) => leg.cut !== undefined);
    const lead = { id, look, zone, side, phase, period, strides, route, plan, company, bold: jaywalks };
    for (let k = 0; k < company; k++) people.push(memberOf(ctx, lead, k));
    placed += company;
  }
}

/** How many walk together, drawn from `walk`: one, or a company of two or three. */
function companyOf(zone: Zone, walk: Rng): number {
  if (!walk.chance(COMPANY[zone])) return 1;
  return walk.chance(0.3) ? 3 : 2;
}

/**
 * The `k`th member of the company `lead` heads, filed on every edge of their
 * loop. The lead is member 0; the rest look their own way but keep its pace.
 */
function memberOf(
  ctx: PlaceContext,
  lead: Omit<AmbientPedestrian, 'lead' | 'beside'>,
  k: number,
): AmbientPedestrian {
  const { id, look, zone } = lead;
  const member = k === 0 ? look : lookOf(zone, rngFor(ctx.seed, 0, Subsystem.Pedestrians, hashInts(PERSON_STREAM, id, k)));
  // Company walks at the pace of the first of them.
  const kept = k === 0 ? member : { ...member, gait: look.gait, speed: look.speed };
  const person: AmbientPedestrian = {
    id: id + k,
    look: kept,
    zone,
    side: lead.side,
    phase: lead.phase,
    period: lead.period,
    strides: lead.strides,
    route: lead.route,
    plan: lead.plan,
    lead: id,
    beside: -k * ABREAST,
    company: lead.company,
    bold: lead.bold,
  };
  for (const e of lead.route.edges) ctx.file(id + k, e);
  return person;
}

/**
 * How far back of the kerb a person waits for the light, as a share of
 * `KERB_SPREAD`. It is a stream of its own, so drawing it shifts nothing else.
 */
function kerbDepth(seed: number, id: number): number {
  return rngFor(seed, 0, Subsystem.Pedestrians, hashInts(KERB_STREAM, id)).float();
}

/**
 * The tick of a loop a person stands at on tick 0, near `along` metres into it.
 * A walk timed to the lights has to start its lap on the tick of the signal
 * cycle it was timed from, so its phase is one of the whole cycles its lap
 * holds, the one nearest the place asked for.
 */
function phaseAt(plan: WalkPlan, along: number, sync: number, timed: boolean): number {
  const want = tickAt(plan, along);
  if (!timed) return want % plan.period;
  const base = mod(-sync, SIGNAL_CYCLE);
  const k = Math.round((want - base) / SIGNAL_CYCLE);
  return mod(base + k * SIGNAL_CYCLE, plan.period);
}

/** The first tick of a plan at which the walk has come `along` metres. */
function tickAt(plan: WalkPlan, along: number): number {
  for (let i = 0; i < plan.kind.length; i++) {
    const from = plan.from[i] as number;
    const to = plan.to[i] as number;
    if (to < along) continue;
    const f = to > from ? (along - from) / (to - from) : 0;
    return (plan.start[i] as number) + Math.floor(Math.max(0, f) * (plan.ticks[i] as number));
  }
  return 0;
}

/**
 * The lane a walk keeps to: metres right of the middle of the pavement. A
 * person alone keeps right, mostly; a few wander left of the middle. Company
 * walks abreast leftwards from the lane of the first of them, so the lane
 * leaves room for all of them on the narrowest pavement of the loop.
 */
function laneOf(graph: RoadGraph, edges: readonly number[], company: number, rng: Rng): number {
  let narrowest = Infinity;
  for (const e of edges) narrowest = Math.min(narrowest, TIERS[(graph.edges[e] as RoadEdge).tier].pavement);
  const half = Math.max(0, narrowest / 2 - LANE_EDGE);
  if (company > 1) {
    const span = (company - 1) * ABREAST;
    return Math.max(-half + span, Math.min(half, rng.range(half * 0.5, half)));
  }
  return rng.chance(0.85) ? rng.range(0.15, 0.9) * half : rng.range(-0.5, 0.15) * half;
}

/**
 * The legs of a loop: every edge on one side of its road. A jaywalker's loop
 * leaves that side in the middle of one long run and comes back to it in the
 * middle of another, later in the loop, so it closes where it began.
 */
function legsOf(graph: RoadGraph, edges: readonly number[], side: number, rng?: Rng): WalkLeg[] {
  const legs: WalkLeg[] = edges.map((edge) => ({ edge, side }));
  if (rng === undefined) return legs;
  const long: number[] = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = graph.edges[edges[i] as number] as RoadEdge;
    if (edge.length >= JAY_MIN && !edge.bridge && (edge.tier === 'street' || edge.tier === 'arterial')) long.push(i);
  }
  if (long.length < 2) return legs;
  const a = long[rng.int(0, long.length - 2)] as number;
  const later = long.filter((i) => i > a);
  const b = later[rng.int(0, later.length - 1)] as number;
  const out: WalkLeg[] = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = graph.edges[edges[i] as number] as RoadEdge;
    const here = i > a && i <= b ? -side : side;
    if (i === a || i === b) {
      const cut = edge.length * rng.range(0.3, 0.6);
      out.push({ edge: edge.id, side: here, cut }, { edge: edge.id, side: -here });
    } else {
      out.push({ edge: edge.id, side: here });
    }
  }
  return out;
}

/**
 * The loop a person walks from the run they were placed on. The walk of the
 * traffic may close its loop some way off; a person walks out to that loop,
 * round it, and back the way they came, so the loop starts on their own run
 * and they stay a person of their district.
 */
function loopFrom(graph: RoadGraph, first: number, rng: Rng): number[] {
  const { route, loop } = walkOut(graph, first, rng, walkable, WALK_REACH, WALK_LOOP);
  if (loop === 0) return route;
  const out = loop < 0 ? route : route.slice(0, loop);
  return route.concat(backOf(graph, out));
}

/** True for a run people walk: a tier with a pavement, not bored through the ground. */
export function walkable(edge: RoadEdge): boolean {
  return TIERS[edge.tier].walkers > 0 && TIERS[edge.tier].pavement > 0 && !edge.tunnel;
}

/** The step and distance of a plan at a moment of its loop, which wraps. */
export function planPointAt(plan: WalkPlan, at: number, out: PlanPoint): PlanPoint {
  return planAt(plan, mod(at, plan.period), out);
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

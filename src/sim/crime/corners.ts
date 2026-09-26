/**
 * The corners of the city that are occupied rather than walked past (spec
 * section 20.1): a busker and the few who stop to listen, a food cart and its
 * queue, a market stall, the line outside a club, smokers outside a bar, a dog
 * walker waiting on their dog, somebody on a stoop.
 *
 * Which pavement gets which follows the district, the way `pedestrian-look.ts`
 * dresses a person by their zone, and each keeps its own hours: a club queue
 * forms after dark, a cart is out for lunch. Each spot is laid down once for a
 * world, and whether it is out on a tick is a function of the seed, the spot
 * and the day, so a replay finds the same busker on the same corner.
 *
 * Nothing is stepped. The people are drawn with the crowd, standing, through
 * the same door the stop queues use (`stop-queue.ts`); the cart, the stall,
 * the amp and the dog are drawn by `render/crime/corners.ts`.
 */
import { hashInts } from '../../core/hash.ts';
import { atan2, cos, sin } from '../../core/libm.ts';
import { rngFor, Subsystem, type Rng } from '../../core/rng.ts';
import type { RoadEdge } from '../../world/roads/graph.ts';
import { TIERS } from '../../world/roads/tiers.ts';
import type { Zone } from '../../world/types.ts';
import { TICKS_PER_DAY } from '../clock.ts';
import { lookOf, type Gait, type PedestrianLook } from '../crowd/pedestrian-look.ts';
import { walkable } from '../crowd/pedestrian-place.ts';
import { PAVEMENT_RISE, pavementOffset } from '../crowd/pedestrian-route.ts';
import { emptyPose, IDLE_TICKS, type DistrictAt } from '../crowd/pedestrians.ts';
import { RouteSampler, type RouteLegs, type RoutePoint } from '../traffic/route-sample.ts';
import type { WaitingCrowd, WaitingPassenger } from '../transit/stop-queue.ts';
import type { TrafficRoads } from '../traffic/traffic.ts';

/** What stands on a corner. */
type CornerKind = 'busker' | 'cart' | 'stall' | 'club' | 'smokers' | 'dog' | 'stoop';

/** The things drawn on a corner besides its people. */
export type CornerProp = 'amp' | 'cart' | 'stall' | 'dog';

/** How often a run of pavement has somebody on it, by zone, and which kinds, by weight. */
const ZONE_CORNERS: Record<Zone, { chance: number; kinds: Partial<Record<CornerKind, number>> }> = {
  core: { chance: 0.16, kinds: { busker: 3, cart: 3, club: 2, smokers: 3, stall: 1 } },
  inner: { chance: 0.2, kinds: { busker: 2, cart: 2, stall: 3, club: 2, smokers: 2, stoop: 2, dog: 1 } },
  industrial: { chance: 0.08, kinds: { cart: 3, smokers: 3 } },
  suburban: { chance: 0.1, kinds: { dog: 4, stoop: 3, stall: 1 } },
  outskirts: { chance: 0.05, kinds: { stall: 2, dog: 2, stoop: 1 } },
  wilderness: { chance: 0, kinds: {} },
};

/** The hours each kind is out, from and to, which may run past midnight. */
const HOURS: Record<CornerKind, readonly [number, number]> = {
  busker: [10, 21],
  cart: [7, 22],
  stall: [8, 18],
  club: [22, 3],
  smokers: [12, 2],
  dog: [6, 21],
  stoop: [10, 20],
};

/** The chance a spot is out on a day it could be. */
const OUT_CHANCE = 0.75;

/** Metres into a run a spot stands, and the least run that has room for one. */
const SPOT_IN = 9;
const SPOT_RUN = 30;

/** Metres a busker is heard from. */
export const BUSKER_REACH = 40;

const SPOT_STREAM = 1;
const PERSON_STREAM = 2;
const DAY_STREAM = 3;

/** One person of a corner, placed in the frame of the spot: along the road, and out from it. */
interface CornerPerson {
  look: PedestrianLook;
  along: number;
  out: number;
  /** Radians from the way the spot faces, which is the road. */
  turn: number;
  gait: Gait;
  phase: number;
}

/** One occupied spot. */
export interface CornerSpot {
  id: number;
  kind: CornerKind;
  x: number;
  y: number;
  height: number;
  /** The way the spot faces: at the road. */
  heading: number;
  people: readonly CornerPerson[];
  prop?: { kind: CornerProp; along: number; out: number; turn: number };
}

/** A prop of a corner, placed on the map. */
export interface PlacedProp {
  kind: CornerProp;
  x: number;
  y: number;
  height: number;
  heading: number;
}

export class StreetCorners implements WaitingCrowd {
  readonly spots: readonly CornerSpot[];
  private readonly seed: number;

  constructor(seed: number, roads: TrafficRoads, districtAt?: DistrictAt) {
    this.seed = seed;
    const graph = roads.graph;
    const sampler = new RouteSampler(roads.roads, graph, roads.heightAt, roads.tiltAt);
    const point: RoutePoint = { x: 0, y: 0, height: 0, tiltX: 0, tiltY: 0, rightX: 0, rightY: 0, edge: graph.edges[0] as RoadEdge };
    const spots: CornerSpot[] = [];
    for (const edge of graph.edges) {
      if (!walkable(edge) || edge.bridge || edge.length < SPOT_RUN) continue;
      const rng = rngFor(seed, 0, Subsystem.Corners, hashInts(SPOT_STREAM, edge.id));
      const leg: RouteLegs = { edges: Int32Array.of(edge.id), startDistance: Float64Array.of(0), length: edge.length };
      const at = sampler.sample(leg, SPOT_IN, point);
      // Against the building line, a little short of it, facing the road.
      const out = pavementOffset(edge) + TIERS[edge.tier].pavement / 2 - 0.45;
      const x = at.x + at.rightX * out;
      const y = at.y + at.rightY * out;
      const zone = districtAt?.(x, y).zone ?? 'core';
      const dress = ZONE_CORNERS[zone];
      if (!rng.chance(dress.chance)) continue;
      const kind = pick(dress.kinds, rng);
      if (kind === undefined) continue;
      const heading = atan2(-at.rightY, -at.rightX);
      spots.push(spotOf(seed, spots.length, kind, zone, x, y, at.height + PAVEMENT_RISE, heading, rng));
    }
    this.spots = spots;
  }

  /** True when a spot is out at a tick: inside its hours, on a day it is out at all. */
  isOut(spot: CornerSpot, tick: number): boolean {
    const [from, to] = HOURS[spot.kind];
    const inDay = ((tick % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
    const hour = (inDay / TICKS_PER_DAY) * 24;
    const open = from < to ? hour >= from && hour < to : hour >= from || hour < to;
    if (!open) return false;
    // A spot that runs past midnight counts its night as the day it started on.
    const day = Math.floor((tick - (from > to && hour < to ? TICKS_PER_DAY : 0)) / TICKS_PER_DAY);
    return (hashInts(DAY_STREAM, this.seed, spot.id, day) >>> 0) / 0x1_0000_0000 < OUT_CHANCE;
  }

  /** The people of every spot out inside a box on a tick, written into `out` from 0. */
  passengers(minX: number, minY: number, maxX: number, maxY: number, tick: number, out: WaitingPassenger[]): number {
    let count = 0;
    const whole = Math.floor(tick);
    for (const spot of this.spots) {
      if (spot.x < minX - 4 || spot.x > maxX + 4 || spot.y < minY - 4 || spot.y > maxY + 4) continue;
      if (!this.isOut(spot, whole)) continue;
      for (const person of spot.people) {
        const entry = out[count] ?? { pose: emptyPose(), look: person.look };
        const pose = entry.pose;
        place(spot, person.along, person.out, pose);
        pose.heading = spot.heading + person.turn;
        pose.speed = 0;
        const cycles = tick / IDLE_TICKS + person.phase;
        pose.cycle = cycles - Math.floor(cycles);
        pose.gait = person.gait;
        pose.from = person.gait;
        pose.fromCycle = pose.cycle;
        pose.blend = 0;
        pose.look = 0;
        pose.hidden = false;
        entry.look = person.look;
        out[count++] = entry;
      }
    }
    return count;
  }

  /** The props of every spot out inside a box on a tick. */
  props(minX: number, minY: number, maxX: number, maxY: number, tick: number, out: PlacedProp[]): number {
    let count = 0;
    for (const spot of this.spots) {
      const prop = spot.prop;
      if (prop === undefined) continue;
      if (spot.x < minX || spot.x > maxX || spot.y < minY || spot.y > maxY) continue;
      if (!this.isOut(spot, Math.floor(tick))) continue;
      const entry = out[count] ?? { kind: prop.kind, x: 0, y: 0, height: 0, heading: 0 };
      const at = scratch;
      place(spot, prop.along, prop.out, at);
      entry.kind = prop.kind;
      entry.x = at.x;
      entry.y = at.y;
      entry.height = spot.height;
      entry.heading = spot.heading + prop.turn;
      out[count++] = entry;
    }
    out.length = count;
    return count;
  }

  /** The buskers playing within {@link BUSKER_REACH} of a place on a tick, as the spots they stand at. */
  buskers(x: number, y: number, tick: number, out: CornerSpot[]): CornerSpot[] {
    out.length = 0;
    for (const spot of this.spots) {
      if (spot.kind !== 'busker') continue;
      if (Math.abs(spot.x - x) > BUSKER_REACH || Math.abs(spot.y - y) > BUSKER_REACH) continue;
      if (this.isOut(spot, Math.floor(tick))) out.push(spot);
    }
    return out;
  }
}

const scratch = { x: 0, y: 0, height: 0 };

/** A point of a spot's frame on the map: `along` the road the way the spot's right runs, `out` towards the road. */
function place(spot: CornerSpot, along: number, out: number, at: { x: number; y: number; height: number }): void {
  const c = cos(spot.heading);
  const s = sin(spot.heading);
  // The spot faces the road, so the road's own direction is a quarter turn to its right.
  at.x = spot.x + c * out - s * along;
  at.y = spot.y + s * out + c * along;
  at.height = spot.height;
}

/** Add one person to the spot being laid out: where they stand, which way they turn, what they do. */
type AddPerson = (along: number, out: number, turn: number, gait: Gait) => void;

/** The prop of a spot, if it has one. */
type SpotProp = CornerSpot['prop'];

/** Lay out the people and the prop of one spot. */
function spotOf(seed: number, id: number, kind: CornerKind, zone: Zone, x: number, y: number, height: number, heading: number, rng: Rng): CornerSpot {
  const people: CornerPerson[] = [];
  const person: AddPerson = (along, out, turn, gait) => {
    const look = lookOf(zone, rngFor(seed, 0, Subsystem.Corners, hashInts(PERSON_STREAM, id, people.length)));
    people.push({ look, along, out, turn, gait, phase: rng.float() });
  };
  const prop = LAYOUTS[kind](person, rng);
  return { id, kind, x, y, height, heading, people, ...(prop === undefined ? {} : { prop }) };
}

/** A gait to idle in: standing, on the phone, smoking, talking or arms folded. */
function idleGait(rng: Rng): Gait {
  return (['stand', 'phone', 'smoke', 'talk', 'fold'] as const)[rng.int(0, 4)] as Gait;
}

/** What a listener to a busker does: films, folds their arms or stands. */
function listenerGait(rng: Rng): Gait {
  if (rng.chance(0.3)) return 'film';
  return rng.chance(0.5) ? 'fold' : 'stand';
}

/** How each kind of spot lays out its people, and the prop it answers. */
const LAYOUTS: Record<CornerKind, (person: AddPerson, rng: Rng) => SpotProp> = {
  busker(person, rng) {
    person(0, 0, 0, 'busk');
    const prop: SpotProp = { kind: 'amp', along: 0.55, out: -0.1, turn: 0 };
    // The ones who have stopped to listen, in a loose ring towards the road, facing the busker.
    const listeners = rng.int(0, 3);
    for (let k = 0; k < listeners; k++) {
      const along = (k % 2 === 0 ? 1 : -1) * rng.range(0.9, 1.8);
      const out = rng.range(1.2, 2);
      person(along, out, Math.PI + atan2(along, out) + rng.range(-0.2, 0.2), listenerGait(rng));
    }
    return prop;
  },
  cart(person, rng) {
    const prop: SpotProp = { kind: 'cart', along: 0, out: 0.9, turn: 0 };
    person(0, 0.05, 0, 'stand');
    const queue = rng.int(1, 3);
    for (let k = 0; k < queue; k++) person(-0.3 + k * 0.7, 2 + k * 0.15, Math.PI + rng.range(-0.3, 0.3), k === 0 ? 'stand' : idleGait(rng));
    return prop;
  },
  stall(person, rng) {
    const prop: SpotProp = { kind: 'stall', along: 0, out: 0.8, turn: 0 };
    person(0.2, 0.05, 0, 'fold');
    if (rng.chance(0.7)) person(rng.range(-0.8, 0.8), 1.7, Math.PI, 'window');
    return prop;
  },
  club(person, rng) {
    // A line along the wall, all facing the door at its head.
    const line = rng.int(3, 6);
    for (let k = 0; k < line; k++) person(k * 0.75, 0.15, Math.PI / 2 + rng.range(-0.3, 0.3), idleGait(rng));
    return undefined;
  },
  smokers(person, rng) {
    const two = rng.int(2, 3);
    for (let k = 0; k < two; k++) person(k * 0.8 - 0.4, 0.2 + rng.range(0, 0.4), (k % 2 === 0 ? 1 : -1) * rng.range(0.6, 1.2), rng.chance(0.7) ? 'smoke' : 'talk');
    return undefined;
  },
  dog(person, rng) {
    person(0, 1.1, Math.PI / 2, rng.chance(0.5) ? 'phone' : 'stand');
    return { kind: 'dog', along: 0.9, out: 1.2, turn: Math.PI / 2 + rng.range(-0.8, 0.8) };
  },
  stoop(person, rng) {
    person(0, 0, 0, 'fold');
    if (rng.chance(0.5)) person(0.8, 0.1, -0.6, 'talk');
    return undefined;
  },
};

function pick(weights: Partial<Record<CornerKind, number>>, rng: Rng): CornerKind | undefined {
  const kinds: CornerKind[] = ['busker', 'cart', 'stall', 'club', 'smokers', 'dog', 'stoop'];
  let total = 0;
  for (const kind of kinds) total += weights[kind] ?? 0;
  if (total <= 0) return undefined;
  let at = rng.float() * total;
  for (const kind of kinds) {
    at -= weights[kind] ?? 0;
    if (at < 0) return kind;
  }
  return undefined;
}

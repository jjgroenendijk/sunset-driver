/**
 * The animals of the city (spec section 20.4): the gulls over the shore, the
 * pigeons on the pavement, the crabs on the sand, the cats and the rats in the
 * alleys, and the deer and the hawks out past the last street.
 *
 * Wildlife is a pure function of `(seed, tick)` and holds no record at all.
 * Every animal is placed once for a world on an anchor — a stretch of shore, a
 * run of pavement, an alley, a wilderness track — and works a small patch
 * around it for ever. {@link AmbientWildlife.poseAt} evaluates one at any
 * moment, whole tick or between two, so a replay puts the same gull over the
 * same wave.
 *
 * Each species is about at its own hours ({@link SpeciesSpec.from} and
 * {@link SpeciesSpec.to}): rats come out after dark and are gone by morning,
 * crabs work the sand in daylight. An animal off its hours is simply not
 * drawn, which costs nothing to place and nothing to skip.
 *
 * Nothing here startles onto the record the way the crowd does
 * (`pedestrians.ts`). A shy animal gives way to whoever is nearest as a
 * function of how close they are ({@link AmbientWildlife.poseAt} takes the
 * place to give way from), so a flock parts as the player walks into it and
 * closes again behind them without a byte being written down.
 */
import { hashInts } from '../core/hash.ts';
import { rngFor, Subsystem } from '../core/rng.ts';
import type { RoadEdge } from '../world/graph.ts';
import { TIERS } from '../world/tiers.ts';
import type { Beach, Point, RoadCurve, Zone } from '../world/types.ts';
import { TICKS_PER_HOUR, TICK_RATE } from './clock.ts';
import { EdgeIndex } from './edge-index.ts';
import type { DistrictAt } from './pedestrians.ts';
import type { TrafficRoads } from './traffic.ts';

/** What lives in the city (spec section 20.4). */
export type Species = 'seagull' | 'pigeon' | 'crab' | 'cat' | 'rat' | 'deer' | 'hawk';

/** The ground a species is placed on. */
export type Habitat =
  /** The waterline of a beach, and the air over it. */
  | 'shore'
  /** The sand between the waterline and the dunes. */
  | 'sand'
  /** A run of pavement in the built-up city. */
  | 'pavement'
  /** An alley, or a back street of the industrial ring. */
  | 'alley'
  /** A track out past the last street. */
  | 'wild';

/** What one species is: where it lives, when it is about, and how it moves. */
export interface SpeciesSpec {
  habitat: Habitat;
  /** First hour of the day it is about, and the first hour it is not. It wraps past midnight. */
  from: number;
  to: number;
  /** Metres it moves above the ground. Zero for one that walks. */
  fly: number;
  /** Metres per second it moves at. */
  speed: number;
  /** Metres across the patch one works around its anchor. */
  patch: number;
  /** How many of them share one anchor. */
  flock: number;
  /** Anchors per kilometre of the habitat, before the zone thins them. */
  perKm: number;
  /** Metres it gives way over when somebody walks into its patch. Zero for one that ignores them. */
  shy: number;
  /** Metres it rises when it gives way, so a flock of pigeons takes off rather than sidling. */
  lift: number;
  /** Wing beats or strides a second, which is what moves the model. */
  beat: number;
}

/**
 * Every species and the numbers that make it. Adding an animal is a row here
 * and a colour in `src/render/wildlife.ts`; nothing else branches on a species.
 */
export const SPECIES: Readonly<Record<Species, SpeciesSpec>> = Object.freeze({
  // Over the waterline all day, and thickest where the sand is.
  seagull: { habitat: 'shore', from: 5, to: 21, fly: 7, speed: 8, patch: 22, flock: 5, perKm: 7, shy: 14, lift: 9, beat: 3.4 },
  // The pavement birds of the built-up city, which take off together.
  pigeon: { habitat: 'pavement', from: 6, to: 20, fly: 0, speed: 1.1, patch: 3.5, flock: 6, perKm: 3.5, shy: 7, lift: 6, beat: 5 },
  crab: { habitat: 'sand', from: 6, to: 22, fly: 0, speed: 0.5, patch: 2.5, flock: 3, perKm: 6, shy: 3, lift: 0, beat: 4 },
  cat: { habitat: 'alley', from: 17, to: 7, fly: 0, speed: 1.6, patch: 6, flock: 1, perKm: 2, shy: 9, lift: 0, beat: 2.2 },
  // Out only after dark, and gone before the first shift.
  rat: { habitat: 'alley', from: 21, to: 5, fly: 0, speed: 1.9, patch: 3, flock: 4, perKm: 3.5, shy: 5, lift: 0, beat: 6 },
  deer: { habitat: 'wild', from: 4, to: 10, fly: 0, speed: 2.4, patch: 25, flock: 3, perKm: 1.4, shy: 40, lift: 0, beat: 1.8 },
  hawk: { habitat: 'wild', from: 7, to: 19, fly: 26, speed: 11, patch: 55, flock: 1, perKm: 0.8, shy: 0, lift: 0, beat: 1.1 },
});

/** The species in a fixed order, so nothing here ever iterates an object. */
export const SPECIES_ORDER: readonly Species[] = Object.freeze([
  'seagull',
  'pigeon',
  'crab',
  'cat',
  'rat',
  'deer',
  'hawk',
]);

/** How much of a habitat's wildlife each zone carries. */
export const ZONE_WILDLIFE: Record<Zone, number> = {
  core: 1,
  inner: 1,
  industrial: 0.8,
  suburban: 0.5,
  outskirts: 0.6,
  wilderness: 1,
};

/** Metres each way of one bucket of the index that says which animals can be near a place. */
export const WILDLIFE_CELL = 100;

/** Metres an anchor is thrown off the point it was placed at. */
const ANCHOR_JITTER = 8;

/**
 * The most an animal stands off its anchor, as a share of its patch: the
 * circle it works, plus the wander laid over it on each axis.
 */
const WANDER_REACH = 1 + 0.3 * Math.SQRT2;

/** Metres the widest-ranging animal may stand off the point it was placed at. */
export function wildlifeReach(): number {
  let reach = 0;
  for (const species of SPECIES_ORDER) {
    const spec = SPECIES[species];
    reach = Math.max(reach, ANCHOR_JITTER + spec.patch * (0.4 + WANDER_REACH));
  }
  return reach;
}

/** Metres of shore between one anchor and the next, before {@link SpeciesSpec.perKm} thins them. */
const SHORE_STEP = 25;

/** The keys of the streams the placing draws from, so no two shift each other. */
const ANCHOR_STREAM = 1;
const ANIMAL_STREAM = 2;

/** Ticks each way of a moment a pose is read at, so an animal turns rather than snaps round. */
const HALF_STEP = 0.25;

/** One animal: the patch it works, and the loop it works it on. */
export interface Animal {
  id: number;
  species: Species;
  /** The middle of its patch. */
  x: number;
  y: number;
  /** The ground its patch lies on. */
  height: number;
  /** Metres from the anchor it circles at. */
  radius: number;
  /** Ticks once round the patch. */
  period: number;
  /** The tick of that loop it stands at on tick 0. */
  phase: number;
  /** +1 round the patch one way, -1 the other. */
  turn: number;
  /** The phase of the wander laid over the circle, which is what keeps it from being a circle. */
  wander: number;
}

/** An animal placed on the map. `y` is the map's; `height` is up. */
export interface WildlifePose {
  species: Species;
  x: number;
  y: number;
  height: number;
  heading: number;
  /** Metres per second along the heading. */
  speed: number;
  /** How far through the wing beat or the stride it is, 0 to 1. */
  cycle: number;
  /** How far it has given way to whoever is near, 0 to 1. The renderer reads it as alarm. */
  startled: number;
}

/** True while a species is about at a tick. */
export function activeAt(species: Species, tick: number): boolean {
  const spec = SPECIES[species];
  const hour = Math.floor(tick / TICKS_PER_HOUR) % 24;
  return spec.from <= spec.to ? hour >= spec.from && hour < spec.to : hour >= spec.from || hour < spec.to;
}

/** What the wildlife needs of a world: the roads it lives along and the beaches it lives on. */
export interface WildlifeWorld {
  roads: TrafficRoads;
  beaches: readonly Beach[];
  /** Sea level, which is the ground the sand and the waterline lie at. */
  seaLevel: number;
  districtAt?: DistrictAt;
}

/**
 * The animals of one world. Built once and read for ever: it holds no state of
 * a session, so two sessions of a seed share one and a save changes nothing.
 */
export class AmbientWildlife {
  readonly animals: readonly Animal[];
  private readonly index: EdgeIndex;
  /** The cells of the index, for the animals placed off the road graph. */
  private readonly loose: Map<number, number[]> = new Map();
  /** Where the road half of a query is answered into, so a query allocates nothing. */
  private readonly scratch: number[] = [];

  constructor(seed: number, world: WildlifeWorld) {
    const animals: Animal[] = [];
    const roads = world.roads;
    // An animal works a patch around its anchor, so the index has to reach as
    // far off a road as the widest-ranging one of them ever stands.
    this.index = new EdgeIndex(roads.roads, roads.graph, wildlifeReach(), WILDLIFE_CELL);
    for (const edge of roads.graph.edges) {
      if (edge.twin !== -1 && edge.twin < edge.id) continue;
      const at = midpoint(roads.roads, edge);
      const district = world.districtAt?.(at.x, at.y) ?? { zone: 'core', density: 1 };
      const height = roads.heightAt(edge.curve, Math.min(edge.start, edge.end), 0, at.x, at.y);
      for (const species of SPECIES_ORDER) {
        if (!livesOn(species, edge, district.zone)) continue;
        const along = edge.length / 1000;
        const count = draw(seed, species, edge.id, along * SPECIES[species].perKm * ZONE_WILDLIFE[district.zone]);
        this.placeRun(seed, species, count, roads.roads, edge, height, animals, edge.id);
      }
    }
    for (const beach of world.beaches) this.placeBeach(seed, beach, world.seaLevel, animals);
    this.animals = animals;
  }

  /** The ids of every animal whose patch reaches into a box, ascending and without repeats. */
  near(minX: number, minY: number, maxX: number, maxY: number, out: number[] = []): number[] {
    out.length = 0;
    for (const id of this.index.near(minX, minY, maxX, maxY, this.scratch)) out.push(id);
    const loX = Math.floor(minX / WILDLIFE_CELL);
    const loY = Math.floor(minY / WILDLIFE_CELL);
    const hiX = Math.floor(maxX / WILDLIFE_CELL);
    const hiY = Math.floor(maxY / WILDLIFE_CELL);
    for (let cx = loX; cx <= hiX; cx++) {
      for (let cy = loY; cy <= hiY; cy++) {
        const cell = this.loose.get(hashInts(cx, cy));
        if (cell === undefined) continue;
        for (const id of cell) out.push(id);
      }
    }
    out.sort((a, b) => a - b);
    let kept = 0;
    for (let i = 0; i < out.length; i++) {
      if (i > 0 && out[i] === out[i - 1]) continue;
      out[kept++] = out[i] as number;
    }
    out.length = kept;
    return out;
  }

  /**
   * Where an animal is at a moment, which may fall between two ticks. `watch`
   * is the place it gives way from — where the player stands — or undefined
   * where nobody is near enough to matter.
   */
  poseAt(id: number, time: number, out: WildlifePose, watch?: Point): WildlifePose {
    const animal = this.animals[id] as Animal;
    const spec = SPECIES[animal.species];
    const behindX = this.atX(animal, time - HALF_STEP);
    const behindY = this.atY(animal, time - HALF_STEP);
    const aheadX = this.atX(animal, time + HALF_STEP);
    const aheadY = this.atY(animal, time + HALF_STEP);
    out.species = animal.species;
    out.x = (behindX + aheadX) / 2;
    out.y = (behindY + aheadY) / 2;
    out.heading = Math.atan2(aheadY - behindY, aheadX - behindX);
    out.speed = (Math.hypot(aheadX - behindX, aheadY - behindY) * TICK_RATE) / (2 * HALF_STEP);
    const cycles = (time / TICK_RATE) * spec.beat;
    out.cycle = cycles - Math.floor(cycles);
    out.startled = 0;
    out.height = animal.height + spec.fly;
    if (watch !== undefined) giveWay(out, animal, spec, watch);
    return out;
  }

  /** The middle of an animal's patch, which is what a far-off caller skips it by. */
  anchorOf(id: number): Animal {
    return this.animals[id] as Animal;
  }

  private atX(animal: Animal, time: number): number {
    const theta = this.theta(animal, time);
    return animal.x + animal.radius * (Math.cos(theta) + 0.3 * Math.cos(2 * theta + animal.wander));
  }

  private atY(animal: Animal, time: number): number {
    const theta = this.theta(animal, time);
    return animal.y + animal.radius * (Math.sin(theta) - 0.3 * Math.sin(3 * theta + animal.wander));
  }

  private theta(animal: Animal, time: number): number {
    return (2 * Math.PI * animal.turn * (time + animal.phase)) / animal.period;
  }

  /** Put the animals of one species down along one run of road. */
  private placeRun(
    seed: number,
    species: Species,
    anchors: number,
    roads: readonly RoadCurve[],
    edge: RoadEdge,
    height: number,
    animals: Animal[],
    file: number,
  ): void {
    const points = (roads[edge.curve] as RoadCurve).points;
    const lo = Math.min(edge.start, edge.end);
    const hi = Math.max(edge.start, edge.end);
    for (let i = 0; i < anchors; i++) {
      const at = points[Math.min(hi, lo + Math.floor(((i + 0.5) / anchors) * (hi - lo)))] as Point;
      const rng = rngFor(seed, 0, Subsystem.Wildlife, hashInts(ANCHOR_STREAM, file, i, SPECIES_ORDER.indexOf(species)));
      const x = at.x + rng.range(-ANCHOR_JITTER, ANCHOR_JITTER);
      const y = at.y + rng.range(-ANCHOR_JITTER, ANCHOR_JITTER);
      this.flock(seed, species, x, y, height, animals, (id) => this.index.file(id, edge.id));
    }
  }

  /** Put the gulls and the crabs of one beach down along its waterline. */
  private placeBeach(seed: number, beach: Beach, seaLevel: number, animals: Animal[]): void {
    const shore = beach.shore;
    if (shore.length < 2) return;
    const anchors = Math.max(1, Math.floor(beach.length / SHORE_STEP));
    for (const species of SPECIES_ORDER) {
      const spec = SPECIES[species];
      if (spec.habitat !== 'shore' && spec.habitat !== 'sand') continue;
      const count = draw(seed, species, beach.id, (beach.length / 1000) * spec.perKm);
      for (let i = 0; i < count; i++) {
        const rng = rngFor(seed, 0, Subsystem.Wildlife, hashInts(ANCHOR_STREAM, beach.id, i, SPECIES_ORDER.indexOf(species)));
        const at = shore[Math.min(shore.length - 1, Math.floor(((i + 0.5) / count) * anchors * (shore.length / anchors)))] as Point;
        const inland = spec.habitat === 'sand' ? nearest(beach.back, at) : at;
        const x = (at.x + inland.x) / 2 + rng.range(-ANCHOR_JITTER, ANCHOR_JITTER);
        const y = (at.y + inland.y) / 2 + rng.range(-ANCHOR_JITTER, ANCHOR_JITTER);
        const reach = spec.patch * (0.4 + WANDER_REACH);
        this.flock(seed, species, x, y, seaLevel, animals, (id) => this.fileLoose(id, x, y, reach));
      }
    }
  }

  /** Put one anchor's worth of a species down, and file each of them where it will be looked for. */
  private flock(seed: number, species: Species, x: number, y: number, height: number, animals: Animal[], file: (id: number) => void): void {
    const spec = SPECIES[species];
    for (let j = 0; j < spec.flock; j++) {
      const id = animals.length;
      const rng = rngFor(seed, 0, Subsystem.Wildlife, hashInts(ANIMAL_STREAM, id));
      const radius = spec.patch * rng.range(0.25, 1);
      const period = Math.max(1, Math.round(((2 * Math.PI * radius) / spec.speed) * TICK_RATE));
      animals.push({
        id,
        species,
        x: x + rng.range(-spec.patch, spec.patch) * 0.4,
        y: y + rng.range(-spec.patch, spec.patch) * 0.4,
        height,
        radius,
        period,
        phase: rng.int(0, period - 1),
        turn: rng.chance(0.5) ? 1 : -1,
        wander: rng.range(0, 2 * Math.PI),
      });
      file(id);
    }
  }

  /**
   * File an animal placed off the road graph into every loose cell its patch
   * reaches, so a box on the far side of a cell edge still finds it.
   */
  private fileLoose(id: number, x: number, y: number, reach: number): void {
    const loX = Math.floor((x - reach) / WILDLIFE_CELL);
    const loY = Math.floor((y - reach) / WILDLIFE_CELL);
    const hiX = Math.floor((x + reach) / WILDLIFE_CELL);
    const hiY = Math.floor((y + reach) / WILDLIFE_CELL);
    for (let cx = loX; cx <= hiX; cx++) {
      for (let cy = loY; cy <= hiY; cy++) {
        const key = hashInts(cx, cy);
        const cell = this.loose.get(key);
        if (cell === undefined) this.loose.set(key, [id]);
        else if (cell[cell.length - 1] !== id) cell.push(id);
      }
    }
  }
}

/**
 * Move an animal out of the way of whoever has walked into its patch. It is a
 * function of how close they are and nothing else, so the flock parts as they
 * come and closes again as they go.
 */
function giveWay(pose: WildlifePose, animal: Animal, spec: SpeciesSpec, watch: Point): void {
  if (spec.shy <= 0) return;
  const dx = pose.x - watch.x;
  const dy = pose.y - watch.y;
  const distance = Math.hypot(dx, dy);
  if (distance >= spec.shy) return;
  const alarm = 1 - distance / spec.shy;
  const away = distance < 1e-3 ? animal.wander : Math.atan2(dy, dx);
  pose.x += Math.cos(away) * alarm * spec.shy;
  pose.y += Math.sin(away) * alarm * spec.shy;
  pose.height += alarm * spec.lift;
  pose.heading = away;
  pose.speed += alarm * spec.speed * 2;
  pose.startled = alarm;
}

/** True where a species lives along a run of road in a zone. */
function livesOn(species: Species, edge: RoadEdge, zone: Zone): boolean {
  if (edge.tunnel) return false;
  const habitat = SPECIES[species].habitat;
  if (habitat === 'pavement') return TIERS[edge.tier].pavement > 0 && (zone === 'core' || zone === 'inner');
  if (habitat === 'alley') return edge.tier === 'alley' || (edge.tier === 'street' && zone === 'industrial');
  if (habitat === 'wild') return zone === 'wilderness' && edge.tier !== 'highway';
  return false;
}

/** How many anchors an expected count comes out as: the whole part, and the rest as a chance. */
function draw(seed: number, species: Species, key: number, expected: number): number {
  if (expected <= 0) return 0;
  const rng = rngFor(seed, 0, Subsystem.Wildlife, hashInts(ANCHOR_STREAM, key, SPECIES_ORDER.indexOf(species)));
  return Math.floor(expected + rng.float());
}

/** The point of a line nearest another, which is how sand is found behind a waterline. */
function nearest(line: readonly Point[], at: Point): Point {
  let best = at;
  let far = Infinity;
  for (const point of line) {
    const d = (point.x - at.x) ** 2 + (point.y - at.y) ** 2;
    if (d < far) {
      far = d;
      best = point;
    }
  }
  return best;
}

function midpoint(roads: readonly RoadCurve[], edge: RoadEdge): Point {
  const points = (roads[edge.curve] as RoadCurve).points;
  return points[(edge.start + edge.end) >> 1] as Point;
}

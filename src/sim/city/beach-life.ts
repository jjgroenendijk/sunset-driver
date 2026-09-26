/**
 * The life on the beaches of spec section 20.1: sunbathers on towels,
 * swimmers, volleyball games, surfers when the swell is up, a lifeguard in
 * each tower, ice-cream and cocktail stands, bonfires and parties after dark,
 * and joggers and skaters along the dune line beside the boardwalk.
 *
 * Each spot is laid down once for a world along the waterline, the way
 * `sim/crime/corners.ts` lays spots along the pavements. Who is out on a tick
 * is read from the seed, the tick and the weather alone (`beach-hours.ts`),
 * so nothing is stepped and nothing is on the record.
 *
 * The people are drawn with the crowd through the `WaitingCrowd` door the stop
 * queues use; the towels, the towers, the stands, the nets, the fires and the
 * boards are drawn by `render/environment/beach.ts`.
 */
import { hashInts } from '../../core/hash.ts';
import { atan2, cos, sin } from '../../core/libm.ts';
import { rngFor, Subsystem, type Rng } from '../../core/rng.ts';
import type { Beach, Point, Zone } from '../../world/types.ts';
import { TICK_RATE } from '../clock.ts';
import { lookOf, type Gait, type PedestrianLook } from '../crowd/pedestrian-look.ts';
import { emptyPose, IDLE_TICKS, type DistrictAt } from '../crowd/pedestrians.ts';
import type { WaitingCrowd, WaitingPassenger } from '../transit/stop-queue.ts';
import { fillAt, personOut, spotOnDay, weatherShare, type BeachKind } from './beach-hours.ts';
import { layOut, type LaidPerson, type LaidProp, type SpotKind } from './beach-layouts.ts';
import { BeachPath } from './beach-path.ts';
import { CLEAR_WEATHER, type Weather } from './weather.ts';

export type { BeachKind } from './beach-hours.ts';
export type { BeachProp } from './beach-layouts.ts';

/** Metres round a pier's root kept clear, so nobody lies under the deck. */
const PIER_CLEAR = 24;

/** Samples between two lifeguard towers, and between two stands. */
const TOWER_EVERY = 15;
const STAND_EVERY = 20;

/** The chance of each kind at a sample with no fixture, by weight; the rest stays empty sand. */
const SPOT_ODDS: readonly (readonly [SpotKind, number])[] = [
  ['towels', 0.42],
  ['swimmers', 0.14],
  ['volleyball', 0.05],
  ['surfers', 0.08],
  ['bonfire', 0.06],
  ['party', 0.02],
];

/** How far back from the waterline towards the dune line each kind stands, as a share of the sand. */
const DEPTH: Partial<Record<BeachKind, readonly [number, number]>> = {
  towels: [0.2, 0.75],
  volleyball: [0.45, 0.6],
  lifeguard: [0.35, 0.45],
  icecream: [0.82, 0.88],
  cocktail: [0.82, 0.88],
  bonfire: [0.4, 0.65],
  party: [0.45, 0.6],
};

/** Runners along the dune line per kilometre of beach, of each kind. */
const RUNNERS_PER_KM: Partial<Record<BeachKind, number>> = { joggers: 8, skaters: 5 };

/** The pace of a jogger and of a skater, metres per second, slowest and fastest. */
const RUNNER_PACE: Partial<Record<BeachKind, readonly [number, number]>> = { joggers: [2.3, 2.9], skaters: [3.8, 5] };

/** Metres of one stride a jogger takes, and of one push a skater makes. */
const RUNNER_STRIDE: Partial<Record<BeachKind, number>> = { joggers: 2.1, skaters: 6 };

/** Metres a spot's people may stand from it, which is how far outside a box a spot is still read. */
const SPOT_REACH = 30;

const SPOT_STREAM = 1;
const PERSON_STREAM = 2;
const RUNNER_STREAM = 3;

/** One person of a spot, on the map. */
interface SpotPerson {
  look: PedestrianLook;
  x: number;
  y: number;
  height: number;
  heading: number;
  gait: Gait;
  phase: number;
}

/** A prop of a spot, on the map, and whose it is: always there, there with anybody, or one person's. */
export interface PlacedBeachProp {
  kind: LaidProp['kind'];
  x: number;
  y: number;
  height: number;
  heading: number;
  owner: LaidProp['owner'];
}

/** One spot on a beach. */
export interface BeachSpot {
  id: number;
  kind: BeachKind;
  x: number;
  y: number;
  people: readonly SpotPerson[];
  props: readonly PlacedBeachProp[];
}

/** A jogger or a skater, going to and fro along the dune line of one beach. */
interface Runner {
  id: number;
  kind: BeachKind;
  path: BeachPath;
  look: PedestrianLook;
  /** Metres into the to-and-fro at tick 0, and metres a second. */
  start: number;
  pace: number;
}

/** What the beach needs of a world. */
export interface BeachWorld {
  beaches: readonly Beach[];
  seaLevel: number;
  heightAt: (x: number, y: number) => number;
  districtAt?: DistrictAt;
}

export class BeachLife implements WaitingCrowd {
  readonly spots: readonly BeachSpot[];
  readonly runners: readonly Runner[];
  /** The weather the beach is read in. Whoever draws the frame sets it every frame. */
  weather: Weather = CLEAR_WEATHER;
  private readonly seed: number;

  constructor(seed: number, world: BeachWorld) {
    this.seed = seed;
    const spots: BeachSpot[] = [];
    const runners: Runner[] = [];
    for (const beach of world.beaches) {
      if (beach.shore.length < 2 || beach.back.length !== beach.shore.length) continue;
      const zone = world.districtAt?.(beach.shore[0]?.x ?? 0, beach.shore[0]?.y ?? 0).zone ?? 'suburban';
      layBeach(seed, beach, world, zone, spots);
      layRunners(seed, beach, world, zone, runners);
    }
    this.spots = spots;
    this.runners = runners;
  }

  /** How many people are out on every beach at a tick, in the weather set. */
  countOut(tick: number): number {
    return this.passengers(-Infinity, -Infinity, Infinity, Infinity, tick, []);
  }

  /** The people on the beaches inside a box on a tick, written into `out` from 0. */
  passengers(minX: number, minY: number, maxX: number, maxY: number, tick: number, out: WaitingPassenger[]): number {
    let count = 0;
    for (const spot of this.spots) {
      if (spot.x < minX - SPOT_REACH || spot.x > maxX + SPOT_REACH || spot.y < minY - SPOT_REACH || spot.y > maxY + SPOT_REACH) continue;
      const { level, day } = this.levelOf(spot.kind, tick);
      if (level <= 0 || !spotOnDay(this.seed, spot.kind, spot.id, day)) continue;
      for (let k = 0; k < spot.people.length; k++) {
        const person = spot.people[k] as SpotPerson;
        if (person.x < minX || person.x > maxX || person.y < minY || person.y > maxY) continue;
        if (!personOut(this.seed, spot.id, k, day, level)) continue;
        const entry = out[count] ?? { pose: emptyPose(), look: person.look };
        const pose = entry.pose;
        pose.x = person.x;
        pose.y = person.y;
        pose.height = person.height;
        pose.heading = person.heading;
        pose.speed = 0;
        const cycles = tick / IDLE_TICKS + person.phase;
        standIn(pose, person.gait, cycles - Math.floor(cycles));
        entry.look = person.look;
        out[count++] = entry;
      }
    }
    for (const runner of this.runners) count = this.runner(runner, minX, minY, maxX, maxY, tick, out, count);
    return count;
  }

  /** The props of every spot inside a box on a tick, those out and those that always stand. */
  props(minX: number, minY: number, maxX: number, maxY: number, tick: number, out: PlacedBeachProp[]): number {
    let count = 0;
    for (const spot of this.spots) {
      if (spot.x < minX - SPOT_REACH || spot.x > maxX + SPOT_REACH || spot.y < minY - SPOT_REACH || spot.y > maxY + SPOT_REACH) continue;
      const { level, day } = this.levelOf(spot.kind, tick);
      const on = level > 0 && spotOnDay(this.seed, spot.kind, spot.id, day);
      const anyone = on && spot.people.some((_, k) => personOut(this.seed, spot.id, k, day, level));
      for (const prop of spot.props) {
        const owner = prop.owner;
        const shown = owner === 'always' || (owner === 'anyone' ? anyone : on && personOut(this.seed, spot.id, owner, day, level));
        if (!shown || prop.x < minX || prop.x > maxX || prop.y < minY || prop.y > maxY) continue;
        out[count++] = prop;
      }
    }
    out.length = count;
    return count;
  }

  /** How many of a kind the hour and the weather let out, and the day its hours began on. */
  private levelOf(kind: BeachKind, tick: number): { level: number; day: number } {
    const { fill, day } = fillAt(kind, Math.floor(tick));
    return { level: fill * weatherShare(kind, this.weather), day };
  }

  /** Write one runner if they are out and inside the box. Returns the count after them. */
  private runner(runner: Runner, minX: number, minY: number, maxX: number, maxY: number, tick: number, out: WaitingPassenger[], count: number): number {
    const { level, day } = this.levelOf(runner.kind, tick);
    if (!personOut(this.seed, runner.id, 0, day, level)) return count;
    const entry = out[count] ?? { pose: emptyPose(), look: runner.look };
    const pose = entry.pose;
    const metres = runner.start + (runner.pace * tick) / TICK_RATE;
    runner.path.pace(metres, pose);
    if (pose.x < minX || pose.x > maxX || pose.y < minY || pose.y > maxY) return count;
    pose.speed = runner.pace;
    const stride = RUNNER_STRIDE[runner.kind] ?? 2;
    standIn(pose, runner.kind === 'skaters' ? 'surf' : 'jog', (metres / stride) % 1);
    entry.look = runner.look;
    out[count] = entry;
    return count + 1;
  }
}

/** Set a pose's gait and cycle with no blend. */
function standIn(pose: WaitingPassenger['pose'], gait: Gait, cycle: number): void {
  pose.cycle = cycle;
  pose.gait = gait;
  pose.from = gait;
  pose.fromCycle = cycle;
  pose.blend = 0;
  pose.look = 0;
  pose.hidden = false;
}

/**
 * Lay the spots of one beach along its waterline. The waterline is sampled
 * every `SHORE_STEP` metres (`world/terrain/beaches.ts`), and each sample
 * but the two ends is tried for one spot.
 */
function layBeach(seed: number, beach: Beach, world: BeachWorld, zone: Zone, spots: BeachSpot[]): void {
  const n = beach.shore.length;
  for (let i = 1; i < n - 1; i++) {
    const shore = beach.shore[i] as Point;
    const pier = beach.pier?.root;
    if (pier !== undefined && Math.abs(pier.x - shore.x) < PIER_CLEAR && Math.abs(pier.y - shore.y) < PIER_CLEAR) continue;
    const rng = rngFor(seed, 0, Subsystem.Beach, hashInts(SPOT_STREAM, beach.id, i));
    const kind = kindAt(i, rng);
    if (kind === undefined) continue;
    const back = beach.back[i] as Point;
    // The frame of the spot faces the sea: `out` runs from the dune line to the water.
    const heading = atan2(shore.y - back.y, shore.x - back.x);
    const [near, far] = DEPTH[kind] ?? [0, 0];
    const depth = rng.range(near, far);
    const x = shore.x + (back.x - shore.x) * depth;
    const y = shore.y + (back.y - shore.y) * depth;
    spots.push(spotOf(seed, spots.length, kind, zone, x, y, heading, world, rng));
  }
}

/** The kind of spot at a sample: a fixture at its spacing, else a draw against {@link SPOT_ODDS}. */
function kindAt(i: number, rng: Rng): SpotKind | undefined {
  if (i % TOWER_EVERY === 7) return 'lifeguard';
  if (i % STAND_EVERY === 12) return (i / STAND_EVERY) % 2 < 1 ? 'icecream' : 'cocktail';
  let roll = rng.float();
  for (const [kind, odds] of SPOT_ODDS) {
    roll -= odds;
    if (roll < 0) return kind;
  }
  return undefined;
}

/** Lay out one spot and put its people and props on the map. */
function spotOf(seed: number, id: number, kind: SpotKind, zone: Zone, x: number, y: number, heading: number, world: BeachWorld, rng: Rng): BeachSpot {
  const laid = layOut(kind, rng);
  const c = cos(heading);
  const s = sin(heading);
  const onMap = (at: LaidPerson | LaidProp): { x: number; y: number; height: number; heading: number } => {
    const px = x + c * at.out - s * at.along;
    const py = y + s * at.out + c * at.along;
    const ground = at.sea === undefined ? world.heightAt(px, py) : world.seaLevel + at.sea;
    return { x: px, y: py, height: ground + (at.up ?? 0), heading: heading + at.turn };
  };
  const people = laid.people.map((person, k) => ({
    ...onMap(person),
    look: lookOf(zone, rngFor(seed, 0, Subsystem.Beach, hashInts(PERSON_STREAM, id, k))),
    gait: person.gait,
    phase: rng.float(),
  }));
  const props = laid.props.map((prop) => ({ ...onMap(prop), kind: prop.kind, owner: prop.owner }));
  return { id, kind, x, y, people, props };
}

/** Put the joggers and the skaters of one beach on the path along its dune line. */
function layRunners(seed: number, beach: Beach, world: BeachWorld, zone: Zone, runners: Runner[]): void {
  const path = BeachPath.along(beach, world.heightAt);
  if (path === undefined) return;
  for (const kind of ['joggers', 'skaters'] as const) {
    const count = Math.round((beach.length / 1000) * (RUNNERS_PER_KM[kind] ?? 0));
    const [slow, fast] = RUNNER_PACE[kind] ?? [2, 3];
    for (let k = 0; k < count; k++) {
      // Ids clear of every spot's, so a runner's daily draw is a stream of its own.
      const id = hashInts(RUNNER_STREAM, beach.id, kind === 'joggers' ? 0 : 1, k);
      const rng = rngFor(seed, 0, Subsystem.Beach, id);
      runners.push({ id, kind, path, look: lookOf(zone, rng), start: rng.float() * path.length * 2, pace: rng.range(slow, fast) });
    }
  }
}

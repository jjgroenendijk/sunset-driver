/**
 * Count the cars and people of the city that stand stuck round the player.
 *
 * Builds the city of a seed the way `sim-profile.ts` does. At a few places it
 * stands the player's car in the middle of the street, gets the player out and
 * steps the simulation. After each tick it reads who giving way
 * (`give-way.ts`) held and why. A car held for `--long` seconds in a row is a
 * stuck episode, filed by the root of what it waits for: the end of the chain
 * of cars that each wait for the next.
 *
 * It also counts the cars that got past the parked car, and the promoted cars
 * left standing at the end: a car that drove into the parked one is promoted,
 * and nobody drives it again.
 *
 * Usage: node scripts/traffic-stuck.ts [seed] [--option=value]
 *   --ticks   ticks stepped at each place. Default 7200, two minutes.
 *   --places  how many places round the map. Default 4.
 *   --mode    walk (the player stands by their car), or drive. Default walk.
 *   --long    seconds a car is held in a row before it counts as stuck. Default 10.
 *   --dump    print the chain of the first stuck episodes.
 *   --promo   print every car promoted, with its hold.
 *   --nopark  leave the player's car far off, for how the same streets run without it.
 */
import { seedFromString } from '../src/core/rng.ts';
import { buildCity } from '../src/city.ts';
import { TICKS_PER_HOUR } from '../src/sim/clock.ts';
import { EMPTY_INPUT, type InputFrame } from '../src/sim/input.ts';
import { initPhysics, SimPhysics } from '../src/sim/physics/physics.ts';
import { createSimState, stepSim, type SimState } from '../src/sim/simulation.ts';
import { heldPose } from '../src/sim/traffic/hold.ts';
import type { AmbientPose } from '../src/sim/traffic/traffic.ts';
import { buildCarve } from '../src/world/carve/carve.ts';
import { buildRoadGraph } from '../src/world/roads/graph.ts';
import { buildJunctions } from '../src/world/junctions/junctions.ts';
import { nearestRoadPlace } from '../src/world/terrain/surface.ts';
import { generateWorld } from '../src/world/world.ts';

const args = process.argv.slice(2);
const options = new Map<string, string>(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const eq = a.indexOf('=');
      return eq === -1 ? [a.slice(2), 'true'] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);
const num = (name: string, fallback: number): number => Number(options.get(name) ?? fallback);
const seedText = args.find((a) => !a.startsWith('--')) ?? 'sunset';
const seed = seedFromString(seedText);
const ticks = num('ticks', 7200);
const places = num('places', 4);
const long = num('long', 10) * 60;
const mode = options.get('mode') ?? 'walk';
const dumping = options.has('dump');

/** Metres from the parked car a car of the traffic counts as passing it. */
const PASS_REACH = 25;

const description = generateWorld(seed);
const carve = buildCarve(description.terrain, description.roads, buildJunctions(description.roads, buildRoadGraph(description.roads)));
const city = buildCity(seed, description, carve);
const traffic = city.ground.traffic;
if (traffic === undefined) throw new Error(`seed ${seedText} has no traffic`);
await initPhysics();

/** What this reads of a car giving way decided about, from its private list. */
interface CarRead {
  id: number;
  stop: boolean;
  blocker: number;
  waited: number;
  waiting: boolean;
  lag: number;
  person: number;
  box: { x: number; y: number; heading: number };
}
interface PersonRead {
  id: number;
  by: number;
  held: boolean;
  walking: boolean;
  lag: number;
  waited: number;
  x: number;
  y: number;
}
interface GiveWayRead {
  cars: CarRead[];
  people: PersonRead[];
}
const KINDS: Record<number, string> = { [-2]: 'player, wreck or unit', [-3]: 'person', [-4]: 'light (lagged)' };

/** What a car that moves stands for at the end of a chain: a queue at a light, or a car on the move. */
function movingRoot(car: CarRead): string {
  return car.waiting ? 'queue at a light' : 'car that moves';
}

/** The root of the chain of cars a stopped car waits for, as a kind. */
function rootOf(cars: readonly CarRead[], i: number): string {
  if (!(cars[i] as CarRead).stop) return 'free';
  let at = i;
  for (let hop = 0; hop < 64; hop++) {
    const car = cars[at] as CarRead;
    if (!car.stop) return movingRoot(car);
    if (car.blocker < 0) return (hop === 0 ? '' : 'queue behind ') + (KINDS[car.blocker] ?? `kind ${car.blocker}`);
    at = car.blocker;
    if (at === i) return 'ring';
  }
  return 'long chain';
}

/** The lines of a person at the end of a chain, and of the car they stand for. */
function personLines(way: GiveWayRead, car: CarRead): string[] {
  const q = way.people[car.person];
  if (q === undefined) return [];
  const { x, y, heading } = car.box;
  const dx = q.x - x;
  const dy = q.y - y;
  const ahead = dx * Math.cos(heading) + dy * Math.sin(heading);
  const right = -dx * Math.sin(heading) + dy * Math.cos(heading);
  const lines = [`person ${q.id} walking ${q.walking} lag ${q.lag} held ${q.held} by ${q.by} ahead ${ahead.toFixed(2)} right ${right.toFixed(2)}`];
  const by = way.cars[q.by];
  if (by !== undefined) lines.push(`  who waits for car ${by.id} stop ${by.stop} by ${by.blocker} (${by.box.x.toFixed(1)}, ${by.box.y.toFixed(1)})`);
  return lines;
}

let dumped = 0;
/** Print the chain a stuck car waits along, down to the person at its end. */
function dump(way: GiveWayRead, state: SimState, c: number): void {
  const lines: string[] = [];
  let at = c;
  for (let hop = 0; hop < 20; hop++) {
    const car = way.cars[at];
    if (car === undefined) break;
    const { x, y, heading } = car.box;
    lines.push(`car ${car.id} (${x.toFixed(1)}, ${y.toFixed(1)}) facing ${heading.toFixed(2)} by ${car.blocker} lag ${car.lag}`);
    if (!car.stop || car.blocker === c) break;
    if (car.blocker === -3) lines.push(...personLines(way, car));
    if (car.blocker < 0) break;
    at = car.blocker;
  }
  console.log(`tick ${state.tick}:\n  ${lines.join('\n  ')}`);
}

const totals = new Map<string, number>();
const tally = (root: string): void => {
  totals.set(root, (totals.get(root) ?? 0) + 1);
};
let episodes = 0;
let carTicks = 0;
let heldTicks = 0;
let personTicks = 0;
let personHeldTicks = 0;
let worstLag = 0;
let promoted = 0;
const passed: number[] = [];
const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
const extent = description.size / 8;
for (let p = 0; p < places; p++) {
  const angle = (p / places) * 2 * Math.PI;
  const r = p === 0 ? 0 : extent;
  const state = createSimState(seed, undefined, Math.round(8 * TICKS_PER_HOUR));
  const physics = new SimPhysics(city.ground, state);
  const start = nearestRoadPlace(description, r * Math.cos(angle), r * Math.sin(angle)) ?? { x: 0, y: 0, heading: 0 };
  physics.spawn(state, start.x, start.y, start.heading);
  if (mode === 'walk') physics.alight(state);
  const park = { x: state.vehicle.x, y: state.vehicle.z };
  if (options.has('nopark')) {
    state.vehicle.x = 1e5;
    state.vehicle.z = 1e5;
    physics.adopt(state);
  }
  // The private parts of the physics are plain properties once the types are stripped.
  const way = (physics as unknown as { giveWay: GiveWayRead }).giveWay;
  // A car the player's car was spawned on is promoted on the first tick: that is the spawn, not the traffic.
  let spawned = -1;
  const runs = new Map<number, { ticks: number; root: string }>();
  const past = new Set<number>();
  const input = (tick: number): InputFrame =>
    mode === 'drive' ? { ...EMPTY_INPUT, throttle: 0.6, steer: 0.35 * Math.sin(tick / 150) } : EMPTY_INPUT;
  for (let i = 0; i < ticks; i++) {
    const before = state.traffic.promoted.length;
    const holds = state.traffic.held.list.map((h) => ({ ...h }));
    stepSim(state, input(state.tick), physics);
    if (spawned < 0) spawned = state.traffic.promoted.length;
    if (options.has('promo') && state.traffic.promoted.length > before) {
      for (const record of state.traffic.promoted) {
        const hold = holds.find((h) => h.id === record.id);
        const v = record.vehicle;
        const car = { x: state.vehicle.x, y: state.vehicle.z };
        console.log(`promoted ${record.id} at tick ${state.tick}: (${v.x.toFixed(1)}, ${v.z.toFixed(1)}) speed ${v.speed.toFixed(1)}; player car (${car.x.toFixed(1)}, ${car.y.toFixed(1)}), player (${state.player.x.toFixed(1)}, ${state.player.y.toFixed(1)}) driving ${state.player.driving}; hold ${JSON.stringify(hold)}`);
      }
    }
    if (i % 30 === 0) {
      for (const id of traffic.near(park.x - PASS_REACH, park.y - PASS_REACH, park.x + PASS_REACH, park.y + PASS_REACH, [])) {
        if (state.traffic.promoted.some((record) => record.id === id)) continue;
        heldPose(traffic, state.traffic.held, id, state.tick, pose);
        if (Math.hypot(pose.x - park.x, pose.y - park.y) < PASS_REACH) past.add(id);
      }
    }
    const seen = new Set<number>();
    for (let c = 0; c < way.cars.length; c++) {
      const car = way.cars[c] as CarRead;
      carTicks++;
      seen.add(car.id);
      const run = runs.get(car.id);
      if (!car.stop) {
        if (run !== undefined && run.ticks >= long) {
          episodes++;
          tally(run.root);
        }
        runs.delete(car.id);
        continue;
      }
      heldTicks++;
      if (run === undefined) runs.set(car.id, { ticks: 1, root: rootOf(way.cars, c) });
      else if (++run.ticks === long) {
        run.root = rootOf(way.cars, c);
        if (dumping && dumped++ < 12) dump(way, state, c);
      }
    }
    for (const id of [...runs.keys()]) if (!seen.has(id)) runs.delete(id);
    for (const hold of state.traffic.held.list) worstLag = Math.max(worstLag, hold.lag);
    personTicks += way.people.length;
    personHeldTicks += state.pedestrians.held.list.filter((h) => h.step > 0).length;
  }
  for (const run of runs.values()) {
    if (run.ticks < long) continue;
    episodes++;
    tally(`${run.root} (still)`);
  }
  promoted += state.traffic.promoted.length - spawned;
  passed.push(past.size);
  physics.dispose();
}
const share = (part: number, whole: number): string => ((100 * part) / Math.max(whole, 1)).toFixed(1);
console.log(`seed ${seedText}, ${mode}, ${places} places x ${ticks} ticks`);
console.log(`cars held ${share(heldTicks, carTicks)}% of car-ticks; worst lag ${(worstLag / 60).toFixed(0)} s`);
console.log(`people held ${share(personHeldTicks, personTicks)}% of person-ticks`);
console.log(`cars promoted after the first tick: ${promoted}; cars within ${PASS_REACH} m of the parked car, by place: ${passed.join(', ')}`);
console.log(`${episodes} stuck episodes of ${long / 60} s or more, by root:`);
for (const [root, n] of [...totals].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${root}`);

/**
 * Time the simulation step of a real city, in Node, with no browser and no GPU.
 *
 * `render-profile.ts` times the frame the renderer draws and runs no
 * simulation. This runs the other half of a frame: `stepSim` over the city a
 * session builds (`city.ts`) — the Rapier world, the traffic, the crowd, the
 * police and the services — for as many ticks as asked, and says what a tick
 * cost and which part of it the time went to. It runs anywhere Node does, a
 * cloud container included, so a change to `src/sim` is measured where it is
 * made.
 *
 * Each part is timed by wrapping the one method the physics steps it through,
 * from here: `src/sim` may read no clock (CLAUDE.md), and this reads it from
 * outside. A tick is 1/60 s, so a tick over 16.7 ms is a frame the simulation
 * alone makes late; the budget it is held to in play is far below that, since
 * the frame has to be drawn too.
 *
 * The shops, the contacts, the turf and the street crime are dealt from the
 * chunk workers in a session and are not built here; their rules still run.
 *
 * Usage: node scripts/sim-profile.ts [seed] [--option=value]
 *   --ticks        ticks timed. Default 3600, a minute of play.
 *   --warm         ticks run first and not timed. Default 300.
 *   --mode         drive, or walk. Default drive: the player drives in slow
 *                  curves from the nearest road to the origin.
 *   --x, --y       where to start, in metres. Default the origin.
 *   --heat         hold the heat at this many stars, 0 to 6, so the police
 *                  chase all the way. Default 0.
 *   --hour         the hour of the day to start at. Default 8.
 *   --cpuprofile   profile the timed ticks and list where the time went, by
 *                  area, by file and by function. --cpuprofile=sim.cpuprofile
 *                  also writes the profile, for Chrome DevTools.
 *   --json=<file>  write every tick's times, for `profile-compare.ts`.
 */
import { Session as Inspector } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
import { seedFromString } from '../src/core/rng.ts';
import { buildCity } from '../src/city.ts';
import { TICKS_PER_HOUR } from '../src/sim/clock.ts';
import { EMPTY_INPUT, type InputFrame } from '../src/sim/input.ts';
import { initPhysics, SimPhysics } from '../src/sim/physics.ts';
import { createSimState, stepSim } from '../src/sim/simulation.ts';
import { buildCarve } from '../src/world/carve.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { buildJunctions } from '../src/world/junctions.ts';
import { nearestRoadPlace } from '../src/world/surface.ts';
import { generateWorld } from '../src/world/world.ts';
import { printProfile, saveProfile, summariseProfile, type CpuProfile, type CpuSummary } from './cpu-profile.ts';
import { percentile, saveRun } from './profile-run.ts';

const args = process.argv.slice(2);
const options = new Map<string, string>(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const eq = a.indexOf('=');
      return eq === -1 ? [a.slice(2), 'true'] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);
function num(name: string, fallback: number): number {
  const raw = options.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} wants a number, not ${raw}`);
  return value;
}
const seedText = args.find((a) => !a.startsWith('--')) ?? 'sunset';
const seed = seedFromString(seedText);
const ticks = num('ticks', 3600);
const warm = num('warm', 300);
const heat = num('heat', 0);
const mode = options.get('mode') ?? 'drive';
if (mode !== 'drive' && mode !== 'walk') throw new Error(`--mode is drive or walk, not ${mode}`);

let t = performance.now();
const description = generateWorld(seed);
const carve = buildCarve(description.terrain, description.roads, buildJunctions(description.roads, buildRoadGraph(description.roads)));
const city = buildCity(seed, description, carve);
await initPhysics();
const state = createSimState(seed, undefined, Math.round(num('hour', 8) * TICKS_PER_HOUR));
const physics = new SimPhysics(city.ground, state);
const start = nearestRoadPlace(description, num('x', 0), num('y', 0)) ?? { x: 0, y: 0, heading: 0 };
physics.spawn(state, start.x, start.y, start.heading);
if (mode === 'walk') physics.alight(state);
console.log(`seed ${seedText}: world and city built in ${((performance.now() - t) / 1000).toFixed(1)} s`);

/** The milliseconds each part took on the tick being timed, by part. */
const spent = new Map<string, number>();
/** The parts, in the order they are listed. */
const parts: string[] = [];

/**
 * Time every call of one method of an object under a part's name. The method
 * is replaced on the object itself, so nothing else that shares its class is
 * touched. An object the city does not have, such as the police on a ground
 * with no roads, is passed over.
 */
function time(part: string, object: unknown, method: string): void {
  const target = object as Record<string, unknown> | undefined;
  const original = target?.[method];
  if (target === undefined || typeof original !== 'function') return;
  if (!parts.includes(part)) parts.push(part);
  target[method] = function (this: unknown, ...rest: unknown[]): unknown {
    const began = performance.now();
    try {
      return original.apply(this, rest);
    } finally {
      spent.set(part, (spent.get(part) ?? 0) + performance.now() - began);
    }
  };
}

// The private parts of the physics are plain properties once the types are stripped.
const inner = physics as unknown as Record<string, unknown>;
time('ground tiles', inner.bodies, 'cover');
time('give way', inner.giveWay, 'step');
time('traffic', inner.traffic, 'lead');
time('traffic', inner.traffic, 'settle');
time('rapier world step', inner.world, 'step');
time('read back', physics, 'read');
time('police', city.ground.police, 'step');
time('enforcers', city.ground.enforcers, 'step');
time('police bodies', inner.units, 'settle');
time('weapons', inner.shots, 'step');
time('weapons', inner.shots, 'fly');
time('emergency', city.ground.emergency, 'step');
time('ragdolls', inner.ragdolls, 'step');
// Timed last, so the parts above it are already wrapped inside it.
time('physics step', physics, 'step');

/** The input of a tick: slow curves at a steady throttle, or a walk that turns the same way. */
function inputAt(tick: number): InputFrame {
  const steer = 0.35 * Math.sin(tick / 150);
  return { ...EMPTY_INPUT, throttle: mode === 'drive' ? 0.8 : 1, steer, sprint: mode === 'walk' };
}

const run = (count: number, record?: (tick: number, total: number) => void): void => {
  for (let i = 0; i < count; i++) {
    if (heat > 0) state.heat = heat;
    spent.clear();
    const began = performance.now();
    stepSim(state, inputAt(state.tick), physics);
    record?.(i, performance.now() - began);
  }
};

t = performance.now();
run(warm);
const inspector = options.has('cpuprofile') ? new Inspector() : undefined;
if (inspector !== undefined) {
  inspector.connect();
  await inspector.post('Profiler.enable');
  await inspector.post('Profiler.setSamplingInterval', { interval: 200 });
  await inspector.post('Profiler.start');
}
const series = new Map<string, number[]>([['tick', []]]);
for (const part of parts) series.set(part, []);
series.set('rest of physics step', []);
series.set('rest of stepSim', []);
run(ticks, (_i, total) => {
  series.get('tick')?.push(total);
  for (const part of parts) series.get(part)?.push(spent.get(part) ?? 0);
  const step = spent.get('physics step') ?? 0;
  const inside = parts.filter((p) => p !== 'physics step').reduce((sum, p) => sum + (spent.get(p) ?? 0), 0);
  series.get('rest of physics step')?.push(Math.max(0, step - inside));
  series.get('rest of stepSim')?.push(Math.max(0, total - step));
});
let cpu: CpuSummary | undefined;
if (inspector !== undefined) {
  const { profile } = (await inspector.post('Profiler.stop')) as unknown as { profile: CpuProfile };
  inspector.disconnect();
  cpu = summariseProfile(profile);
  printProfile(`${ticks} ticks`, cpu);
  saveProfile(profile, options.get('cpuprofile'));
}
const seconds = (performance.now() - t) / 1000;

const where = state.player.driving ? state.vehicle : { x: state.player.x, z: state.player.y };
console.log(
  `${warm} ticks to warm, ${ticks} timed, in ${seconds.toFixed(1)} s; ${mode}, ended at ` +
    `(${where.x.toFixed(0)}, ${where.z.toFixed(0)}) with ` +
    `${state.police.units.length} police units, ${state.pedestrians.casualties.length} casualties, heat ${state.heat.toFixed(1)}`,
);
const ms = (value: number): string => value.toFixed(3).padStart(8);
console.log(`  mean      p50      p95      max ms per tick`);
for (const [name, values] of series) {
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
  const cells = [percentile(values, 0.5), percentile(values, 0.95), percentile(values, 1)].map(ms).join(' ');
  console.log(`${ms(mean)} ${cells}  ${name}`);
}
const over = (series.get('tick') ?? []).filter((v) => v > 1000 / 60).length;
console.log(`${over} ticks over 16.7 ms`);

const json = options.get('json');
if (json !== undefined) {
  saveRun(json, {
    tool: 'sim-profile',
    label: args.filter((a) => !a.startsWith('--json')).join(' ') || seedText,
    series: Object.fromEntries(series),
    ...(cpu === undefined ? {} : { cpu: { areas: cpu.areas, files: cpu.files } }),
  });
}
physics.dispose();

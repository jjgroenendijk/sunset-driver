/**
 * Measure how long the tram's tail stands in a junction on the green across
 * it (issue #652): a tram halted at the light of a run shorter than itself.
 *
 * Usage: node scripts/tram-tail.ts [seed...]. Default: sunset.
 */
import { seedFromString } from '../src/core/rng.ts';
import { AmbientTraffic, trafficRoadsOf } from '../src/sim/traffic/traffic.ts';
import { TRAM_LENGTH, TramLine } from '../src/sim/transit/tram.ts';
import { tailAcross } from '../src/sim/transit/tram-timing.ts';
import { generateWorld } from '../src/world/world.ts';

const seeds = process.argv.slice(2);
for (const text of seeds.length > 0 ? seeds : ['sunset']) {
  const seed = /^\d+$/.test(text) ? Number(text) : seedFromString(text);
  const world = generateWorld(seed);
  const roads = trafficRoadsOf(world);
  const traffic = new AmbientTraffic(seed, roads);
  const line = new TramLine(seed, roads, world.tram, world.districts, traffic.signals);
  if (line.tour === undefined || traffic.signals === undefined) {
    console.log(`${text}: no tram`);
    continue;
  }
  const across = tailAcross(line.tour, traffic.signals, TRAM_LENGTH);
  const share = across / line.tour.period;
  console.log(`${text}: lap ${(line.tour.period / 60).toFixed(0)} s, tail across ${(across / 60).toFixed(0)} s, share ${share.toFixed(3)}`);
}

/**
 * Fail when the browser builds a different world than Node does.
 *
 * The world is a pure function of its seed, so the city a chunk worker builds
 * in the page must be the city `npm run verify` and the previews build in
 * Node. Nothing checked that until issue #243: `Math.cos` rounded one bit
 * differently in the two engines, the road tracer took a different step, and
 * the page drew grass where Node had buildings. Every test passed, because
 * every test ran on one side.
 *
 * This runs `worldDigest` on both sides and compares the lines. The digest is
 * built in the order generation is, so the first line that differs names the
 * stage that went its own way.
 *
 * Usage: node scripts/world-check.ts [seed...]     (default: two fixed seeds)
 *
 * The browser comes from Playwright, as the render previews' does. It needs no
 * WebGPU device: nothing here draws.
 */
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser } from 'playwright-core';
import { seedFromString } from '../src/core/rng.ts';
import { generateWorld } from '../src/world/world.ts';
import { worldDigest } from '../src/world/digest.ts';
import { chromiumPath } from './chromium.ts';

/** Seeds to compare when none are named. One island city and one of the mainland archetypes. */
const DEFAULT_SEEDS = ['sunset', '1'];

/** How long the page may take to build one world. */
const TIMEOUT_MS = 300_000;

const seeds = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const texts = seeds.length > 0 ? seeds : DEFAULT_SEEDS;

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let failures = 0;
try {
  server = await createServer({ server: { port: 0 }, logLevel: 'warn' });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error('Vite started without a local address.');

  const executable = chromiumPath();
  browser = await chromium.launch({ executablePath: executable });
  // Which browser ran this is part of the result, not a detail. A machine
  // holding an older build than the lockfile names answers for that build, and
  // engines differ from each other as well as from Node: a pass here says the
  // two agree in *this* browser. `docs/dev-tooling.md` says how to point it at
  // another one.
  console.log(`browser ${browser.version()} (${executable})`);
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(new URL('scripts/world-check.html', url).href, { timeout: TIMEOUT_MS });
  await page.waitForFunction('window.worldCheckReady === true', undefined, { timeout: TIMEOUT_MS });

  for (const text of texts) {
    const seed = seedFromString(text);
    const here = worldDigest(generateWorld(seed));
    const there = await page.evaluate<string[], number>(
      // @ts-expect-error the page attaches `worldDigest`; the driver has no DOM types.
      (s) => window.worldDigest(s),
      seed,
    );
    const differing = here.filter((line, i) => line !== there[i]);
    if (differing.length === 0) {
      console.log(`seed ${text} (${seed}): the browser builds Node's world — ${here.length} layers agree`);
      continue;
    }
    failures++;
    console.error(`seed ${text} (${seed}): the browser builds another world.`);
    for (const line of differing) console.error(`  node    ${line}\n  browser ${there[here.indexOf(line)]}`);
    console.error('  The first line listed is the stage that diverged; the rest follow from it.');
  }
  if (errors.length > 0) {
    failures++;
    console.error(`page errors:\n  ${errors.join('\n  ')}`);
  }
} finally {
  await browser?.close();
  await server?.close();
}

if (failures > 0) {
  console.error(`\n${failures} seed(s) build differently in the browser. See docs/world-generation.md.`);
  process.exit(1);
}

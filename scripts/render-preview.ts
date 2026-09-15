/**
 * Take a picture of what the renderer draws, for eyeballing from a session.
 *
 * `world-preview.ts` draws the world description; this draws the game. It needs
 * a real WebGPU device, so it serves the project with Vite, opens the page in a
 * headless Chromium, and asks `src/render/preview.ts` for one frame.
 *
 * Usage: node scripts/render-preview.ts [seed] [out.png] [--option=value]
 *   --x, --y         where the player stands, in metres. Default the spawn.
 *   --junction       stand at the N-th junction out from the core instead, and
 *                    say where it is and which roads meet there. `--tiers`
 *                    narrows the count to junctions of that mix, for example
 *                    `--tiers=arterial+street` or `--tiers=alley`.
 *   --distance       how far back the camera sits. Default the game's.
 *   --heading        which way the player faces, in degrees.
 *   --speed          how fast the player moves, in metres per second.
 *   --width,--height the size of the picture.
 *   --hour           the hour of the day to light the frame at, 0 to 24.
 *   --buildings      what a building in the way does (spec section 10.7):
 *                    see-through, pull-back or whole. Default see-through.
 *   --quality        the quality tier to draw at (spec section 9.2): full,
 *                    high, medium or low. Default full.
 *   --vehicle        the class of vehicle to stand the player in (spec section
 *                    11.3): compact, saloon, sports, van, truck, bus,
 *                    motorcycle, offroad, buggy, emergency or boat.
 *   --on-foot        stand the player beside the vehicle rather than in it,
 *                    which is how the character is looked at (spec section
 *                    11.5).
 *   --damage         the damage state to show the vehicle in (spec section
 *                    11.3): dented, smoking, burning or burnt.
 *   --skid           lay a drift's worth of skid marks into the road behind
 *                    the vehicle (spec section 11.3).
 *   --weapon         the weapon in the player's hands, by id, for example
 *                    `ak-47` (spec section 11.6). Drawn with --on-foot.
 *   --attachments    what is fitted to it and to the pickups, for example
 *                    `suppressor+optic`.
 *   --aim            hold the weapon at the shoulder.
 *   --pickups        lay every weapon of the arsenal in rows ahead of the
 *                    player, to compare the silhouettes.
 *   --hover          the index of the laid pickup to draw grown, as the one
 *                    under the mouse.
 *   --tram           stand beside the first tram at the hour of the picture
 *                    (spec section 13.2), and --stop=N at the N-th tram stop.
 *                    Either one overrides --x, --y and --junction.
 *
 * The browser comes from Playwright. A cloud session already has one; on a
 * fresh machine run `npx playwright install chromium` first, or point
 * CHROMIUM_PATH at a Chromium binary.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { seedFromString } from '../src/core/rng.ts';
import { BASE_DISTANCE } from '../src/render/camera.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { buildJunctions, type Junction } from '../src/world/junctions.ts';
import { generateWorld } from '../src/world/world.ts';
import { tickAtHour } from '../src/render/daylight.ts';
import { AmbientTraffic, trafficRoadsOf, type AmbientPose } from '../src/sim/traffic.ts';
import { TramLine } from '../src/sim/tram.ts';
import type { PreviewRequest, PreviewResult } from '../src/render/preview.ts';
import { encodePng } from './png.ts';

/**
 * What this Chromium needs before it offers a WebGPU adapter. Without them
 * `navigator.gpu.requestAdapter()` returns nothing and the game shows its
 * "no adapter" message. SwiftShader draws on the processor, so it is slow but
 * it does not need a graphics card.
 */
const CHROMIUM_FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-angle=swiftshader',
  '--disable-vulkan-surface',
];

/** How long one frame may take. SwiftShader draws a whole world slowly. */
const TIMEOUT_MS = 600_000;

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const options = new Map<string, string>(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const eq = a.indexOf('=');
      return eq === -1 ? [a.slice(2), 'true'] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);

const seedText = positional[0] ?? 'sunset';
const out = positional[1] ?? `render-${seedText}.png`;

function num(name: string, fallback: number): number {
  const raw = options.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} wants a number, not ${raw}`);
  return value;
}

/**
 * Where a junction stands, for eyeballing how roads meet. The junctions are
 * counted out from the core, so the low numbers are the ones the player sees
 * first, and `--tiers` counts only the junctions where exactly that mix of
 * tiers meets.
 */
function junctionAt(seed: number, index: number, tiers: string | undefined): Junction {
  const world = generateWorld(seed);
  const junctions = buildJunctions(world.roads, buildRoadGraph(world.roads)).junctions.filter(
    (junction) => tiers === undefined || mixOf(junction) === tiers,
  );
  junctions.sort(
    (a, b) => Math.hypot(a.x - world.core.x, a.y - world.core.y) - Math.hypot(b.x - world.core.x, b.y - world.core.y),
  );
  const found = junctions[index];
  if (found === undefined) throw new Error(`only ${junctions.length} junctions${tiers === undefined ? '' : ` of ${tiers}`}`);
  return found;
}

/** The tiers that meet at a junction, each named once, as `--tiers` names them. */
function mixOf(junction: Junction): string {
  return [...new Set(junction.mouths.map((mouth) => mouth.tier))].sort().join('+');
}

const seed = seedFromString(seedText);
const junction = options.has('junction') ? junctionAt(seed, num('junction', 0), options.get('tiers')) : undefined;
if (junction !== undefined) {
  const mouths = junction.mouths.map((mouth) => `${mouth.tier} cut ${mouth.cut.toFixed(1)} m`).join(', ');
  console.log(`junction ${options.get('junction')} at ${junction.x.toFixed(1)},${junction.y.toFixed(1)}: ${mouths}`);
}

/** Where `--tram` or `--stop` stands the player: beside the first tram at the hour, or at a stop. */
function tramPlace(): { x: number; y: number } | undefined {
  if (!options.has('tram') && !options.has('stop')) return undefined;
  const world = generateWorld(seed);
  if (options.has('stop')) {
    const stop = world.tram.stops[num('stop', 0)];
    if (stop === undefined) throw new Error(`only ${world.tram.stops.length} tram stops`);
    return stop;
  }
  const roads = trafficRoadsOf(world);
  const line = new TramLine(seed, roads, world.tram, world.districts, new AmbientTraffic(seed, roads).signals);
  if (line.trams === 0) throw new Error('no tram runs on this seed');
  const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  return line.carPose(0, 1, tickAtHour(num('hour', 12)), pose);
}
const tram = tramPlace();

const request: PreviewRequest = {
  seed,
  x: tram?.x ?? num('x', junction?.x ?? 0),
  y: tram?.y ?? num('y', junction?.y ?? 0),
  distance: num('distance', BASE_DISTANCE),
  heading: (num('heading', 0) * Math.PI) / 180,
  speed: num('speed', 0),
  width: num('width', 960),
  height: num('height', 540),
  hour: num('hour', 12),
  ...(options.has('quality') ? { quality: options.get('quality') as string } : {}),
  ...(options.has('buildings') ? { buildings: options.get('buildings') as string } : {}),
  ...(options.has('vehicle') ? { vehicle: options.get('vehicle') as string } : {}),
  ...(options.has('on-foot') ? { onFoot: true } : {}),
  ...(options.has('damage') ? { damage: options.get('damage') as string } : {}),
  ...(options.has('skid') ? { skid: true } : {}),
  ...(options.has('weapon') ? { weapon: options.get('weapon') as string } : {}),
  ...(options.has('attachments') ? { attachments: (options.get('attachments') as string).split('+') } : {}),
  ...(options.has('aim') ? { aim: true } : {}),
  ...(options.has('pickups') ? { pickups: true } : {}),
  ...(options.has('hover') ? { hover: num('hover', 0) } : {}),
};

/**
 * A Chromium to drive. Playwright names the build it shipped with, which is not
 * always the build an environment installed, so the browser directory is
 * searched before giving up.
 */
function chromiumPath(): string {
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const expected = chromium.executablePath();
  if (existsSync(expected)) return expected;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root !== undefined && root !== '' && existsSync(root)) {
    for (const entry of readdirSync(root).sort()) {
      if (!entry.startsWith('chromium-')) continue;
      for (const dir of ['chrome-linux64', 'chrome-linux']) {
        const candidate = join(root, entry, dir, 'chrome');
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error(
    `No Chromium at ${expected}. Run \`npx playwright install chromium\`, or set CHROMIUM_PATH to a binary.`,
  );
}

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
try {
  server = await createServer({ server: { port: 0 }, logLevel: 'warn' });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error('Vite started without a local address.');

  browser = await chromium.launch({ executablePath: chromiumPath(), args: CHROMIUM_FLAGS });
  const page = await browser.newPage({ viewport: { width: request.width, height: request.height } });
  // A page error is the usual failure, and it is silent otherwise: the frame
  // never resolves and the run stops at the timeout with nothing to read.
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  await page.goto(new URL('scripts/render-preview.html', url).href, { timeout: TIMEOUT_MS });
  await page.waitForFunction('window.previewReady === true', undefined, { timeout: TIMEOUT_MS });

  const result = await page.evaluate<PreviewResult, PreviewRequest>(
    // @ts-expect-error the page attaches `renderPreview`; the driver has no DOM types.
    (req) => window.renderPreview(req),
    request,
  );
  if (failures.length > 0) console.error(`page errors:\n  ${failures.join('\n  ')}`);

  const rgb = new Uint8Array(Buffer.from(result.rgb, 'base64'));
  writeFileSync(out, encodePng(result.width, result.height, rgb));
  console.log(
    `${out}: ${result.width}x${result.height}, seed ${seedText} at ${request.x},${request.y}` +
      ` at ${request.hour.toFixed(1)}h` +
      ` — world ${result.worldMs.toFixed(0)} ms, chunks ${result.chunkMs.toFixed(0)} ms,` +
      ` frame ${result.frameMs.toFixed(0)} ms, dearest chunk ${result.peakDrawCalls} draw calls,` +
      ` ${result.lights} lights, ${result.shadows} shadow cascades, ${result.quality} quality,` +
      ` ${result.traffic} vehicles of traffic, ${result.parked} parked cars, ${result.pedestrians} pedestrians`,
  );
} finally {
  await browser?.close();
  await server?.close();
}

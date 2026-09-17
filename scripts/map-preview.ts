/**
 * Take a picture of the map of spec section 12, for eyeballing from a session.
 *
 * `world-preview.ts` draws the world description and `render-preview.ts` draws
 * the game; this draws the map the player reads. It is a 2D canvas, so it needs
 * no WebGPU device: Vite serves the page, a headless Chromium draws it, and the
 * pixels come back as a PNG.
 *
 * Usage: node scripts/map-preview.ts [seed] [out.png] [--option=value]
 *   --x, --y     the world point at the middle of the picture. Default 0,0.
 *   --scale      metres to the pixel. Default 4, which is what the full map
 *                opens at; the minimap draws at 1.1.
 *   --heading    which way the player faces, in degrees.
 *   --rotate     turn the map so the player faces up, as the minimap does.
 *   --minimap    draw the round minimap window, at the minimap's own scale and
 *                icon size, rather than the full map.
 *   --waypoint   a place to mark, as `x,y`.
 *   --turf       wash the factions' turf over the land (spec section 17.2).
 *   --day        the game day the turf is read on, since it spreads. Default 0.
 *   --width,--height  the size of the picture.
 *
 * The browser comes from Playwright. A cloud session already has one; on a
 * fresh machine run `npx playwright install chromium` first, or point
 * CHROMIUM_PATH at a Chromium binary.
 */
import { writeFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { seedFromString } from '../src/core/rng.ts';
import { TICKS_PER_DAY } from '../src/sim/clock.ts';
import type { MapPreviewRequest, MapPreviewResult } from '../src/ui/map-preview.ts';
import { chromiumPath } from './chromium.ts';
import { encodePng } from './png.ts';

/** How long the world and the picture may take together. */
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
const out = positional[1] ?? `map-${seedText}.png`;

function num(name: string, fallback: number): number {
  const raw = options.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} wants a number, not ${raw}`);
  return value;
}

/** `--waypoint=x,y`, or null where none was asked for. */
function waypoint(): { x: number; y: number } | null {
  const raw = options.get('waypoint');
  if (raw === undefined) return null;
  const [x, y] = raw.split(',').map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`--waypoint wants \`x,y\`, not ${raw}`);
  return { x: x as number, y: y as number };
}

const minimap = options.has('minimap');
const request: MapPreviewRequest = {
  seed: seedFromString(seedText),
  x: num('x', 0),
  y: num('y', 0),
  scale: num('scale', minimap ? 1.1 : 4),
  heading: (num('heading', 0) * Math.PI) / 180,
  rotate: options.has('rotate') || minimap,
  minimap,
  width: num('width', minimap ? 380 : 960),
  height: num('height', minimap ? 380 : 720),
  waypoint: waypoint(),
  turf: options.has('turf'),
  tick: Math.round(num('day', 0) * TICKS_PER_DAY),
};

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
try {
  server = await createServer({ server: { port: 0 }, logLevel: 'warn' });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error('Vite started without a local address.');

  browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ viewport: { width: request.width, height: request.height } });
  // A page error is the usual failure, and it is silent otherwise: the picture
  // never resolves and the run stops at the timeout with nothing to read.
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  await page.goto(new URL('scripts/map-preview.html', url).href, { timeout: TIMEOUT_MS });
  await page.waitForFunction('window.previewReady === true', undefined, { timeout: TIMEOUT_MS });

  const result = await page.evaluate<MapPreviewResult, MapPreviewRequest>(
    // @ts-expect-error the page attaches `renderMapPreview`; the driver has no DOM types.
    (req) => window.renderMapPreview(req),
    request,
  );
  if (failures.length > 0) console.error(`page errors:\n  ${failures.join('\n  ')}`);

  const rgb = new Uint8Array(Buffer.from(result.rgb, 'base64'));
  writeFileSync(out, encodePng(result.width, result.height, rgb));
  console.log(
    `${out}: ${result.width}x${result.height}, seed ${seedText} at ${request.x},${request.y}` +
      ` at ${request.scale} m/px${request.rotate ? ', rotating' : ', north up'}` +
      ` — world ${result.worldMs.toFixed(0)} ms, art ${result.artMs.toFixed(0)} ms,` +
      ` draw ${result.drawMs.toFixed(1)} ms, ${result.pois} places marked`,
  );
} finally {
  await browser?.close();
  await server?.close();
}

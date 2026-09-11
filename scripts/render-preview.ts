/**
 * Take a picture of what the renderer draws, for eyeballing from a session.
 *
 * `world-preview.ts` draws the world description; this draws the game. It needs
 * a real WebGPU device, so it serves the project with Vite, opens the page in a
 * headless Chromium, and asks `src/render/preview.ts` for one frame.
 *
 * Usage: node scripts/render-preview.ts [seed] [out.png] [--option=value]
 *   --x, --y         where the player stands, in metres. Default the spawn.
 *   --distance       how far back the camera sits. Default the game's.
 *   --heading        which way the player faces, in degrees.
 *   --speed          how fast the player moves, in metres per second.
 *   --width,--height the size of the picture.
 *   --hour           the hour of the day to light the frame at, 0 to 24.
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

const request: PreviewRequest = {
  seed: seedFromString(seedText),
  x: num('x', 0),
  y: num('y', 0),
  distance: num('distance', BASE_DISTANCE),
  heading: (num('heading', 0) * Math.PI) / 180,
  speed: num('speed', 0),
  width: num('width', 960),
  height: num('height', 540),
  hour: num('hour', 12),
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
      ` ${result.lights} lights, ${result.shadows} shadow cascades`,
  );
} finally {
  await browser?.close();
  await server?.close();
}

/**
 * Draw what the renderer makes of many seeds as one PNG, in a grid.
 *
 * Usage: node scripts/render-sheet.ts [count] [out.png] [--cols=3] [--tile=480]
 *            [--hour=12] [--seeds=7,9,11] [--x=0] [--y=0] [--distance=..] [--quality=..]
 *
 * `terrain-sheet.ts` says why this exists, for the terrain: one preview per
 * seed hides that the maps look alike. The same is true of the rendered frame,
 * and a frame costs far more to make, so the sheet also saves the browser being
 * started once per seed.
 *
 * This is for comparing seeds. A change to the rendering itself is still judged
 * on a full-size frame from `render-preview.ts`; a tile is too small to see a
 * shadow edge or a material in.
 *
 * The seeds are the seeds of the sweep, in order, so a tile on the sheet is a
 * world the tests read. `--seeds` names them instead, for looking at the ones a
 * failure named.
 */
import { writeFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { seedFromString } from '../src/core/rng.ts';
import { BASE_DISTANCE } from '../src/render/camera.ts';
import type { PreviewRequest, PreviewResult } from '../src/render/preview.ts';
import { sweepSeeds } from '../test/helpers.ts';
import { chromiumPath } from './chromium.ts';
import { encodePng } from './png.ts';

/** A frame is slow to build, and a whole sheet of them is slower. */
const TIMEOUT_MS = 300_000;
/** Pixels of gutter between tiles. */
const GAP = 4;
/** WebGPU on a headless browser, as `render-preview.ts` asks for it. */
const CHROMIUM_FLAGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal'];

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const option = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const num = (name: string, fallback: number): number => {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} wants a number, not ${raw}`);
  return value;
};

const named = option('seeds');
const count = Number(positional[0] ?? 6);
const seeds = named === undefined ? sweepSeeds(count) : named.split(',').map((s) => seedFromString(s.trim()));
const out = positional[1] ?? 'render-sheet.png';
const cols = Math.max(1, num('cols', 3));
const tileWidth = Math.max(64, num('tile', 480));
// The game draws 16:9, and a tile that does not is a tile of a different frame.
const tileHeight = Math.round((tileWidth * 9) / 16);

const rows = Math.ceil(seeds.length / cols);
const width = cols * tileWidth + (cols + 1) * GAP;
const height = rows * tileHeight + (rows + 1) * GAP;
const sheet = new Uint8Array(width * height * 3).fill(24);

/** Copy one frame into its cell, sampling if the page gave a different size. */
function blit(rgb: Uint8Array, from: { width: number; height: number }, left: number, top: number): void {
  for (let py = 0; py < tileHeight; py++) {
    const sy = from.height === tileHeight ? py : Math.min(from.height - 1, Math.floor((py / tileHeight) * from.height));
    for (let px = 0; px < tileWidth; px++) {
      const sx = from.width === tileWidth ? px : Math.min(from.width - 1, Math.floor((px / tileWidth) * from.width));
      const source = (sy * from.width + sx) * 3;
      const target = ((top + py) * width + left + px) * 3;
      sheet[target] = rgb[source]!;
      sheet[target + 1] = rgb[source + 1]!;
      sheet[target + 2] = rgb[source + 2]!;
    }
  }
}

const started = performance.now();
const lines: string[] = [];
let server: ViteDevServer | undefined;
let browser: Browser | undefined;
try {
  server = await createServer({ server: { port: 0 }, logLevel: 'warn' });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error('Vite started without a local address.');

  browser = await chromium.launch({ executablePath: chromiumPath(), args: CHROMIUM_FLAGS });
  const page = await browser.newPage({ viewport: { width: tileWidth, height: tileHeight } });
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  await page.goto(new URL('scripts/render-preview.html', url).href, { timeout: TIMEOUT_MS });
  await page.waitForFunction('window.previewReady === true', undefined, { timeout: TIMEOUT_MS });

  for (let k = 0; k < seeds.length; k++) {
    const seed = seeds[k]!;
    const request: PreviewRequest = {
      seed,
      x: num('x', 0),
      y: num('y', 0),
      distance: num('distance', BASE_DISTANCE),
      heading: (num('heading', 0) * Math.PI) / 180,
      speed: 0,
      width: tileWidth,
      height: tileHeight,
      hour: num('hour', 12),
      ...(option('quality') === undefined ? {} : { quality: option('quality') as string }),
    };
    // One page for every seed: the browser and the device are the slow part to
    // build, and the page rebuilds the world for each request anyway.
    const before = failures.length;
    const result = await page.evaluate<PreviewResult, PreviewRequest>(
      // @ts-expect-error the page attaches `renderPreview`; the driver has no DOM types.
      (req) => window.renderPreview(req),
      request,
    );
    const col = k % cols;
    const row = Math.floor(k / cols);
    blit(
      new Uint8Array(Buffer.from(result.rgb, 'base64')),
      result,
      GAP + col * (tileWidth + GAP),
      GAP + row * (tileHeight + GAP),
    );
    lines.push(
      `  row ${row + 1} col ${col + 1}: seed ${seed} — world ${result.worldMs.toFixed(0)} ms,` +
        ` chunks ${result.chunkMs.toFixed(0)} ms, frame ${result.frameMs.toFixed(0)} ms,` +
        ` ${result.peakDrawCalls} draw calls, ${result.quality} quality,` +
        ` ${result.traffic} traffic, ${result.pedestrians} pedestrians` +
        (failures.length > before ? `, ${failures.length - before} page error(s)` : ''),
    );
  }
  if (failures.length > 0) console.error(`page errors:\n  ${failures.join('\n  ')}`);
} finally {
  await browser?.close();
  await server?.close();
}

writeFileSync(out, encodePng(width, height, sheet));
console.log(
  `${out}: ${width}x${height}, ${seeds.length} seeds in ${cols} columns,` +
    ` ${((performance.now() - started) / 1000).toFixed(1)} s`,
);
for (const line of lines) console.log(line);

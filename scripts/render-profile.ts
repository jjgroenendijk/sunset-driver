/**
 * Time the frames the game draws, on this machine's GPU.
 *
 * `render-preview.ts` takes one picture. This draws a few hundred frames of the
 * same scene, standing still and then driving, and prints what they took. It
 * is how a frame-rate change is measured rather than guessed at. It needs a
 * real GPU: SwiftShader draws on the processor and says nothing about a frame.
 *
 * Usage: node scripts/render-profile.ts [seed] [--option=value]
 *   --x, --y         where to stand, in metres. The drive starts on the nearest
 *                    road to it. Default the nearest road to the origin.
 *   --quality        the quality tier to draw at: full, high, medium or low.
 *   --still, --drive frames drawn standing still, then driving. Default 240, 480.
 *   --speed          metres per second the drive goes at. Default 25.
 *   --width,--height the size of the page. Default 1600x900.
 *   --dpr            the device pixel ratio. Default 1; a Retina display is 2.
 *   --hour           the hour of the day to light the frame at. Default 12.
 *   --no-water, --no-shadows, --no-clustered, --no-post, --no-lamps
 *                    take one part of the frame away, to see what it cost.
 *   --no-cast        kinds of batch that cast no shadow, as a list:
 *                    road, facade, block, outline, plant, lamp.
 *   --long           list every frame over 33 ms, with what it compiled.
 *   --cpuprofile     profile the drive and list where its time went.
 *
 * GPU timings move by several milliseconds from one run to the next. Compare two
 * builds by running them in turn, more than once each.
 *
 * Point CHROMIUM_PATH at a Chrome or Chromium that offers a hardware WebGPU
 * adapter, such as an installed Google Chrome.
 */
import { chromium } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { seedFromString } from '../src/core/rng.ts';
import type { FrameSample, ProfileRequest, ProfileResult } from '../src/render/profile.ts';
import { chromiumPath } from './chromium.ts';

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

function num(name: string, fallback: number): number {
  const raw = options.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} wants a number, not ${raw}`);
  return value;
}

const seedText = positional[0] ?? 'sunset';
const request: ProfileRequest = {
  seed: seedFromString(seedText),
  x: num('x', 0),
  y: num('y', 0),
  width: num('width', 1600),
  height: num('height', 900),
  hour: num('hour', 12),
  still: num('still', 240),
  drive: num('drive', 480),
  speed: num('speed', 25),
  ...(options.has('quality') ? { quality: options.get('quality') as string } : {}),
  noWater: options.has('no-water'),
  noShadows: options.has('no-shadows'),
  noClustered: options.has('no-clustered'),
  noPost: options.has('no-post'),
  noLamps: options.has('no-lamps'),
  noCast: options.get('no-cast')?.split(',') ?? [],
  gate: options.has('cpuprofile'),
};

/** A percentile of one field of the samples. */
function pct(samples: readonly FrameSample[], field: keyof FrameSample, p: number): number {
  const sorted = samples.map((s) => s[field]).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

function report(name: string, samples: readonly FrameSample[]): void {
  if (samples.length === 0) return;
  if (options.has('long')) {
    samples.forEach((s, i) => {
      if (s.totalMs <= 33) return;
      const before = samples[i - 1] ?? s;
      console.log(
        `  ${name} frame ${i}: ${s.totalMs.toFixed(0)} ms (cpu ${s.cpuMs.toFixed(0)}), ` +
          `${s.pipelines - before.pipelines} pipelines and ${s.builds - before.builds} node builds, ` +
          `${s.streaming} streaming`,
      );
    });
  }
  const f = (field: keyof FrameSample, p: number): string => pct(samples, field, p).toFixed(1);
  const long = samples.filter((s) => s.totalMs > 33).length;
  console.log(
    `${name}: frame p50 ${f('totalMs', 0.5)} p95 ${f('totalMs', 0.95)} max ${f('totalMs', 1)} ms` +
      ` | cpu p50 ${f('cpuMs', 0.5)} p95 ${f('cpuMs', 0.95)} | update max ${f('updateMs', 1)}` +
      ` | ${f('draws', 0.5)} draws, ${(pct(samples, 'triangles', 0.5) / 1e6).toFixed(2)}M triangles` +
      ` | ${long} frames over 33 ms`,
  );
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
}

/** The functions the drive spent most of its own time in, from a V8 CPU profile. */
function summarise(profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }): void {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map<string, number>();
  let total = 0;
  profile.samples.forEach((id, i) => {
    const node = byId.get(id);
    const ms = (profile.timeDeltas[i] ?? 0) / 1000;
    total += ms;
    if (node === undefined) return;
    const file = node.callFrame.url.split('/').pop()?.split('?')[0] ?? '';
    const key = `${node.callFrame.functionName || '(anonymous)'} ${file}:${node.callFrame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + ms);
  });
  console.log(`cpu profile of the drive: ${total.toFixed(0)} ms sampled`);
  for (const [key, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${ms.toFixed(0).padStart(6)} ms  ${key}`);
  }
}

let server: ViteDevServer | undefined;
const browser = await chromium.launch({
  executablePath: chromiumPath({ hardware: true }),
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
try {
  server = await createServer({ server: { port: 0 }, logLevel: 'warn' });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error('Vite started without a local address.');
  const page = await browser.newPage({
    viewport: { width: request.width, height: request.height },
    deviceScaleFactor: num('dpr', 1),
  });
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  // WebGPU is offered to a secure page only, so the page is served rather than opened blank.
  await page.goto(new URL('scripts/render-profile.html', url).href);
  await page.waitForFunction('window.profileReady === true');
  const pending = page.evaluate<ProfileResult, ProfileRequest>(
    // @ts-expect-error the page attaches `runProfile`; the driver has no DOM types.
    (req) => window.runProfile(req),
    request,
  );
  let result: ProfileResult;
  if (request.gate === true) {
    await page.waitForFunction('window.driveReady === true', undefined, { timeout: 600_000 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
    await page.evaluate('window.startDrive()');
    result = await pending;
    const { profile } = await cdp.send('Profiler.stop');
    summarise(profile as unknown as Parameters<typeof summarise>[0]);
  } else {
    result = await pending;
  }
  console.log(`seed ${seedText}, ${request.width}x${request.height} at ${num('dpr', 1)}x, ${request.quality ?? 'full'} quality`);
  for (const [kind, batch] of Object.entries(result.kinds).sort((a, b) => b[1].vertices - a[1].vertices)) {
    console.log(`  ${kind}: ${batch.batches} batches, ${batch.parts} parts, ${(batch.vertices / 1e3).toFixed(0)}k vertices`);
  }
  report('still', result.still);
  report('drive', result.drive);
} finally {
  await browser.close();
  await server?.close();
}

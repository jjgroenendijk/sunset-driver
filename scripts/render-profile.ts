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
 *   --quality        the quality tier to draw at: full, high, medium, low or lowest.
 *   --still, --drive frames drawn standing still, then driving. Default 240, 480.
 *   --speed          metres per second the drive goes at. Default 25.
 *   --width,--height the size of the page. Default 1600x900.
 *   --dpr            the device pixel ratio. Default 1; a Retina display is 2.
 *   --hour           the hour of the day to light the frame at. Default 12.
 *   --weather        clear, rain, fog or storm, or seed for the weather the
 *                    seed has at that hour. Default clear.
 *   --no-water, --no-shadows, --no-clustered, --no-post, --no-lamps
 *                    take one part of the frame away, to see what it cost.
 *   --no-cast        kinds of batch that cast no shadow, as a list:
 *                    road, facade, block, plant, lamp.
 *   --tier-at        quality changes during the drive, as frame:tier pairs
 *                    separated by commas: --tier-at=150:high,300:full applies
 *                    those tiers at those drive frames. This is how a tier
 *                    change is timed: the frames around it say what it cost.
 *   --long           list every frame over 33 ms, with what it compiled.
 *   --passes         time every pass on the GPU with timestamp queries: the
 *                    shadow cascades, the scene, each step of the post chain.
 *   --cpuprofile     profile the drive and list where its time went, by area
 *                    (src/sim, three.js, the collector), by file and by
 *                    function. --cpuprofile=drive.cpuprofile also writes the
 *                    profile, for the Performance panel of Chrome DevTools.
 *   --shaders=<dir>  write the WGSL of every stage the frames compiled, as
 *                    `<n>.vert.wgsl` and `<n>.frag.wgsl`, to read what a
 *                    material's shader really does.
 *   --view           the camera view: top-down, third-person or first-person.
 *                    Default top-down.
 *   --rings=N,F      the near and far streaming rings, in chunks, instead of
 *                    the tier's own: what a draw distance costs.
 *   --cpu-slowdown=N run the page and its chunk workers N times slower, through
 *                    Chrome's CPU throttling: a phone whose workers land on
 *                    its slow cores. The GPU is not slowed.
 *   --device=phone   the screen of an iPhone 13 Pro held sideways, 844x390 at
 *                    3x, and the tier a touch session starts on. The GPU is
 *                    still this machine's: `docs/performance-budget.md` says
 *                    how its numbers are read against the phone's.
 *   --json=<file>    write every sample of the run, for `profile-compare.ts`.
 *   --memory         report what the page and the GPU hold: settled after the
 *                    still frames, and at the most over the drive. The GPU is
 *                    counted by wrapping `createBuffer`, `createTexture` and
 *                    `destroy` (`src/render/frame/memory.ts`); the page's heap and its
 *                    typed arrays come from DevTools, after a collection.
 *
 * GPU timings move by several milliseconds from one run to the next. Compare two
 * builds by running them in turn, more than once each.
 *
 * Point CHROMIUM_PATH at a Chrome or Chromium that offers a hardware WebGPU
 * adapter, such as an installed Google Chrome.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { seedFromString } from '../src/core/rng.ts';
import { compareStrings } from '../src/core/sort.ts';
import type { FrameSample, ProfileRequest, ProfileResult } from '../src/render/preview/profile.ts';
import { EDGES, FADING, type PopIn } from '../src/render/frame/pop-in.ts';
import { chromiumPath } from './chromium.ts';
import { printProfile, saveProfile, summariseProfile, type CpuProfile, type CpuSummary } from './cpu-profile.ts';
import { percentile, saveRun } from './profile-run.ts';

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

/** `--rings=2,3` as the rings it names. */
function ringsOf(text: string): { near: number; far: number } {
  const [near, far] = text.split(',').map(Number);
  if (!Number.isInteger(near) || !Number.isInteger(far)) throw new Error(`--rings wants two whole numbers, not ${text}`);
  return { near: near as number, far: far as number };
}

/** The screens `--device` names: the size of the page, its pixel ratio and the tier it settles on. */
const DEVICES: Record<string, { width: number; height: number; dpr: number; quality: string }> = {
  phone: { width: 844, height: 390, dpr: 3, quality: 'medium' },
};

const device = options.has('device') ? DEVICES[options.get('device') as string] : undefined;
if (options.has('device') && device === undefined) throw new Error(`--device knows ${Object.keys(DEVICES).join(', ')}`);
const quality = options.get('quality') ?? device?.quality;
const dpr = num('dpr', device?.dpr ?? 1);

const seedText = positional[0] ?? 'sunset';
const request: ProfileRequest = {
  seed: seedFromString(seedText),
  x: num('x', 0),
  y: num('y', 0),
  width: num('width', device?.width ?? 1600),
  height: num('height', device?.height ?? 900),
  hour: num('hour', 12),
  still: num('still', 240),
  drive: num('drive', 480),
  speed: num('speed', 25),
  ...(quality === undefined ? {} : { quality }),
  ...(options.has('view') ? { view: options.get('view') as ProfileRequest['view'] } : {}),
  ...(options.has('rings') ? { rings: ringsOf(options.get('rings') as string) } : {}),
  ...(options.has('weather') ? { weather: options.get('weather') as string } : {}),
  noWater: options.has('no-water'),
  noShadows: options.has('no-shadows'),
  noClustered: options.has('no-clustered'),
  noPost: options.has('no-post'),
  noLamps: options.has('no-lamps'),
  noCast: options.get('no-cast')?.split(',') ?? [],
  tierAt: options.get('tier-at')?.split(','),
  gate: options.has('cpuprofile') || options.has('memory'),
  memory: options.has('memory'),
  passes: options.has('passes'),
  shaders: options.has('shaders'),
};

/** The page's heap, and the typed arrays outside it, in bytes. */
interface HeapUsage {
  usedSize: number;
  backingStorageSize?: number;
}

const mb = (bytes: number): string => `${(bytes / 2 ** 20).toFixed(0)} MB`;

/** The fields of a frame that are one number each. */
type Field = Exclude<keyof FrameSample, 'passes' | 'popIn'>;

/** A percentile of one field of the samples. */
function pct(samples: readonly FrameSample[], field: Field, p: number): number {
  return percentile(
    samples.map((s) => s[field]),
    p,
  );
}

/** The GPU time of every frame, and of every pass in it, by name; a pass a frame lacks took 0. */
function passSeries(samples: readonly FrameSample[]): Map<string, number[]> {
  const labels = new Set(samples.flatMap((s) => Object.keys(s.passes ?? {})));
  const series = new Map<string, number[]>();
  series.set('gpu', samples.map((s) => Object.values(s.passes ?? {}).reduce((a, b) => a + b, 0)));
  for (const label of [...labels].sort(compareStrings)) series.set(`gpu: ${label}`, samples.map((s) => s.passes?.[label] ?? 0));
  return series;
}

/** What each pass took on the GPU, the most costly first. */
function reportPasses(name: string, samples: readonly FrameSample[]): void {
  const series = [...passSeries(samples)].sort((a, b) => percentile(b[1], 0.5) - percentile(a[1], 0.5));
  console.log(`${name} gpu passes, ms: p50  p95  max`);
  for (const [label, values] of series) {
    const cells = [0.5, 0.95, 1].map((p) => percentile(values, p).toFixed(2).padStart(6)).join(' ');
    console.log(`  ${cells}  ${label}`);
  }
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
  const f = (field: Field, p: number): string => pct(samples, field, p).toFixed(1);
  const long = samples.filter((s) => s.totalMs > 33).length;
  console.log(
    `${name}: frame p50 ${f('totalMs', 0.5)} p95 ${f('totalMs', 0.95)} max ${f('totalMs', 1)} ms` +
      ` | cpu p50 ${f('cpuMs', 0.5)} p95 ${f('cpuMs', 0.95)} | update max ${f('updateMs', 1)}` +
      ` | ${f('draws', 0.5)} draws, ${(pct(samples, 'triangles', 0.5) / 1e6).toFixed(2)}M triangles` +
      ` | ${long} frames over 33 ms`,
  );
}

/** The nearest of a list of distances, as a reader wants it: `none` when nothing showed. */
function metres(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(0)} m` : 'none';
}

/**
 * Where the drive showed things pop in (`pop-in.ts`): for each edge, the share
 * of frames it was in sight and the nearest it stood to the camera.
 */
function reportPopIn(samples: readonly FrameSample[]): void {
  if (samples.length === 0) return;
  const line = (name: string, pick: (p: PopIn) => number): string => {
    const values = samples.map((s) => pick(s.popIn));
    const seen = values.filter(Number.isFinite);
    const share = ((seen.length / values.length) * 100).toFixed(0);
    return `${name} ${metres(Math.min(...values))} (${share}%)`;
  };
  console.log(`pop-in, nearest to the camera (share of drive frames in sight):`);
  console.log(`  streaming late: ${line('hole', (p) => p.hole)}, ${line('old detail', (p) => p.late)}`);
  const edges = (fade: boolean): string =>
    EDGES.filter((edge) => FADING.has(edge) === fade)
      .map((edge) => line(edge, (p) => p.edges[edge]))
      .join(', ');
  console.log(`  edges that pop: ${edges(false)}`);
  console.log(`  edges that fade: ${edges(true)}`);
}

let server: ViteDevServer | undefined;
const browser = await chromium.launch({
  executablePath: chromiumPath({ hardware: true }),
  headless: true,
  // Chrome rounds a timestamp query to a tenth of a millisecond unless the
  // developer features are on, which would round a short pass to nothing.
  args: [
    '--enable-unsafe-webgpu',
    '--enable-gpu',
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
    ...(request.passes === true ? ['--enable-webgpu-developer-features'] : []),
  ],
});
try {
  server = await createServer({ server: { port: 0 }, logLevel: 'warn' });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error('Vite started without a local address.');
  const page = await browser.newPage({
    viewport: { width: request.width, height: request.height },
    deviceScaleFactor: dpr,
  });
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  if (options.has('cpu-slowdown')) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: num('cpu-slowdown', 1) });
  }
  // WebGPU is offered to a secure page only, so the page is served rather than opened blank.
  await page.goto(new URL('scripts/render-profile.html', url).href);
  await page.waitForFunction('window.profileReady === true');
  const pending = page.evaluate<ProfileResult, ProfileRequest>(
    // @ts-expect-error the page attaches `runProfile`; the driver has no DOM types.
    (req) => window.runProfile(req),
    request,
  );
  let result: ProfileResult;
  let cpu: CpuSummary | undefined;
  let heap: { settled: HeapUsage; peak: HeapUsage } | undefined;
  if (request.gate === true) {
    await page.waitForFunction('window.driveReady === true', undefined, { timeout: 600_000 });
    const cdp = await page.context().newCDPSession(page);
    let watching = false;
    let watch: Promise<void> = Promise.resolve();
    if (request.memory === true) {
      await cdp.send('HeapProfiler.collectGarbage');
      const settled = (await cdp.send('Runtime.getHeapUsage')) as HeapUsage;
      const peak = { ...settled };
      heap = { settled, peak };
      watching = true;
      watch = (async () => {
        while (watching) {
          const now = (await cdp.send('Runtime.getHeapUsage')) as HeapUsage;
          peak.usedSize = Math.max(peak.usedSize, now.usedSize);
          peak.backingStorageSize = Math.max(peak.backingStorageSize ?? 0, now.backingStorageSize ?? 0);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      })();
    }
    if (options.has('cpuprofile')) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
    }
    await page.evaluate('window.startDrive()');
    result = await pending;
    watching = false;
    await watch;
    if (options.has('cpuprofile')) {
      const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: CpuProfile };
      cpu = summariseProfile(profile);
      printProfile('the drive', cpu);
      saveProfile(profile, options.get('cpuprofile'));
    }
  } else {
    result = await pending;
  }
  console.log(
    `seed ${seedText}, ${request.width}x${request.height} at ${dpr}x, ${request.quality ?? 'full'} quality, ` +
      `${request.view ?? 'top-down'} view`,
  );
  for (const [kind, batch] of Object.entries(result.kinds).sort((a, b) => b[1].vertices - a[1].vertices)) {
    console.log(`  ${kind}: ${batch.batches} batches, ${batch.parts} parts, ${(batch.vertices / 1e3).toFixed(0)}k vertices`);
  }
  report('still', result.still);
  report('drive', result.drive);
  reportPopIn(result.drive);
  if (request.passes === true && !result.timed) console.log('the adapter offers no timestamp queries; no pass was timed');
  if (result.timed) {
    reportPasses('still', result.still);
    reportPasses('drive', result.drive);
  }
  const shaderDir = options.get('shaders');
  if (shaderDir !== undefined && result.shaders !== undefined) {
    mkdirSync(shaderDir, { recursive: true });
    const { vertex, fragment } = result.shaders;
    vertex.forEach((code, i) => writeFileSync(join(shaderDir, `${i}.vert.wgsl`), code));
    fragment.forEach((code, i) => writeFileSync(join(shaderDir, `${i}.frag.wgsl`), code));
    console.log(`${vertex.length} vertex and ${fragment.length} fragment stages written to ${shaderDir}`);
  }
  const json = options.get('json');
  if (json !== undefined) {
    const series: Record<string, number[]> = {};
    for (const [phase, samples] of [['still', result.still], ['drive', result.drive]] as const) {
      for (const field of ['totalMs', 'cpuMs', 'updateMs'] as const) {
        series[`${phase} ${field.replace('Ms', '')}`] = samples.map((s) => s[field]);
      }
      if (result.timed) for (const [label, values] of passSeries(samples)) series[`${phase} ${label}`] = values;
    }
    saveRun(json, {
      tool: 'render-profile',
      label: args.filter((a) => !a.startsWith('--json')).join(' ') || seedText,
      series,
      ...(cpu === undefined ? {} : { cpu: { areas: cpu.areas, files: cpu.files } }),
    });
  }
  const memory = result.memory;
  if (memory !== undefined && heap !== undefined) {
    const gpu = memory.settled;
    console.log(
      `memory settled: gpu ${mb(gpu.total)} (vertex ${mb(gpu.vertex)}, index ${mb(gpu.index)}, ` +
        `textures ${mb(gpu.textures)}, other buffers ${mb(gpu.otherBuffers)}) | ` +
        `js heap ${mb(heap.settled.usedSize)}, typed arrays ${mb(heap.settled.backingStorageSize ?? 0)}, ` +
        `of them scene geometry ${mb(memory.geometry)}`,
    );
    console.log(
      `memory drive peak: gpu ${mb(memory.drivePeak)} | js heap ${mb(heap.peak.usedSize)}, ` +
        `typed arrays ${mb(heap.peak.backingStorageSize ?? 0)}`,
    );
  }
} finally {
  await browser.close();
  await server?.close();
}

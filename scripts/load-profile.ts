/**
 * Time the load of a new game, step by step, on this machine's GPU.
 *
 * `main.ts` marks each step of the load on the page's timeline as
 * `load <step>`. This builds the game as it is deployed, serves it, opens it in
 * Chrome, starts a new game and prints how long each step took. It also prints
 * what the page downloaded, and with `--cpuprofile` where the main thread spent
 * the wait. `docs/loading.md` has what the first runs found.
 *
 * Usage: node scripts/load-profile.ts [seed] [--option=value]
 *   --from=title   open the title screen, press New game and Play. Default.
 *                  The world of the seed starts building as the menu opens.
 *   --from=link    open the page straight into the seed, as Regenerate and the
 *                  import of a save do. Nothing is built before the page loads.
 *   --idle=<ms>    wait this long on the title screen before pressing Play,
 *                  as a player choosing a look does. Default 0.
 *   --runs=<n>     load the page this many times and print each. Default 3.
 *   --dev          serve through the Vite dev server rather than the build.
 *   --cpu-slowdown=N  run the page N times slower. Chrome does not slow a worker.
 *   --device=phone the screen of an iPhone 13 Pro held sideways, 844x390 at 3x.
 *   --cpuprofile   profile the main thread from Play to the city, and list where
 *                  its time went. --cpuprofile=load.cpuprofile also writes it.
 *
 * Every run is a fresh browser profile, so nothing is cached between runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { build, createServer, preview } from 'vite';
import { chromiumPath } from './chromium.ts';
import { printProfile, saveProfile, summariseProfile, type CpuProfile } from './cpu-profile.ts';

const args = process.argv.slice(2);
const seed = args.find((a) => !a.startsWith('--')) ?? 'sunset';
const options = new Map<string, string>(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const eq = a.indexOf('=');
      return eq === -1 ? [a.slice(2), 'true'] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);
const from = options.get('from') ?? 'title';
if (from !== 'title' && from !== 'link') throw new Error(`--from wants title or link, not ${from}`);
const idle = Number(options.get('idle') ?? 0);
const runs = Number(options.get('runs') ?? 3);
const phone = options.get('device') === 'phone';
const viewport = phone ? { width: 844, height: 390 } : { width: 1600, height: 900 };

/** A mark of `main.ts`, or a line the loading screen said, in ms from navigation. */
interface Event {
  name: string;
  at: number;
}

/** What a page downloaded: its path, its bytes over the wire and when it ended. */
interface Download {
  name: string;
  bytes: number;
  end: number;
}

interface Load {
  marks: Event[];
  steps: Event[];
  downloads: Download[];
}

/** The page's own marks and downloads, once the city is on screen. */
async function readLoad(page: Page): Promise<Omit<Load, 'steps'>> {
  return page.evaluate(() => ({
    marks: performance
      .getEntriesByType('mark')
      .filter((m) => m.name.startsWith('load '))
      .map((m) => ({ name: m.name.slice(5), at: m.startTime })),
    downloads: (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((r) => ({
      name: new URL(r.name).pathname,
      bytes: r.encodedBodySize,
      end: r.responseEnd,
    })),
  }));
}

/** Watch the loading screen's step, so the count of chunks and shaders is in the report. */
const WATCH_STEPS = `
  new MutationObserver(() => {
    const step = document.querySelector('.loading-step');
    const text = step?.textContent ?? '';
    if (text !== '' && window.__steps.at(-1)?.name !== text) window.__steps.push({ name: text, at: performance.now() });
  }).observe(document, { subtree: true, childList: true, characterData: true });
`;

async function loadOnce(url: string, run: number): Promise<Load> {
  const dir = mkdtempSync(join(tmpdir(), 'load-profile-'));
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: chromiumPath({ hardware: true }),
    headless: true,
    viewport,
    deviceScaleFactor: phone ? 3 : 1,
    args: ['--enable-unsafe-webgpu', '--enable-gpu'],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
    await page.addInitScript(`window.__steps = []; addEventListener('DOMContentLoaded', () => { ${WATCH_STEPS} });`);
    const cdp = await context.newCDPSession(page);
    const slowdown = Number(options.get('cpu-slowdown') ?? 1);
    if (slowdown > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: slowdown });
    if (from === 'link') {
      // The pending start of `saves.ts`, which a page reads before its title screen.
      const start = JSON.stringify(JSON.stringify({ seed, load: false }));
      await page.addInitScript(`sessionStorage.setItem('sunset-driver.start', ${start});`);
      await page.goto(`${url}#${encodeURIComponent(seed)}`, { waitUntil: 'commit' });
    } else {
      await page.goto(`${url}#${encodeURIComponent(seed)}`, { waitUntil: 'commit' });
      await page.getByText('New game').click({ timeout: 120_000 });
      if (idle > 0) await page.waitForTimeout(idle);
    }
    const profiling = run === 0 && options.has('cpuprofile');
    if (profiling) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
      await cdp.send('Profiler.start');
    }
    if (from === 'title') await page.locator('.title-cta').click();
    await page.waitForFunction(() => performance.getEntriesByName('load shaders').length > 0, undefined, {
      timeout: 600_000,
      polling: 100,
    });
    if (profiling) {
      const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: CpuProfile };
      printProfile('the load, from Play to the city', summariseProfile(profile));
      saveProfile(profile, options.get('cpuprofile'));
    }
    const load = await readLoad(page);
    const steps = (await page.evaluate('window.__steps')) as Event[];
    return { ...load, steps };
  } finally {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const s = (ms: number): string => `${(ms / 1000).toFixed(2)} s`.padStart(8);

/**
 * The loading screen's steps, one line each: a step that counts, as the
 * shaders do, is kept at its last count and at the time it reached it.
 */
function lastOfEach(steps: readonly Event[]): Event[] {
  const kept: Event[] = [];
  for (const step of steps) {
    const kind = step.name.split(' · ')[0];
    const previous = kept.at(-1);
    if (previous !== undefined && previous.name.split(' · ')[0] === kind) kept.pop();
    kept.push(step);
  }
  return kept;
}

/** Each mark with the time since the one before it, so a step reads as what it cost. */
function report(load: Load, run: number): void {
  console.log(`\nrun ${run + 1}:     at    took`);
  const events = [
    ...load.marks.map((m) => ({ ...m, mark: true })),
    ...lastOfEach(load.steps).map((m) => ({ ...m, mark: false })),
  ];
  events.sort((a, b) => a.at - b.at);
  let before = 0;
  for (const event of events) {
    if (event.mark) {
      console.log(`  ${s(event.at)} ${s(event.at - before)}  ${event.name}`);
      // Rapier loads beside the graphics, so its mark is not a step of the chain.
      if (event.name !== 'physics') before = event.at;
    } else {
      console.log(`  ${s(event.at)}           · screen: ${event.name}`);
    }
  }
}

/** The files the page fetched, the largest first. */
function reportDownloads(downloads: readonly Download[]): void {
  const total = downloads.reduce((sum, d) => sum + d.bytes, 0);
  console.log(`\ndownloaded ${(total / 2 ** 20).toFixed(2)} MB over the wire, in ${downloads.length} files:`);
  for (const d of [...downloads].sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
    console.log(`  ${(d.bytes / 1024).toFixed(0).padStart(6)} kB  done at ${s(d.end)}  ${d.name}`);
  }
}

const dist = mkdtempSync(join(tmpdir(), 'load-profile-dist-'));
let close: () => Promise<void>;
let url: string | undefined;
if (options.has('dev')) {
  const server = await createServer({ server: { port: 0 }, logLevel: 'warn' });
  await server.listen();
  url = server.resolvedUrls?.local[0];
  close = () => server.close();
} else {
  await build({ logLevel: 'warn', build: { outDir: dist, emptyOutDir: true } });
  const server = await preview({ logLevel: 'warn', build: { outDir: dist }, preview: { port: 0 } });
  url = server.resolvedUrls?.local[0];
  close = () => server.close();
}
try {
  if (url === undefined) throw new Error('The server started without a local address.');
  console.log(`seed ${seed}, from the ${from}, ${options.has('dev') ? 'dev server' : 'build'}, ${viewport.width}x${viewport.height}`);
  let last: Load | undefined;
  for (let run = 0; run < runs; run++) {
    last = await loadOnce(url, run);
    report(last, run);
  }
  if (last !== undefined) reportDownloads(last.downloads);
} finally {
  await close();
  rmSync(dist, { recursive: true, force: true });
}

/**
 * Measure what the audio of spec section 15 makes, since a headless run has no
 * ears.
 *
 * It serves the project with Vite, opens `scripts/audio-check.html` in a
 * headless Chromium, and renders each case of `src/audio/offline.ts` through an
 * offline audio context. One line per case: its peak, its loudness and how much
 * of it was silence.
 *
 * It fails when a case that should make a sound is silent, or when one clips,
 * which is what a voice that was never connected, an envelope that never opened
 * and a mix that is too hot all look like from here. It also fails when a siren
 * or a gunshot peaks under the idling engine.
 *
 * Usage: node scripts/audio-check.ts
 *
 * The browser comes from Playwright, as the render previews' does.
 */
import { chromium, type Browser } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { chromiumPath } from './chromium.ts';
import type { AudioLevel } from '../src/audio/offline.ts';

/**
 * An offline context renders without a sound device, but Chromium still holds a
 * page's audio until it has been clicked on. Nothing clicks on this one.
 */
const CHROMIUM_FLAGS = ['--autoplay-policy=no-user-gesture-required'];

const TIMEOUT_MS = 120_000;

/** The case that is meant to be silent. Every other one has to make a sound. */
const SILENT_CASE = 'nothing';

/** Under this peak a case counts as silent, and over 1 it clips. */
const AUDIBLE = 0.01;

/**
 * Cases that must peak over the player's own idling engine. A police car 20 m
 * off and a rifle in the player's hands are what a chase is heard by, and the
 * engine is held under the rest of the mix (spec section 15).
 */
const OVER_THE_ENGINE = ['one siren', 'gunshot'];
const ENGINE = 'engine idling';

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let failed = false;
try {
  server = await createServer({ server: { port: 0 }, logLevel: 'warn' });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error('Vite started without a local address.');

  browser = await chromium.launch({ executablePath: chromiumPath(), args: CHROMIUM_FLAGS });
  const page = await browser.newPage();
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  await page.goto(new URL('scripts/audio-check.html', url).href, { timeout: TIMEOUT_MS });
  await page.waitForFunction('window.audioCheckReady === true', undefined, { timeout: TIMEOUT_MS });
  const levels = await page.evaluate<AudioLevel[]>(
    // @ts-expect-error the page attaches `renderAudioCases`; the driver has no DOM types.
    () => window.renderAudioCases(),
  );

  for (const level of levels) {
    const silent = level.peak < AUDIBLE;
    const wanted = level.name === SILENT_CASE ? silent : !silent && level.peak <= 1;
    if (!wanted) failed = true;
    console.log(
      `${wanted ? ' ok ' : 'FAIL'}  ${level.name.padEnd(18)} peak ${level.peak.toFixed(3)}` +
        `  rms ${level.rms.toFixed(4)}  silent ${(level.quiet * 100).toFixed(0)}%`,
    );
  }
  const engine = levels.find((level) => level.name === ENGINE)?.peak ?? 0;
  for (const name of OVER_THE_ENGINE) {
    const peak = levels.find((level) => level.name === name)?.peak ?? 0;
    if (peak >= engine) continue;
    failed = true;
    console.log(`FAIL  ${name} peaks at ${peak.toFixed(3)}, under the ${ENGINE} at ${engine.toFixed(3)}`);
  }
  if (failures.length > 0) {
    failed = true;
    console.error(`page errors:\n  ${failures.join('\n  ')}`);
  }
} finally {
  await browser?.close();
  await server?.close();
}
process.exitCode = failed ? 1 : 0;

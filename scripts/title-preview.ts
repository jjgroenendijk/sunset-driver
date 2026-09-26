/**
 * Take a picture of the title screen at three window shapes: a desktop, a
 * phone held upright and a phone held sideways. The phones are emulated with
 * touch, so the page takes the layout `touch.css` gives a phone.
 *
 * Usage: node scripts/title-preview.ts <out-prefix> [--wait=9000]
 *
 * It writes `<out-prefix>-desk.png`, `-phone.png` and `-land.png`, and prints
 * any error or warning the page logged, less the audio context's.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { chromiumPath } from './chromium.ts';

const out = process.argv[2];
if (out === undefined) {
  console.error('Usage: node scripts/title-preview.ts <out-prefix> [--wait=9000]');
  process.exit(1);
}
/** Milliseconds to let the page start and the camera settle before the picture. */
const wait = Number(process.argv.find((arg) => arg.startsWith('--wait='))?.slice('--wait='.length) ?? 9000);

const SHAPES = [
  ['desk', { viewport: { width: 1440, height: 900 } }],
  ['phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }],
  ['land', { viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }],
] as const;

const server = await createServer({ server: { port: 0 }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls?.local[0] ?? 'http://localhost:5173/';
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu'],
});
try {
  for (const [name, options] of SHAPES) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      if (message.text().includes('AudioContext')) return;
      console.log(`${name} ${message.type()}: ${message.text().slice(0, 300)}`);
    });
    page.on('pageerror', (error) => console.log(`${name} pageerror: ${error.message}`));
    await page.goto(url);
    await page.waitForTimeout(wait);
    await page.screenshot({ path: `${out}-${name}.png` });
    console.log(`${out}-${name}.png`);
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}

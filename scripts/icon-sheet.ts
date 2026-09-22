/**
 * Draw every map icon on one sheet, at the size the full map draws it and at
 * the size the minimap does.
 *
 * Usage: node scripts/icon-sheet.ts [out.png] [--sizes=11,18,30]
 *
 * The browser comes from Playwright, as it does for `map-preview.ts`.
 */
import { chromium, type Browser } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import type { IconSheetRequest, IconSheetResult } from '../src/ui/icon-sheet.ts';
import { chromiumPath } from './chromium.ts';
import { defaultOut, writePng } from './png.ts';

const TIMEOUT_MS = 120_000;
const args = process.argv.slice(2);
const sizes = (args.find((a) => a.startsWith('--sizes='))?.slice(8) ?? '11,18,30').split(',').map(Number);
if (sizes.some((s) => !Number.isFinite(s) || s <= 0)) throw new Error('--sizes wants a list of pixel sizes.');
const out = args.find((a) => !a.startsWith('--')) ?? defaultOut('map-icons.png');
const request: IconSheetRequest = { width: 700, sizes };

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
try {
  server = await createServer({ server: { port: 0 }, logLevel: 'warn' });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error('Vite started without a local address.');
  browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ viewport: { width: request.width, height: 800 } });
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  await page.goto(new URL('scripts/icon-sheet.html', url).href, { timeout: TIMEOUT_MS });
  await page.waitForFunction('window.sheetReady === true', undefined, { timeout: TIMEOUT_MS });
  const result = await page.evaluate<IconSheetResult, IconSheetRequest>(
    // @ts-expect-error the page attaches `renderIconSheet`; the driver has no DOM types.
    (req) => window.renderIconSheet(req),
    request,
  );
  if (failures.length > 0) console.error(`page errors:\n  ${failures.join('\n  ')}`);
  writePng(out, result.width, result.height, new Uint8Array(Buffer.from(result.rgb, 'base64')));
  console.log(`${out}: ${result.width}x${result.height}, every icon at ${sizes.join(', ')} px`);
} finally {
  await browser?.close();
  await server?.close();
}

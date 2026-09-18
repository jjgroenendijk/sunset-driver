/**
 * Start the Chrome DevTools MCP server on the browser the previews use.
 *
 * `.mcp.json` runs this. The server looks for Chrome stable by default, and a
 * cloud container has only the cached Chromium, so the path comes from
 * `scripts/chromium.ts`. A hardware adapter is asked for: an installed Chrome
 * draws a frame the way a player sees it.
 *
 * Each session gets a temporary profile, because sessions in parallel
 * worktrees would otherwise fight over one. With no display the browser runs
 * headless and draws WebGPU through SwiftShader, as `render-preview.ts` does.
 *
 * The server reports usage to Google and sends trace URLs to the CrUX API by
 * default. A trace of a local build has no field data, so both are off.
 *
 * Standard output carries the MCP protocol, so this script prints nothing.
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { chromiumPath } from './chromium.ts';

/** The server release. Raise it by hand, as with any dependency. */
const VERSION = '1.9.0';

const headless = platform() === 'linux' && (process.env.DISPLAY ?? '') === '';

const chromeArgs = headless
  ? [
      '--enable-unsafe-webgpu',
      '--enable-unsafe-swiftshader',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--disable-vulkan-surface',
    ]
  : ['--enable-unsafe-webgpu'];

const args = [
  '-y',
  `chrome-devtools-mcp@${VERSION}`,
  `--executablePath=${chromiumPath({ hardware: true })}`,
  '--isolated',
  '--no-usage-statistics',
  '--no-performance-crux',
  ...(headless ? ['--headless'] : []),
  ...chromeArgs.map((flag) => `--chrome-arg=${flag}`),
  ...process.argv.slice(2),
];

const child = spawn(platform() === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 0 : 1));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}

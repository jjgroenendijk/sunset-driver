/**
 * Find a Chromium to drive. The previews and the profiler all need one, and
 * finding it is the same problem three times.
 *
 * `playwright-core` ships no browser of its own: it names the build it was
 * released against, and the machine holds whatever build some earlier install
 * put there. The two disagree after every `playwright-core` bump, so the named
 * path is a hint, not an answer. The browser cache is searched for any build,
 * and an installed Chrome is taken when the cache holds none.
 *
 * `CHROMIUM_PATH` overrides all of it.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

/** Where `playwright install` puts browsers when nothing says otherwise. */
function cacheRoots(): string[] {
  const roots: string[] = [];
  const fromEnv = process.env.PLAYWRIGHT_BROWSERS_PATH;
  // `0` means "beside the package", which is the path playwright already names.
  if (fromEnv !== undefined && fromEnv !== '' && fromEnv !== '0') roots.push(fromEnv);
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      roots.push(join(home, 'Library', 'Caches', 'ms-playwright'));
      break;
    case 'win32': {
      const local = process.env.LOCALAPPDATA;
      if (local !== undefined && local !== '') roots.push(join(local, 'ms-playwright'));
      break;
    }
    default:
      roots.push(join(home, '.cache', 'ms-playwright'));
  }
  return roots.filter((root) => existsSync(root));
}

/** The binary inside one unpacked build, whichever platform packed it. */
const LAYOUTS = [
  join('chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join('chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join('chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  join('chrome-linux64', 'chrome'),
  join('chrome-linux', 'chrome'),
  join('chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
  join('chrome-headless-shell-linux64', 'chrome-headless-shell'),
  join('chrome-win', 'chrome.exe'),
  join('chrome-win64', 'chrome.exe'),
];

/** The build number a cache directory carries, for newest-first order. */
function buildNumber(entry: string): number {
  const digits = entry.slice(entry.lastIndexOf('-') + 1);
  const value = Number.parseInt(digits, 10);
  return Number.isNaN(value) ? 0 : value;
}

/** Every Chromium in the browser cache, newest build first. */
function cached(): string[] {
  const found: string[] = [];
  for (const root of cacheRoots()) {
    const builds = readdirSync(root)
      // The headless shell draws no WebGPU, so a full build is taken first.
      .filter((entry) => entry.startsWith('chromium-') || entry.startsWith('chromium_headless_shell-'))
      .sort((a, b) => {
        const full = Number(b.startsWith('chromium-')) - Number(a.startsWith('chromium-'));
        return full !== 0 ? full : buildNumber(b) - buildNumber(a);
      });
    for (const build of builds) {
      for (const layout of LAYOUTS) {
        const candidate = join(root, build, layout);
        if (existsSync(candidate)) found.push(candidate);
      }
    }
  }
  return found;
}

/** The browsers a person installs, which is what a hardware adapter needs. */
function installed(): string[] {
  switch (platform()) {
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ];
    case 'win32':
      return [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ];
    default:
      return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
      ];
  }
}

/** The path playwright names, which is right only while the versions agree. */
function expected(): string[] {
  try {
    return [chromium.executablePath()];
  } catch {
    return [];
  }
}

export interface ChromiumOptions {
  /**
   * Ask for a browser with a hardware WebGPU adapter. An installed Chrome is
   * taken first: the cached build falls back to SwiftShader, which draws on the
   * processor and says nothing about a frame.
   */
  hardware?: boolean;
}

/**
 * A Chromium to drive, or an error naming every place that was looked in.
 */
export function chromiumPath(options: ChromiumOptions = {}): string {
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  const order =
    options.hardware === true
      ? [...installed(), ...expected(), ...cached()]
      : [...expected(), ...cached(), ...installed()];
  for (const candidate of order) {
    if (existsSync(candidate)) return candidate;
  }

  const roots = cacheRoots();
  throw new Error(
    [
      'No Chromium found. Run `npx playwright install chromium`, or set CHROMIUM_PATH to a binary.',
      `  browser cache: ${roots.length > 0 ? roots.join(', ') : 'none on this machine'}`,
      `  playwright names: ${expected()[0] ?? 'nothing'}`,
      `  installed browsers tried: ${installed().join(', ')}`,
    ].join('\n'),
  );
}

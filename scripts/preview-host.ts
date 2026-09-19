/**
 * The page the previews draw in: Vite serving the project, a headless Chromium
 * with a WebGPU adapter, and `src/render/preview.ts` loaded in it.
 *
 * `render-preview.ts`, `render-sheet.ts`, `render-check.ts` and the preview
 * server all draw through this, so there is one place that knows how to get a
 * WebGPU adapter out of a headless browser.
 *
 * The graphics card is asked first. SwiftShader draws the same frame on the
 * processor about thirty times slower: 370 s for one frame of seed `sunset`
 * on a laptop, against 4 s on its GPU. It is taken only where there is no card
 * to draw on — a cloud container, a CI runner — or when `software` asks for it.
 */
import { statSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import type { PreviewRequest, PreviewResult } from '../src/render/preview.ts';
import { chromiumPath } from './chromium.ts';

/**
 * What a Chromium needs before it offers an adapter off the graphics card. The
 * installed Chrome is taken first, because a Chromium from the Playwright
 * cache falls back to SwiftShader on its own.
 */
const HARDWARE_FLAGS = ['--enable-unsafe-webgpu', '--enable-gpu'];

/**
 * What a Chromium needs before it offers a SwiftShader adapter. Without them
 * `navigator.gpu.requestAdapter()` returns nothing on a machine with no card.
 */
const SOFTWARE_FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-angle=swiftshader',
  '--disable-vulkan-surface',
];

/** How long one frame may take. SwiftShader draws a whole world slowly. */
export const TIMEOUT_MS = 600_000;

export interface HostOptions {
  /** Draw on SwiftShader even where there is a graphics card, as CI does. */
  software?: boolean;
}

/** What the page reported while a frame was drawn. */
export interface PageFailures {
  /** Errors the page threw. A frame drawn with one is not to be trusted. */
  thrown: string[];
  /**
   * Errors the page wrote to its console. three.js reports WebGPU validation
   * there, and a frame can still be right.
   */
  logged: string[];
}

/** A frame, and what the page reported while it was drawn. */
export interface HostFrame {
  result: PreviewResult;
  failures: PageFailures;
}

export class PreviewHost {
  /** What the page's adapter says it is, such as `apple metal-3` or `google swiftshader`. */
  adapter = '';
  private readonly server: ViteDevServer;
  private readonly browser: Browser;
  private readonly page: Page;
  private readonly failures: PageFailures;
  /** When the page last started loading its modules. */
  private loadedAt: number;

  private constructor(server: ViteDevServer, browser: Browser, page: Page, failures: PageFailures, loadedAt: number) {
    this.server = server;
    this.browser = browser;
    this.page = page;
    this.failures = failures;
    this.loadedAt = loadedAt;
  }

  static async open(options: HostOptions = {}): Promise<PreviewHost> {
    // No hot reload: a module replaced under a frame being drawn is a frame of
    // two builds. `render` reloads the page itself, between frames.
    const server = await createServer({ server: { port: 0, hmr: false }, logLevel: 'warn' });
    await server.listen();
    try {
      const url = server.resolvedUrls?.local[0];
      if (url === undefined) throw new Error('Vite started without a local address.');
      const href = new URL('scripts/render-preview.html', url).href;
      if (options.software !== true) {
        const host = await PreviewHost.launch(server, href, true);
        if (host !== undefined) return host;
      }
      const host = await PreviewHost.launch(server, href, false);
      if (host === undefined) throw new Error('This Chromium offers no WebGPU adapter, not even SwiftShader.');
      return host;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  /** A browser that has an adapter of the kind asked for, or undefined when it has none. */
  private static async launch(server: ViteDevServer, href: string, hardware: boolean): Promise<PreviewHost | undefined> {
    const browser = await chromium.launch({
      executablePath: chromiumPath({ hardware }),
      headless: true,
      args: hardware ? HARDWARE_FLAGS : SOFTWARE_FLAGS,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
      // A page error is the usual failure, and it is silent otherwise: the
      // frame never resolves and the run stops at the timeout with nothing to read.
      const failures: PageFailures = { thrown: [], logged: [] };
      page.on('pageerror', (error) => failures.thrown.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') failures.logged.push(message.text());
      });
      const loadedAt = Date.now();
      await page.goto(href, { timeout: TIMEOUT_MS });
      await page.waitForFunction('window.previewReady === true', undefined, { timeout: TIMEOUT_MS });
      // WebGPU is offered to a secure page only, so the adapter is asked for
      // from the served page rather than from a blank one.
      const adapter = await page.evaluate(async () => {
        const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
        const found = (await gpu?.requestAdapter()) as { info?: Record<string, string> } | null | undefined;
        if (found === null || found === undefined) return undefined;
        const info = found.info ?? {};
        return [info.vendor, info.architecture].filter((part) => part !== undefined && part !== '').join(' ') || 'unnamed';
      });
      if (adapter === undefined) {
        await browser.close();
        return undefined;
      }
      const host = new PreviewHost(server, browser, page, failures, loadedAt);
      host.adapter = adapter;
      return host;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  /**
   * Draw one frame. The page keeps the scene of the last seed and tier, so a
   * second frame of the same seed builds only the chunks round a new place. A
   * source file changed since the page loaded is a page reloaded first.
   */
  async render(request: PreviewRequest): Promise<HostFrame> {
    if (this.changed()) {
      this.loadedAt = Date.now();
      await this.page.reload({ timeout: TIMEOUT_MS });
      await this.page.waitForFunction('window.previewReady === true', undefined, { timeout: TIMEOUT_MS });
    }
    this.failures.thrown.length = 0;
    this.failures.logged.length = 0;
    const result = await this.page.evaluate<PreviewResult, PreviewRequest>(
      // @ts-expect-error the page attaches `renderPreview`; the driver has no DOM types.
      (req) => window.renderPreview(req),
      request,
    );
    return { result, failures: { thrown: [...this.failures.thrown], logged: [...this.failures.logged] } };
  }

  /**
   * Whether a file the page loaded was written since it loaded, and if so,
   * make Vite forget what it built from it. Vite's own watcher would do both,
   * but on macOS its event can come a second after the write, and a run
   * started straight after an edit would draw the code from before it.
   */
  private changed(): boolean {
    let changed = false;
    for (const file of this.server.moduleGraph.fileToModulesMap.keys()) {
      let written: number;
      try {
        written = statSync(file).mtimeMs;
      } catch {
        written = Infinity;
      }
      if (written < this.loadedAt) continue;
      this.server.moduleGraph.onFileChange(file);
      changed = true;
    }
    return changed;
  }

  async close(): Promise<void> {
    await this.browser.close();
    await this.server.close();
  }
}

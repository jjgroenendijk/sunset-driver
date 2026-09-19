/**
 * Fail when the renderer draws nothing.
 *
 * `npm run verify` builds worlds and meshes headless and never opens a WebGPU
 * device, so a change that leaves the game drawing a blank screen passes every
 * check. Only a person looking at a picture catches it. This is that person, as
 * a check: it boots one fixed seed, renders one frame through the harness
 * `scripts/render-preview.ts` already uses, and reads the pixels.
 *
 * Usage: node scripts/render-check.ts [seed]
 *
 * It fails when the page threw, and on three things the pixels say:
 *
 * - A blank frame. A lost device reads back as all zeroes.
 * - A single flat colour. A scene with nothing in it clears to one value.
 * - A frame with no edges in it. The sky alone is a smooth gradient, so it
 *   holds thousands of colours and still means the world was never drawn. Two
 *   pixels side by side differ only where something has an outline, so counting
 *   those is what tells a city from a sky.
 *
 * It does not compare the frame against a stored picture. SwiftShader draws the
 * same scene differently between browser builds, and a reference image would
 * have to be made again on every rendering change.
 *
 * The browser comes from Playwright, as the render previews' does.
 */
import { resolve } from 'node:path';
import type { PreviewRequest } from '../src/render/preview.ts';

// Vite, Playwright and the renderer's own modules are loaded inside `check`
// rather than here, so `test/render-check.test.ts` can measure frames of its
// own without any of them. They are most of what this file costs to import.

/**
 * The frame the check takes, but for the seed and the camera distance, which
 * the renderer's own default supplies. It is small because SwiftShader costs
 * time by the pixel and none of the three failures needs a big picture to show
 * itself, and it is midday because a night frame is dark enough to make every
 * threshold a judgement about the lighting rather than about the geometry.
 */
const FRAME = {
  x: 0,
  y: 0,
  heading: 0,
  speed: 0,
  width: 320,
  height: 180,
  hour: 12,
};

/** Channel bits kept when colours are counted, so near neighbours count once. */
const COLOUR_BITS = 5;

/** How far two channels must differ before the pair counts as an edge. */
const EDGE_STEP = 12;

export interface FrameMetrics {
  /** Distinct colours the frame holds, each channel cut to its top five bits. */
  colours: number;
  /** Share of the frame the commonest of those colours covers, 0 to 1. */
  flattest: number;
  /** Share of side-by-side pairs of pixels that differ, 0 to 1. */
  edges: number;
  /** Mean brightness, 0 to 255, which says whether a frame is merely dark. */
  brightness: number;
}

/**
 * What the pixels say. `rgb` is the rows, top row first, three bytes a pixel,
 * which is what `src/render/preview.ts` hands back.
 */
export function measureFrame(rgb: Uint8Array, width: number, height: number): FrameMetrics {
  const pixels = width * height;
  if (rgb.length < pixels * 3) throw new Error(`${rgb.length} bytes is short of a ${width}x${height} frame`);

  const shift = 8 - COLOUR_BITS;
  const counts = new Uint32Array(1 << (COLOUR_BITS * 3));
  let sum = 0;
  for (let i = 0; i < pixels; i++) {
    const r = rgb[i * 3] ?? 0;
    const g = rgb[i * 3 + 1] ?? 0;
    const b = rgb[i * 3 + 2] ?? 0;
    const bucket = ((r >> shift) << (COLOUR_BITS * 2)) | ((g >> shift) << COLOUR_BITS) | (b >> shift);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    sum += r + g + b;
  }

  let colours = 0;
  let commonest = 0;
  for (let bucket = 0; bucket < counts.length; bucket++) {
    const count = counts[bucket] ?? 0;
    if (count === 0) continue;
    colours++;
    if (count > commonest) commonest = count;
  }

  // Pairs are counted across a row only, so the walk never crosses from the end
  // of one row to the start of the next, where neighbouring bytes are not
  // neighbouring pixels. A frame one pixel wide holds no pair at all, and is
  // reported as having no edges rather than as NaN, which would pass the check.
  let different = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const here = (y * width + x) * 3;
      const left = here - 3;
      const step = Math.max(
        Math.abs((rgb[here] ?? 0) - (rgb[left] ?? 0)),
        Math.abs((rgb[here + 1] ?? 0) - (rgb[left + 1] ?? 0)),
        Math.abs((rgb[here + 2] ?? 0) - (rgb[left + 2] ?? 0)),
      );
      if (step >= EDGE_STEP) different++;
    }
  }

  return {
    colours,
    flattest: commonest / pixels,
    edges: width > 1 ? different / (height * (width - 1)) : 0,
    brightness: sum / (pixels * 3),
  };
}

/**
 * What a frame has to hold before the renderer counts as having drawn it.
 *
 * They are set well under what a real frame measures, so a change to the
 * lighting, the camera or the seed cannot bring one down to the line. The
 * numbers a real frame gives are in `docs/dev-tooling.md`.
 */
const LIMITS = {
  /** Distinct colours. A blank frame holds one. */
  colours: 64,
  /** Share one colour may cover. A blank frame is all of it. */
  flattest: 0.9,
  /** Share of side-by-side pairs that differ. Sky alone gives almost none. */
  edges: 0.02,
};

/** What is wrong with the frame, one line each, and nothing when it is a frame. */
export function judgeFrame(metrics: FrameMetrics): string[] {
  const wrong: string[] = [];
  if (metrics.colours < LIMITS.colours) {
    wrong.push(`${metrics.colours} colours, under ${LIMITS.colours}: the frame is blank or nearly so`);
  }
  if (metrics.flattest > LIMITS.flattest) {
    wrong.push(`one colour covers ${(metrics.flattest * 100).toFixed(1)}% of the frame, over ${LIMITS.flattest * 100}%`);
  }
  if (metrics.edges < LIMITS.edges) {
    wrong.push(
      `${(metrics.edges * 100).toFixed(2)}% of pixel pairs differ, under ${LIMITS.edges * 100}%:` +
        ' nothing in the frame has an outline, so the world was never drawn',
    );
  }
  return wrong;
}

/**
 * Render one frame of `seed` and say what the pixels hold.
 *
 * A page error is an uncaught exception, and it fails the check. What the page
 * writes to its console does not: three.js reports WebGPU validation there, and
 * much of it costs the frame nothing. Validation that does break the frame —
 * issue #339 blanks it on some Chromium builds — shows up in the pixels, which
 * is why they are what the verdict is made of. The console is printed either
 * way, because it usually names the cause.
 */
async function check(seedText: string): Promise<boolean> {
  const { seedFromString } = await import('../src/core/rng.ts');
  const { BASE_DISTANCE } = await import('../src/render/camera.ts');
  const { PreviewHost } = await import('./preview-host.ts');

  // SwiftShader on every machine, because that is what CI draws on, and the
  // thresholds below were measured on its frames.
  const host = await PreviewHost.open({ software: true });
  try {
    const request: PreviewRequest = { seed: seedFromString(seedText), distance: BASE_DISTANCE, ...FRAME };
    const { result, failures } = await host.render(request);

    const metrics = measureFrame(new Uint8Array(Buffer.from(result.rgb, 'base64')), result.width, result.height);
    const wrong = judgeFrame(metrics);
    console.log(
      `${wrong.length === 0 ? ' ok ' : 'FAIL'}  seed ${seedText} at ${result.width}x${result.height}:` +
        ` ${metrics.colours} colours, flattest ${(metrics.flattest * 100).toFixed(1)}%,` +
        ` edges ${(metrics.edges * 100).toFixed(2)}%, brightness ${metrics.brightness.toFixed(1)}` +
        ` — frame ${result.frameMs.toFixed(0)} ms`,
    );
    for (const line of wrong) console.error(`  ${line}`);
    if (failures.logged.length > 0) {
      console.error(`page console errors (${failures.logged.length}), first:\n  ${failures.logged[0]}`);
    }
    if (failures.thrown.length > 0) console.error(`the page threw:\n  ${failures.thrown.join('\n  ')}`);

    return wrong.length === 0 && failures.thrown.length === 0;
  } finally {
    await host.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = (await check(process.argv[2] ?? 'sunset')) ? 0 : 1;
}

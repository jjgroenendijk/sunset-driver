/**
 * Draw what the renderer makes of many seeds as one PNG, in a grid.
 *
 * Usage: node scripts/render-sheet.ts [count] [out.png] [--cols=3] [--tile=480]
 *            [--hour=12] [--seeds=7,9,11] [--x=0] [--y=0] [--distance=..] [--quality=..]
 *            [--weather=clear|rain|fog|storm|seed]
 *            [--software]
 *
 * It draws on the graphics card where there is one, as `preview-host.ts` says;
 * `--software` draws on SwiftShader, as CI does.
 *
 * `terrain-sheet.ts` says why this exists, for the terrain: one preview per
 * seed hides that the maps look alike. The same is true of the rendered frame,
 * and a frame costs far more to make, so the sheet also saves the browser being
 * started once per seed.
 *
 * This is for comparing seeds. A change to the rendering itself is still judged
 * on a full-size frame from `render-preview.ts`; a tile is too small to see a
 * shadow edge or a material in.
 *
 * The seeds are the seeds of the sweep, in order, so a tile on the sheet is a
 * world the tests read. `--seeds` names them instead, for looking at the ones a
 * failure named.
 */
import { seedFromString } from '../src/core/rng.ts';
import { BASE_DISTANCE } from '../src/render/camera/camera.ts';
import type { PreviewRequest } from '../src/render/preview/preview.ts';
import { sweepSeeds } from '../test/support/helpers.ts';
import { defaultOut, writePng } from './png.ts';
import { PreviewHost } from './preview-host.ts';

/** Pixels of gutter between tiles. */
const GAP = 4;

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const option = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const num = (name: string, fallback: number): number => {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} wants a number, not ${raw}`);
  return value;
};

const named = option('seeds');
const count = Number(positional[0] ?? 6);
const seeds = named === undefined ? sweepSeeds(count) : named.split(',').map((s) => seedFromString(s.trim()));
const out = positional[1] ?? defaultOut('render-sheet.png');
const cols = Math.max(1, num('cols', 3));
const tileWidth = Math.max(64, num('tile', 480));
// The game draws 16:9, and a tile that does not is a tile of a different frame.
const tileHeight = Math.round((tileWidth * 9) / 16);

const rows = Math.ceil(seeds.length / cols);
const width = cols * tileWidth + (cols + 1) * GAP;
const height = rows * tileHeight + (rows + 1) * GAP;
const sheet = new Uint8Array(width * height * 3).fill(24);

/** Copy one frame into its cell, sampling if the page gave a different size. */
function blit(rgb: Uint8Array, from: { width: number; height: number }, left: number, top: number): void {
  for (let py = 0; py < tileHeight; py++) {
    const sy = from.height === tileHeight ? py : Math.min(from.height - 1, Math.floor((py / tileHeight) * from.height));
    for (let px = 0; px < tileWidth; px++) {
      const sx = from.width === tileWidth ? px : Math.min(from.width - 1, Math.floor((px / tileWidth) * from.width));
      const source = (sy * from.width + sx) * 3;
      const target = ((top + py) * width + left + px) * 3;
      sheet[target] = rgb[source]!;
      sheet[target + 1] = rgb[source + 1]!;
      sheet[target + 2] = rgb[source + 2]!;
    }
  }
}

const started = performance.now();
const lines: string[] = [];
const host = await PreviewHost.open({ software: args.includes('--software') });
const failures: string[] = [];
try {
  for (let k = 0; k < seeds.length; k++) {
    const seed = seeds[k]!;
    const request: PreviewRequest = {
      seed,
      x: num('x', 0),
      y: num('y', 0),
      distance: num('distance', BASE_DISTANCE),
      heading: (num('heading', 0) * Math.PI) / 180,
      speed: 0,
      width: tileWidth,
      height: tileHeight,
      hour: num('hour', 12),
      ...(option('quality') === undefined ? {} : { quality: option('quality') as string }),
      ...(option('weather') === undefined ? {} : { weather: option('weather') as string }),
    };
    // One page for every seed: the browser and the device are the slow part to
    // build, and the page builds the world for each seed anyway.
    const frame = await host.render(request);
    const result = frame.result;
    const errors = [...frame.failures.thrown, ...frame.failures.logged];
    failures.push(...errors);
    const col = k % cols;
    const row = Math.floor(k / cols);
    blit(
      new Uint8Array(Buffer.from(result.rgb, 'base64')),
      result,
      GAP + col * (tileWidth + GAP),
      GAP + row * (tileHeight + GAP),
    );
    lines.push(
      `  row ${row + 1} col ${col + 1}: seed ${seed} — world ${result.worldMs.toFixed(0)} ms,` +
        ` chunks ${result.chunkMs.toFixed(0)} ms, frame ${result.frameMs.toFixed(0)} ms,` +
        ` ${result.peakDrawCalls} draw calls, ${result.quality} quality,` +
        ` ${result.traffic} traffic, ${result.pedestrians} pedestrians` +
        (errors.length > 0 ? `, ${errors.length} page error(s)` : ''),
    );
  }
  if (failures.length > 0) console.error(`page errors:\n  ${failures.join('\n  ')}`);
} finally {
  await host.close();
}

writePng(out, width, height, sheet);
console.log(
  `${out}: ${width}x${height}, ${seeds.length} seeds in ${cols} columns,` +
    ` ${((performance.now() - started) / 1000).toFixed(1)} s on ${host.adapter}`,
);
for (const line of lines) console.log(line);

/**
 * Draw the terrain of many seeds as one PNG: land against water, one small map
 * per seed, in a grid. This is how the terrain archetypes of spec section 7.2
 * are compared, because one preview per seed hides that the maps look alike.
 *
 * Usage: node scripts/terrain-sheet.ts [count] [out.png] [--cols=6] [--tile=160] [--archetype=name]
 *
 * The seeds are the seeds of the sweep, in order, so a map on the sheet is a map
 * the tests read. Each tile shows its whole map, whatever the map's size. The
 * console lists the tiles row by row with the seed, the archetype and the land
 * fraction. `--archetype` builds every seed on that one archetype instead of the
 * one the seed draws, which is how the numbers of one archetype are tuned.
 */
import { archetypeNamed, ARCHETYPES, type ArchetypeName } from '../src/world/archetype.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { worldSizeFor } from '../src/world/size.ts';
import { generateTerrain, layoutTerrain, SEA_LEVEL, TERRAIN_CELL } from '../src/world/terrain.ts';
import { sweepSeeds } from '../test/helpers.ts';
import { landFraction } from './layout-metrics.ts';
import { defaultOut, writePng } from './png.ts';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name: string, fallback: number): number => {
  const text = args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  return text === undefined ? fallback : Number(text);
};
const count = Number(positional[0] ?? 24);
const out = positional[1] ?? defaultOut('terrain-sheet.png');
const cols = flag('cols', 6);
const tile = flag('tile', 160);
const forced = args.find((a) => a.startsWith('--archetype='))?.slice('--archetype='.length);
if (forced !== undefined && !ARCHETYPES.some((a) => a.name === forced)) {
  throw new Error(`no archetype ${forced}: ${ARCHETYPES.map((a) => a.name).join(', ')}`);
}
/** Pixels of gutter between tiles. */
const GAP = 4;

const rows = Math.ceil(count / cols);
const width = cols * tile + (cols + 1) * GAP;
const height = rows * tile + (rows + 1) * GAP;
const rgb = new Uint8Array(width * height * 3).fill(24);

const t0 = performance.now();
const seeds = sweepSeeds(count);
const lines: string[] = [];
for (let k = 0; k < seeds.length; k++) {
  const seed = seeds[k] as number;
  const size = worldSizeFor(seed, TERRAIN_CELL);
  const layout = forced === undefined ? layoutTerrain(seed, size) : layoutTerrain(seed, size, archetypeNamed(forced as ArchetypeName));
  const hf = generateTerrain(seed, layout);
  const col = k % cols;
  const row = Math.floor(k / cols);
  const left = GAP + col * (tile + GAP);
  const top = GAP + row * (tile + GAP);
  drawTile(hf, left, top);
  const fraction = landFraction(hf.toData(), SEA_LEVEL);
  lines.push(
    `  row ${row + 1} col ${col + 1}: seed ${seed}, ${layout.archetype.name}, ` +
      `${layout.islands.length} islands, ${(fraction * 100).toFixed(0)} % land`,
  );
}
writePng(out, width, height, rgb);
console.log(`${count} seeds in ${((performance.now() - t0) / 1000).toFixed(1)} s → ${out}`);
for (const line of lines) console.log(line);

/** One map, north up, sampled at the middle of each pixel: sea in blue, land shaded by height. */
function drawTile(hf: Heightfield, left: number, top: number): void {
  const extent = hf.extent;
  for (let py = 0; py < tile; py++) {
    const y = hf.originY + ((tile - 1 - py + 0.5) / tile) * extent;
    for (let px = 0; px < tile; px++) {
      const x = hf.originX + ((px + 0.5) / tile) * extent;
      const h = hf.sample(x, y);
      const o = ((top + py) * width + left + px) * 3;
      if (h < SEA_LEVEL) {
        const d = Math.min(1, -h / 16);
        rgb[o] = 30;
        rgb[o + 1] = 90 - d * 40;
        rgb[o + 2] = 160 - d * 60;
      } else {
        const t = Math.min(1, h / 140);
        rgb[o] = 90 + t * 140;
        rgb[o + 1] = 150 - t * 20;
        rgb[o + 2] = 70 + t * 110;
      }
    }
  }
}

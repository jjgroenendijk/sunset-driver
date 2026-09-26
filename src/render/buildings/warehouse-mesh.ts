/**
 * A warehouse, in all its variants (spec section 10.3).
 *
 * The industrial zone is built of these, and from above a warehouse is its
 * roof: a low gable, or the sawtooth whose glazed faces all look the same way.
 * The walls are corrugated metal, and the loading docks stand along the front
 * with a roller door each and a painted bay on the ground.
 */
import type { BuildingMassing } from './building-mesh.ts';
import {
  ALL_SIDES,
  BLOCK_GLASS,
  BLOCK_METAL,
  BLOCK_PAINT,
  BLOCK_TRIM,
  EAVES,
  STOREY,
  band,
  box,
  door,
  gable,
  shrink,
  unit,
  type BlockStyle,
  type Shell,
} from './block-shell.ts';

/** The roller door on the front of a warehouse, in metres. */
const ROLLER_WIDTH = 5;
const ROLLER_RISE = 4.5;

/** The loading dock: how high the platform stands and how far it reaches out. */
const DOCK_RISE = 1.1;
const DOCK_REACH = 1.6;

/** Metres of bay painted on the ground in front of a dock. */
const DOCK_BAY = 1.3;

/**
 * Metres the bay paint stands over the ground. It goes into the building's own
 * batch, which carries no depth offset, so the paint wins over the ground mesh
 * by the lift alone: two centimetres lost the fight beyond about 180 m from the
 * chase camera. Four is the lift the metro well and a shop floor take.
 */
const DOCK_PAINT_RISE = 0.04;

/** Metres of frontage one sawtooth bay covers, and the fewest and most bays. */
const TOOTH = 7;
const TEETH_MIN = 2;
const TEETH_MAX = 6;

/** The salts a warehouse draws its variants from. */
const SALT_ROOF = 51;
const SALT_DOCKS = 52;

/** Build one warehouse. Its roof is never flat, so it carries no dressing. */
export function warehouse(shell: Shell, massing: BuildingMassing, style: BlockStyle): void {
  const seed = style.seed;
  const sawtooth = unit(seed, SALT_ROOF) < 0.45;
  // The docks and the bays painted in front of them stand outside the walls,
  // so a warehouse that has them is built that much further inside its lot.
  const docked = style.detail === 'near' && unit(seed, SALT_DOCKS) < 0.6;
  const walls = shrink(massing, docked ? DOCK_REACH + DOCK_BAY : EAVES);
  const rise = Math.min(sawtooth ? 3 : 2, walls.depth * (sawtooth ? 0.2 : 0.1));
  const eaves = Math.max(STOREY, massing.height - rise);
  box(shell, walls, 0, eaves, BLOCK_METAL);
  // Daylight comes in high up, over the racking: one band under the eaves.
  band(shell, walls, eaves - 1.8, eaves - 0.6, ALL_SIDES);
  if (sawtooth) teeth(shell, walls, eaves, rise);
  else gable(shell, walls, eaves, rise, 'z', BLOCK_METAL);
  const rollers = Math.min(ROLLER_WIDTH, walls.width * 0.5);
  door(shell, walls, rollers, Math.min(ROLLER_RISE, eaves - 0.4), BLOCK_METAL);
  if (docked) docks(shell, walls, seed);
}

/**
 * A sawtooth roof: a run of teeth across the frontage, each a slope rising to
 * a glazed face. Every face looks the same way, as a real one does, so the
 * light in the shed never changes through the day.
 */
function teeth(shell: Shell, walls: BuildingMassing, eaves: number, rise: number): void {
  const count = Math.max(TEETH_MIN, Math.min(TEETH_MAX, Math.round(walls.depth / TOOTH)));
  const hw = walls.width / 2 + EAVES;
  const hd = walls.depth / 2 + EAVES;
  const pitch = (hd * 2) / count;
  for (let i = 0; i < count; i++) {
    const z0 = -hd + i * pitch;
    const z1 = z0 + pitch;
    const top = eaves + rise;
    // The slope, looking up and towards the back of the lot.
    shell.quad([-hw, eaves, z1], [hw, eaves, z1], [hw, top, z0], [-hw, top, z0], BLOCK_METAL);
    // The glazed face, which stands upright at the high end of the slope.
    shell.quad([-hw, eaves, z0], [hw, eaves, z0], [hw, top, z0], [-hw, top, z0], BLOCK_GLASS);
    // The two ends of the tooth, which close it.
    shell.triangle([hw, eaves, z1], [hw, eaves, z0], [hw, top, z0], BLOCK_METAL);
    shell.triangle([-hw, eaves, z0], [-hw, eaves, z1], [-hw, top, z0], BLOCK_METAL);
  }
}

/**
 * The loading docks along the front: a platform with a roller door over each
 * bay and the bay painted on the ground in front of it.
 */
function docks(shell: Shell, walls: BuildingMassing, seed: number): void {
  const bays = 2 + (unit(seed, SALT_DOCKS + 1) < 0.5 ? 0 : 1);
  const hd = walls.depth / 2;
  const span = Math.min(walls.width * 0.7, bays * 4.5);
  const pitch = span / bays;
  shell.box(-span / 2, span / 2, 0, DOCK_RISE, hd - 0.05, hd + DOCK_REACH, BLOCK_TRIM);
  for (let i = 0; i < bays; i++) {
    const at = -span / 2 + (i + 0.5) * pitch;
    shell.box(at - 1.5, at + 1.5, DOCK_RISE, DOCK_RISE + 3.2, hd - 0.02, hd + 0.08, BLOCK_METAL);
    shell.panel(at - 1.6, at + 1.6, DOCK_PAINT_RISE, hd + DOCK_REACH, hd + DOCK_REACH + DOCK_BAY, BLOCK_PAINT);
  }
}

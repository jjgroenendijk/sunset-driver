/**
 * The buildings that are not towers, as geometry (spec section 10.3).
 *
 * `SkyscraperGenerator` dresses the towers and the mid-rise blocks. Everything
 * else — a house, a shop row, a parking garage, a warehouse, a roadhouse — is a
 * handful of boxes with a roof on top, generated here. They are the bulk of the
 * city by count, so each one is cut to what a top-down camera can see of it:
 * the massing, the roof, and the bands of window the night lights up. A window
 * is not modelled; a band of glazing is, and the material cuts it into windows
 * from the metres along the wall that the band carries in its `uv`.
 *
 * This file is the door. The kit every kind is built from is `block-shell.ts`,
 * each kind has its own file — `house-mesh.ts`, `shop-mesh.ts`,
 * `warehouse-mesh.ts`, `roadhouse-mesh.ts` — and what stands on a flat roof is
 * `roof-dress.ts`.
 *
 * The dressing of a roof is built as its own geometry rather than as part of
 * the shell, because the camera reads the shell's box (`roofs.ts`): a mast six
 * metres tall would otherwise be something the camera climbs. It joins the same batch, so it costs no draw call.
 *
 * The local frame is the one {@link BuildingMassing} describes: the middle of
 * the lot at ground level, `x` along the frontage, `z` towards the road, `y` up.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import type { BufferGeometry } from 'three';
import type { BuildingKind } from '../world/buildings.ts';
import type { FinishCode } from './building-finish.ts';
import type { BuildingMassing, Rgb } from './building-mesh.ts';
import {
  ALL_SIDES,
  BLOCK_ROOF,
  BLOCK_WALL,
  MIN_WALLS,
  PROUD,
  Shell,
  box,
  flatRoof,
  windowBands,
  type BlockStyle,
} from './block-shell.ts';
import type { ShapeBox } from './building-shape.ts';
import { house } from './house-mesh.ts';
import { parkingGarage, roadhouse } from './roadhouse-mesh.ts';
import { deckPartOf, dressRoof, type RoofDeck } from './roof-dress.ts';
import { shopRow } from './shop-mesh.ts';
import { styledBox } from './tall-mesh.ts';
import { warehouse } from './warehouse-mesh.ts';

// The parts a vertex may belong to are the material's business as much as the
// geometry's, so this is the door onto them as well.
export {
  BLOCK_BEACON,
  BLOCK_CONCRETE,
  BLOCK_CROWN,
  BLOCK_CURTAIN,
  BLOCK_GLASS,
  BLOCK_MEMBRANE,
  BLOCK_METAL,
  BLOCK_NEON,
  BLOCK_PAINT,
  BLOCK_PLANTED,
  BLOCK_PORTHOLE,
  BLOCK_ROOF,
  BLOCK_SLATE,
  BLOCK_SOLAR,
  BLOCK_STONE,
  BLOCK_STUCCO,
  BLOCK_TILE,
  BLOCK_TRIM,
  BLOCK_WALL,
  BLOCK_WATER,
  type BlockStyle,
} from './block-shell.ts';
export { roofDeckOf, type RoofDeck } from './roof-dress.ts';

/** One building of boxes: its shell, and whatever stands on its roof. */
export interface BlockGeometry {
  shell: BufferGeometry;
  /** The rooftop dressing, in the same frame, or undefined where there is none. */
  dress: BufferGeometry | undefined;
}

/**
 * Build the shell of one building that is not a tower, and the dressing of its
 * roof where that roof is flat. The geometry is non-indexed, as the tower
 * generator's is, so a batch can hold either.
 */
export function buildBlockGeometry(
  kind: BuildingKind,
  massing: BuildingMassing,
  tint: Rgb,
  finish: FinishCode,
  style: BlockStyle,
  boxes: readonly ShapeBox[],
): BlockGeometry {
  const shell = new Shell();
  let deck: RoofDeck | undefined;
  switch (kind) {
    case 'shop-row':
      deck = shopRow(shell, massing, style);
      break;
    case 'warehouse':
      warehouse(shell, massing, style);
      break;
    case 'roadhouse':
      deck = roadhouse(shell, massing, style);
      break;
    case 'parking-garage':
      parkingGarage(shell, massing, style);
      break;
    case 'tower':
    case 'mid-rise':
      deck = tall(shell, massing, style, boxes);
      break;
    default:
      deck = house(shell, massing, style);
      break;
  }
  return { shell: shell.geometry(tint, finish), dress: buildDressGeometry(deck, style, tint, finish) };
}

/**
 * What stands on one flat roof, as its own geometry, or undefined where the
 * roof carries nothing. The generated towers are dressed through this as well,
 * from the deck `roofDeckOf` measures off their shells.
 */
export function buildDressGeometry(
  deck: RoofDeck | undefined,
  style: BlockStyle,
  tint: Rgb,
  finish: FinishCode,
): BufferGeometry | undefined {
  if (deck === undefined) return undefined;
  const shell = new Shell();
  dressRoof(shell, deck, style);
  return shell.count === 0 ? undefined : shell.geometry(tint, finish);
}

/**
 * The massing of a building and nothing else: four walls and a flat roof, the
 * far detail of spec section 9.2. The camera reads a chunk that far out as a
 * skyline, and a skyline is heights and footprints, not window bands.
 */
export function buildMassingGeometry(
  tint: Rgb,
  finish: FinishCode,
  boxes: readonly ShapeBox[],
): BufferGeometry {
  const shell = new Shell();
  for (const one of boxes) {
    const x0 = one.x - one.width / 2;
    const x1 = one.x + one.width / 2;
    const z0 = one.z - one.depth / 2;
    const z1 = one.z + one.depth / 2;
    const top = one.to;
    // The four walls and the roof of a box; the floor stands on the ground and
    // is never seen. A box that stands on another one keeps its own floor for
    // the same reason: the box below it covers it.
    shell.quad([x0, one.from, z1], [x1, one.from, z1], [x1, top, z1], [x0, top, z1], BLOCK_WALL);
    shell.quad([x1, one.from, z0], [x0, one.from, z0], [x0, top, z0], [x1, top, z0], BLOCK_WALL);
    shell.quad([x1, one.from, z1], [x1, one.from, z0], [x1, top, z0], [x1, top, z1], BLOCK_WALL);
    shell.quad([x0, one.from, z0], [x0, one.from, z1], [x0, top, z1], [x0, top, z0], BLOCK_WALL);
    shell.quad([x0, top, z1], [x1, top, z1], [x1, top, z0], [x0, top, z0], BLOCK_ROOF);
  }
  return shell.geometry(tint, finish);
}

/**
 * A tower or a mid-rise block, built from boxes: either a styled one of spec
 * section 10.3 — glass, Brutalist, Art Deco or Miami, which `tall-mesh.ts`
 * builds — or classical masonry on a lot too narrow for a generated facade,
 * which is plain walls and a band of window at every storey. Every box is
 * capped with its own dressed flat roof behind a parapet.
 */
function tall(shell: Shell, massing: BuildingMassing, style: BlockStyle, boxes: readonly ShapeBox[]): RoofDeck {
  const part = deckPartOf(style);
  let crown = 0;
  for (const one of boxes) crown = Math.max(crown, one.to);
  let deck: RoofDeck | undefined;
  for (const one of boxes) {
    // Each box of the shape is its own walls, its own bands of glazing and its
    // own flat roof, so the block reads as the silhouette the generated facade
    // of the same building cuts.
    const walls = {
      ...massing,
      width: Math.max(MIN_WALLS, one.width - 2 * PROUD),
      depth: Math.max(MIN_WALLS, one.depth - 2 * PROUD),
    };
    const at = { x: one.x, z: one.z };
    if (style.tall !== undefined) {
      const outer = { ...massing, width: one.width, depth: one.depth };
      styledBox(shell, style.tall.look, outer, one.from, one.to, at, style.detail, style.tall.bay, one.to >= crown);
    } else {
      box(shell, walls, one.from, one.to, BLOCK_WALL, at);
      windowBands(shell, walls, one.from, one.to, ALL_SIDES, at);
    }
    // A parapet is a ring a third of a metre wide. The camera is 200 m out at
    // mid detail and the roof is a deck there, not a rim around one.
    if (style.detail === 'near') flatRoof(shell, walls, one.to, part, at);
    else shell.quad(
      [at.x - walls.width / 2, one.to, at.z + walls.depth / 2],
      [at.x + walls.width / 2, one.to, at.z + walls.depth / 2],
      [at.x + walls.width / 2, one.to, at.z - walls.depth / 2],
      [at.x - walls.width / 2, one.to, at.z - walls.depth / 2],
      part,
    );
    if (one.terrace === undefined || (deck !== undefined && deck.top >= one.to + 0.12)) continue;
    deck = { x: one.terrace.x, z: one.terrace.z, hw: one.terrace.width / 2, hd: one.terrace.depth / 2, top: one.to + 0.12 };
  }
  if (deck !== undefined) return deck;
  return topDeck(massing, boxes);
}

/**
 * No box of the shape offered a terrace, so the deck is the roof of the box
 * that reaches the top. The massing is the whole building and a stack of
 * setbacks is narrower than that up there; a deck measured off the massing
 * would hang its plant, its crown and its beacon over the street.
 */
function topDeck(massing: BuildingMassing, boxes: readonly ShapeBox[]): RoofDeck {
  let highest = boxes[0] as ShapeBox | undefined;
  for (const one of boxes) if (highest === undefined || one.to > highest.to) highest = one;
  if (highest === undefined) {
    return { x: 0, z: 0, hw: massing.width / 2, hd: massing.depth / 2, top: massing.height + 0.12 };
  }
  return {
    x: highest.x,
    z: highest.z,
    hw: Math.max(MIN_WALLS, highest.width - 2 * PROUD) / 2,
    hd: Math.max(MIN_WALLS, highest.depth - 2 * PROUD) / 2,
    top: highest.to + 0.12,
  };
}

/**
 * The buildings that are not towers, as geometry (spec section 10.3).
 *
 * `SkyscraperGenerator` dresses the towers and the mid-rise blocks. Everything
 * else — a house, a shop row, a warehouse, a roadhouse — is a handful of boxes
 * with a roof on top, generated here. They are the bulk of the city by count, so
 * each one is cut to what a top-down camera can see of it: the massing, the
 * roof, and the bands of window the night lights up. A window is not modelled;
 * a band of glazing is, and the material cuts it into windows from the metres
 * along the wall that the band carries in its `uv`.
 *
 * The local frame is the one {@link BuildingMassing} describes: the middle of
 * the lot at ground level, `x` along the frontage, `z` towards the road, `y` up.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import type { BuildingKind } from '../world/buildings.ts';
import type { BuildingMassing, Rgb } from './building-mesh.ts';

/**
 * What a vertex belongs to. The material shades each of them differently, and
 * the glass is the only one the night lights up.
 */
export const BLOCK_WALL = 0;
export const BLOCK_ROOF = 1;
export const BLOCK_TRIM = 2;
export const BLOCK_GLASS = 3;

/** Metres of one storey, which is what the window bands are spaced by. */
const STOREY = 3.2;

/** Metres a band of glazing stands proud of the wall it is set into. */
const PROUD = 0.05;

/** Metres a band of glazing stops short of the corner of the wall it is laid on. */
const BAND_INSET = 0.5;

/** Metres of wall under a window and over it, inside one storey. */
const SILL = 0.9;
const HEAD = 0.6;

/** Metres a roof reaches out past the wall under it. */
const EAVES = 0.4;

/** Metres each way the walls are never taken below, whatever stands outside them. */
const MIN_WALLS = 2.5;

/** Metres of the parapet that rims a flat roof, and how thick it is. */
const PARAPET_RISE = 0.7;
const PARAPET_WIDTH = 0.3;

/** The door on the front of a house, in metres. */
const DOOR_WIDTH = 1.1;
const DOOR_RISE = 2.1;

/** The shopfront of a shop row: how tall the glazing is and how far the awning reaches. */
const SHOPFRONT_RISE = 3.4;
const AWNING_REACH = 1.3;
const AWNING_THICK = 0.18;

/** The roller door on the front of a warehouse, in metres. */
const ROLLER_WIDTH = 5;
const ROLLER_RISE = 4.5;

/** The board a roadhouse carries over its roof, in metres. */
const SIGN_WIDTH = 2.6;
const SIGN_RISE = 1.4;
const SIGN_THICK = 0.2;

/** Which walls a band of glazing is laid on. */
type Side = 'front' | 'back' | 'left' | 'right';
const ALL_SIDES: readonly Side[] = ['front', 'back', 'left', 'right'];

/**
 * Build the shell of one building that is not a tower. The geometry is
 * non-indexed, as the tower generator's is, so a batch can hold either.
 */
export function buildBlockGeometry(kind: BuildingKind, massing: BuildingMassing, tint: Rgb): BufferGeometry {
  const shell = new Shell();
  switch (kind) {
    case 'shop-row':
      shopRow(shell, massing);
      break;
    case 'warehouse':
      warehouse(shell, massing);
      break;
    case 'roadhouse':
      roadhouse(shell, massing);
      break;
    case 'tower':
    case 'mid-rise':
      tall(shell, massing);
      break;
    default:
      house(shell, massing);
      break;
  }
  return shell.geometry(tint);
}

/**
 * A house: walls under a gabled roof whose ridge runs along the street, a door
 * on the front and a band of window at every storey.
 */
function house(shell: Shell, massing: BuildingMassing): void {
  const walls = shrink(massing, EAVES);
  const rise = Math.min(3, walls.depth * 0.3);
  const eaves = Math.max(STOREY, massing.height - rise);
  box(shell, walls, 0, eaves, BLOCK_WALL);
  windowBands(shell, walls, 0, eaves, ALL_SIDES);
  gable(shell, walls, eaves, rise, 'x');
  door(shell, walls, DOOR_WIDTH, DOOR_RISE);
}

/**
 * A shop row: glazing along the whole of the ground floor under an awning, flats
 * over it, and a flat roof behind a parapet.
 */
function shopRow(shell: Shell, massing: BuildingMassing): void {
  const walls = shrink(massing, AWNING_REACH);
  const top = massing.height;
  box(shell, walls, 0, top, BLOCK_WALL);
  const shopfront = Math.min(SHOPFRONT_RISE, top - 0.6);
  // The shop is glazed from end to end on the street side; the flats above it
  // take the ordinary bands, and the back and the sides are plain brick.
  band(shell, walls, 0.4, shopfront, ['front']);
  windowBands(shell, walls, shopfront + 0.8, top, ['front', 'left', 'right']);
  slab(shell, walls, shopfront, AWNING_THICK, AWNING_REACH);
  flatRoof(shell, walls, top);
}

/**
 * A tower or a mid-rise block on a lot too narrow for a generated facade: plain
 * walls, a band of window at every storey, and a flat roof behind a parapet.
 */
function tall(shell: Shell, massing: BuildingMassing): void {
  const walls = shrink(massing, PROUD);
  const top = massing.height;
  box(shell, walls, 0, top, BLOCK_WALL);
  windowBands(shell, walls, 0, top, ALL_SIDES);
  flatRoof(shell, walls, top);
}

/** A warehouse: one tall volume with a roller door, a clerestory and a low gable. */
function warehouse(shell: Shell, massing: BuildingMassing): void {
  const walls = shrink(massing, EAVES);
  const rise = Math.min(2, walls.depth * 0.1);
  const eaves = Math.max(STOREY, massing.height - rise);
  box(shell, walls, 0, eaves, BLOCK_WALL);
  // Daylight comes in high up, over the racking: one band under the eaves.
  band(shell, walls, eaves - 1.8, eaves - 0.6, ALL_SIDES);
  gable(shell, walls, eaves, rise, 'z');
  door(shell, walls, Math.min(ROLLER_WIDTH, walls.width * 0.5), Math.min(ROLLER_RISE, eaves - 0.4));
}

/** A roadhouse: a single storey under a wide flat roof, with a board over it. */
function roadhouse(shell: Shell, massing: BuildingMassing): void {
  const walls = shrink(massing, EAVES * 2);
  const top = massing.height;
  box(shell, walls, 0, top, BLOCK_WALL);
  band(shell, walls, 1, Math.min(2.6, top - 0.5), ALL_SIDES);
  // A deep flat roof over the pumps and the porch, rather than a parapet.
  slab(shell, walls, top, 0.35, EAVES * 2);
  const sign = Math.min(SIGN_WIDTH, walls.width * 0.6);
  const board = walls.depth / 2;
  shell.box(-sign / 2, sign / 2, top + 0.35, top + 0.35 + SIGN_RISE, board - SIGN_THICK, board, BLOCK_TRIM);
}

/**
 * The walls of a building: the massing less whatever stands outside them, so
 * that the roof over them, the awning in front of them and the glazing set into
 * them all stand inside the lot rather than over the pavement.
 */
function shrink(massing: BuildingMassing, over: number): BuildingMassing {
  const reach = Math.max(over, PROUD);
  return {
    ...massing,
    width: Math.max(MIN_WALLS, massing.width - 2 * reach),
    depth: Math.max(MIN_WALLS, massing.depth - 2 * reach),
  };
}

/** The walls themselves, as one box standing on the ground. */
function box(shell: Shell, walls: BuildingMassing, from: number, to: number, part: number): void {
  shell.box(-walls.width / 2, walls.width / 2, from, to, -walls.depth / 2, walls.depth / 2, part);
}

/** A band of glazing at every storey between two heights. */
function windowBands(shell: Shell, walls: BuildingMassing, from: number, to: number, sides: readonly Side[]): void {
  const storeys = Math.max(1, Math.round((to - from) / STOREY));
  const pitch = (to - from) / storeys;
  if (pitch <= SILL + HEAD) return;
  for (let i = 0; i < storeys; i++) {
    const floor = from + i * pitch;
    band(shell, walls, floor + SILL, floor + pitch - HEAD, sides);
  }
}

/**
 * One band of glazing standing proud of the walls it is laid on. Its `uv` runs
 * in metres along the wall, so the material cuts the band into windows of the
 * same width whatever the building is.
 */
function band(shell: Shell, walls: BuildingMassing, from: number, to: number, sides: readonly Side[]): void {
  if (to - from < 0.3) return;
  const hw = walls.width / 2 + PROUD;
  const hd = walls.depth / 2 + PROUD;
  const near = hw - BAND_INSET;
  const far = hd - BAND_INSET;
  // Each band runs along its own wall, from one end of it to the other in the
  // direction that leaves the wall facing outward, and stops short of the
  // corners so two of them never meet.
  const ends: Record<Side, [Local, Local]> = {
    front: [[-near, 0, hd], [near, 0, hd]],
    back: [[near, 0, -hd], [-near, 0, -hd]],
    right: [[hw, 0, -far], [hw, 0, far]],
    left: [[-hw, 0, far], [-hw, 0, -far]],
  };
  for (const side of sides) {
    const [a, b] = ends[side];
    shell.quad([a[0], from, a[2]], [b[0], from, b[2]], [b[0], to, b[2]], [a[0], to, a[2]], BLOCK_GLASS);
  }
}

/** A gabled roof over the walls, its ridge running along `axis`. */
function gable(shell: Shell, walls: BuildingMassing, eaves: number, rise: number, axis: 'x' | 'z'): void {
  const hw = walls.width / 2 + EAVES;
  const hd = walls.depth / 2 + EAVES;
  const ridge = eaves + rise;
  if (axis === 'x') {
    // The ridge runs across the frontage, so the two slopes face the street and
    // the garden and the gable ends stand at the sides.
    shell.quad([-hw, eaves, hd], [hw, eaves, hd], [hw, ridge, 0], [-hw, ridge, 0], BLOCK_ROOF);
    shell.quad([hw, eaves, -hd], [-hw, eaves, -hd], [-hw, ridge, 0], [hw, ridge, 0], BLOCK_ROOF);
    shell.triangle([hw, eaves, hd], [hw, eaves, -hd], [hw, ridge, 0], BLOCK_WALL);
    shell.triangle([-hw, eaves, -hd], [-hw, eaves, hd], [-hw, ridge, 0], BLOCK_WALL);
  } else {
    shell.quad([hw, eaves, hd], [hw, eaves, -hd], [0, ridge, -hd], [0, ridge, hd], BLOCK_ROOF);
    shell.quad([-hw, eaves, -hd], [-hw, eaves, hd], [0, ridge, hd], [0, ridge, -hd], BLOCK_ROOF);
    shell.triangle([-hw, eaves, hd], [hw, eaves, hd], [0, ridge, hd], BLOCK_WALL);
    shell.triangle([hw, eaves, -hd], [-hw, eaves, -hd], [0, ridge, -hd], BLOCK_WALL);
  }
}

/** A flat roof with a parapet around it, as a shop row and a warehouse carry. */
function flatRoof(shell: Shell, walls: BuildingMassing, top: number): void {
  const hw = walls.width / 2;
  const hd = walls.depth / 2;
  shell.box(-hw, hw, top, top + 0.12, -hd, hd, BLOCK_ROOF);
  const rim = top + PARAPET_RISE;
  shell.box(-hw, hw, top, rim, hd - PARAPET_WIDTH, hd, BLOCK_TRIM);
  shell.box(-hw, hw, top, rim, -hd, -hd + PARAPET_WIDTH, BLOCK_TRIM);
  shell.box(-hw, -hw + PARAPET_WIDTH, top, rim, -hd, hd, BLOCK_TRIM);
  shell.box(hw - PARAPET_WIDTH, hw, top, rim, -hd, hd, BLOCK_TRIM);
}

/** A slab reaching out over the front of a building: an awning, or a roof. */
function slab(shell: Shell, walls: BuildingMassing, at: number, thick: number, reach: number): void {
  const hw = walls.width / 2 + reach;
  const hd = walls.depth / 2 + reach;
  shell.box(-hw, hw, at, at + thick, -hd, hd, BLOCK_TRIM);
}

/** The way in, on the middle of the front wall. */
function door(shell: Shell, walls: BuildingMassing, width: number, rise: number): void {
  if (rise <= 0 || width <= 0) return;
  const hd = walls.depth / 2;
  shell.box(-width / 2, width / 2, 0, rise, hd, hd + 0.09, BLOCK_TRIM);
}

/** A place in the building's own frame. */
type Local = [number, number, number];

/**
 * Triangles as they are collected, before they become a geometry. Everything is
 * written out flat: a building of this kind is a few dozen triangles, so an
 * index would cost more than it saves.
 */
class Shell {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly parts: number[] = [];

  /** A box, with its six faces facing outward. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, part: number): void {
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], part);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], part);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], part);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], part);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], part);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], part);
  }

  /**
   * A quadrilateral, wound anticlockwise seen from the side it faces. The `uv`
   * is metres: along the face from its first corner, and up it.
   */
  quad(a: Local, b: Local, c: Local, d: Local, part: number): void {
    this.triangle(a, b, c, part, 0);
    this.triangle(a, c, d, part, 1);
  }

  /** One triangle of a face. `corner` says which of a quad's two this is. */
  triangle(a: Local, b: Local, c: Local, part: number, corner = 0): void {
    const n = normalOf(a, b, c);
    const across = length(a, b);
    const up = length(b, c);
    // The two triangles of a quad share its corners, so both are laid out on the
    // same metres and the pattern the material draws does not break at the seam.
    const uv: Local[] =
      corner === 0
        ? [[0, 0, 0], [across, 0, 0], [across, up, 0]]
        : [[0, 0, 0], [across, up, 0], [0, up, 0]];
    const points = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const p = points[i] as Local;
      const t = uv[i] as Local;
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
      this.uvs.push(t[0], t[1]);
      this.parts.push(part);
    }
  }

  /** The triangles as a geometry, every vertex carrying the building's colour. */
  geometry(tint: Rgb): BufferGeometry {
    const geometry = new BufferGeometry();
    const count = this.parts.length;
    const tints = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
      tints[v * 3] = tint[0];
      tints[v * 3 + 1] = tint[1];
      tints[v * 3 + 2] = tint[2];
    }
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(this.uvs), 2));
    geometry.setAttribute('part', new BufferAttribute(new Float32Array(this.parts), 1));
    geometry.setAttribute('tint', new BufferAttribute(tints, 3));
    return geometry;
  }
}

/** The unit normal of a triangle, which is the way the face it belongs to looks. */
function normalOf(a: Local, b: Local, c: Local): Local {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const span = Math.hypot(nx, ny, nz) || 1;
  return [nx / span, ny / span, nz / span];
}

function length(a: Local, b: Local): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

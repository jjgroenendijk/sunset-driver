/**
 * The kit every building that is not a tower is built from (spec section 10.3).
 *
 * `block-mesh.ts` is the door onto the kinds; this is what they all share: the
 * {@link Shell} that collects triangles, the parts the material shades them by,
 * and the handful of shapes a building of boxes is made of — walls, glazing
 * bands, a gable, a flat roof, an awning, a door.
 *
 * The local frame is the one {@link BuildingMassing} describes: the middle of
 * the lot at ground level, `x` along the frontage, `z` towards the road, `y` up.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { hashInts } from '../core/hash.ts';
import type { BuildingMassing, Rgb } from './building-mesh.ts';
import type { StyledLook } from './building-style.ts';

/**
 * What a vertex belongs to. The material shades each of them differently, and
 * the glass is the only one the night lights up. The numbers are written into
 * the geometry, so a part is added at the end of the list and never renumbered.
 */
export const BLOCK_WALL = 0;
export const BLOCK_ROOF = 1;
export const BLOCK_TRIM = 2;
export const BLOCK_GLASS = 3;
/** A white membrane roof: the cheap bright deck of a warehouse or a shop row. */
export const BLOCK_MEMBRANE = 4;
/** A planted roof, a roof garden, and the grass of a sports court. */
export const BLOCK_PLANTED = 5;
/** A panel of a rooftop solar array. */
export const BLOCK_SOLAR = 6;
/** Corrugated metal: a warehouse wall, a metal roof, a roller door. */
export const BLOCK_METAL = 7;
/** A tiled roof, in the warm colours a house carries. */
export const BLOCK_TILE = 8;
/** A slate roof, which is the cold one. */
export const BLOCK_SLATE = 9;
/** Water: a rooftop pool. */
export const BLOCK_WATER = 10;
/** Paint on a deck: the markings of a helipad, a court or a loading bay. */
export const BLOCK_PAINT = 11;
/**
 * A glass curtain wall (spec section 10.3). The wall itself is the glass, and
 * the mullion grid and the spandrel band of each floor are drawn in the shader
 * off the metres the face carries in its `uv`, so a whole tower is six quads a
 * box rather than a window at a time.
 */
export const BLOCK_CURTAIN = 12;
/** Raw board-marked concrete: the wall of a Brutalist tower. */
export const BLOCK_CONCRETE = 13;
/** Pastel stucco: the wall of a Miami tower. */
export const BLOCK_STUCCO = 14;
/**
 * A stucco panel with one round window a storey: the cut corner of a Miami
 * tower, where the porthole of spec section 10.3 is drawn in the shader.
 */
export const BLOCK_PORTHOLE = 15;
/**
 * A neon strip along an edge of a Deco or a Miami tower. It is its own part so
 * the night of spec section 10.5 can light it on its own.
 */
export const BLOCK_NEON = 16;
/**
 * The cut stone of an Art Deco tower. It is the wall of `BLOCK_WALL` with the
 * punched windows of the style drawn on it, which is what lets a Deco tier
 * carry its windows at every detail without a band of glazing a storey.
 */
export const BLOCK_STONE = 17;

/** Metres of one storey, which is what the window bands are spaced by. */
export const STOREY = 3.2;

/** Metres a band of glazing stands proud of the wall it is set into. */
export const PROUD = 0.05;

/** Metres a band of glazing stops short of the corner of the wall it is laid on. */
const BAND_INSET = 0.5;

/** Metres of wall under a window and over it, inside one storey. */
const SILL = 0.9;
const HEAD = 0.6;

/** Metres a roof reaches out past the wall under it. */
export const EAVES = 0.4;

/** Metres each way the walls are never taken below, whatever stands outside them. */
export const MIN_WALLS = 2.5;

/** Metres of the parapet that rims a flat roof, and how thick it is. */
export const PARAPET_RISE = 0.7;
export const PARAPET_WIDTH = 0.3;

/**
 * Where a box of a building stands in its own frame. A building massed in
 * several boxes — the L, the U, the courtyard and the podium of
 * `building-shape.ts` — stands each of them at its own place; everything else
 * stands in the middle of its lot, which is the origin.
 */
export interface At {
  x: number;
  z: number;
}

/** The middle of the lot, where a building of one box stands. */
const MIDDLE: At = { x: 0, z: 0 };

/** Which walls a band of glazing is laid on. */
export type Side = 'front' | 'back' | 'left' | 'right';
export const ALL_SIDES: readonly Side[] = ['front', 'back', 'left', 'right'];

/**
 * How a building of boxes is dressed: its own seed, the wealth of the district
 * it stands in, and how near the camera is. Every variant is drawn from the
 * seed, so a building looks the same in every session and from every distance.
 *
 * Mid detail builds the massing and the roof shape and nothing smaller: a porch,
 * a fence or a rooftop vent is a metre across, and the camera is 200 m away.
 */
export interface BlockStyle {
  seed: number;
  wealth: number;
  detail: 'near' | 'mid';
  /**
   * How a tower or a mid-rise block is dressed (spec section 10.3), where it is
   * one of the four styles `tall-mesh.ts` builds, and the bay rhythm its shape
   * drew for itself. Undefined on every other kind, and on the classical
   * masonry that `SkyscraperGenerator` builds.
   */
  tall?: { look: StyledLook; bay: number };
}

/** A number in 0..1 drawn from a seed and a salt, the same one every time. */
export function unit(seed: number, salt: number): number {
  return hashInts(seed, salt) / 0x100000000;
}

/** One of a list, drawn from a seed and a salt. */
export function pick<T>(list: readonly T[], seed: number, salt: number): T {
  return list[hashInts(seed, salt) % list.length] as T;
}

/**
 * The walls of a building: the massing less whatever stands outside them, so
 * that the roof over them, the awning in front of them and the glazing set into
 * them all stand inside the lot rather than over the pavement.
 */
export function shrink(massing: BuildingMassing, over: number): BuildingMassing {
  const reach = Math.max(over, PROUD);
  return {
    ...massing,
    width: Math.max(MIN_WALLS, massing.width - 2 * reach),
    depth: Math.max(MIN_WALLS, massing.depth - 2 * reach),
  };
}

/** The walls themselves, as one box standing on the ground. */
export function box(shell: Shell, walls: BuildingMassing, from: number, to: number, part: number, at: At = MIDDLE): void {
  const hw = walls.width / 2;
  const hd = walls.depth / 2;
  shell.box(at.x - hw, at.x + hw, from, to, at.z - hd, at.z + hd, part);
}

/** A band of glazing at every storey between two heights. */
export function windowBands(
  shell: Shell,
  walls: BuildingMassing,
  from: number,
  to: number,
  sides: readonly Side[],
  at: At = MIDDLE,
): void {
  const storeys = Math.max(1, Math.round((to - from) / STOREY));
  const pitch = (to - from) / storeys;
  if (pitch <= SILL + HEAD) return;
  for (let i = 0; i < storeys; i++) {
    const floor = from + i * pitch;
    band(shell, walls, floor + SILL, floor + pitch - HEAD, sides, at);
  }
}

/**
 * One band of glazing standing proud of the walls it is laid on. Its `uv` runs
 * in metres along the wall, so the material cuts the band into windows of the
 * same width whatever the building is.
 */
export function band(
  shell: Shell,
  walls: BuildingMassing,
  from: number,
  to: number,
  sides: readonly Side[],
  at: At = MIDDLE,
): void {
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
    const ax = a[0] + at.x;
    const az = a[2] + at.z;
    const bx = b[0] + at.x;
    const bz = b[2] + at.z;
    shell.quad([ax, from, az], [bx, from, bz], [bx, to, bz], [ax, to, az], BLOCK_GLASS);
  }
}

/** A gabled roof over the walls, its ridge running along `axis`. */
export function gable(
  shell: Shell,
  walls: BuildingMassing,
  eaves: number,
  rise: number,
  axis: 'x' | 'z',
  part = BLOCK_ROOF,
): void {
  const hw = walls.width / 2 + EAVES;
  const hd = walls.depth / 2 + EAVES;
  const ridge = eaves + rise;
  if (axis === 'x') {
    // The ridge runs across the frontage, so the two slopes face the street and
    // the garden and the gable ends stand at the sides.
    shell.quad([-hw, eaves, hd], [hw, eaves, hd], [hw, ridge, 0], [-hw, ridge, 0], part);
    shell.quad([hw, eaves, -hd], [-hw, eaves, -hd], [-hw, ridge, 0], [hw, ridge, 0], part);
    shell.triangle([hw, eaves, hd], [hw, eaves, -hd], [hw, ridge, 0], BLOCK_WALL);
    shell.triangle([-hw, eaves, -hd], [-hw, eaves, hd], [-hw, ridge, 0], BLOCK_WALL);
  } else {
    shell.quad([hw, eaves, hd], [hw, eaves, -hd], [0, ridge, -hd], [0, ridge, hd], part);
    shell.quad([-hw, eaves, -hd], [-hw, eaves, hd], [0, ridge, hd], [0, ridge, -hd], part);
    shell.triangle([-hw, eaves, hd], [hw, eaves, hd], [0, ridge, hd], BLOCK_WALL);
    shell.triangle([hw, eaves, -hd], [-hw, eaves, -hd], [0, ridge, -hd], BLOCK_WALL);
  }
}

/**
 * A hipped roof over the walls: four slopes meeting on a ridge that runs along
 * the frontage and stops short of both ends, so no gable wall stands at a side.
 */
export function hipped(shell: Shell, walls: BuildingMassing, eaves: number, rise: number, part: number): void {
  const hw = walls.width / 2 + EAVES;
  const hd = walls.depth / 2 + EAVES;
  const ridge = eaves + rise;
  // The ridge is inset from the ends by the depth of the roof, which is what
  // makes the two ends slopes rather than walls.
  const end = Math.min(hw * 0.5, hd);
  shell.quad([-hw, eaves, hd], [hw, eaves, hd], [end, ridge, 0], [-end, ridge, 0], part);
  shell.quad([hw, eaves, -hd], [-hw, eaves, -hd], [-end, ridge, 0], [end, ridge, 0], part);
  shell.triangle([hw, eaves, hd], [hw, eaves, -hd], [end, ridge, 0], part);
  shell.triangle([-hw, eaves, -hd], [-hw, eaves, hd], [-end, ridge, 0], part);
}

/** A flat roof with a parapet around it, as a shop row and a warehouse carry. */
export function flatRoof(shell: Shell, walls: BuildingMassing, top: number, deck = BLOCK_ROOF, at: At = MIDDLE): void {
  const x0 = at.x - walls.width / 2;
  const x1 = at.x + walls.width / 2;
  const z0 = at.z - walls.depth / 2;
  const z1 = at.z + walls.depth / 2;
  shell.box(x0, x1, top, top + 0.12, z0, z1, deck);
  const rim = top + PARAPET_RISE;
  shell.box(x0, x1, top, rim, z1 - PARAPET_WIDTH, z1, BLOCK_TRIM);
  shell.box(x0, x1, top, rim, z0, z0 + PARAPET_WIDTH, BLOCK_TRIM);
  shell.box(x0, x0 + PARAPET_WIDTH, top, rim, z0, z1, BLOCK_TRIM);
  shell.box(x1 - PARAPET_WIDTH, x1, top, rim, z0, z1, BLOCK_TRIM);
}

/** A slab reaching out over the front of a building: an awning, or a roof. */
export function slab(shell: Shell, walls: BuildingMassing, at: number, thick: number, reach: number): void {
  const hw = walls.width / 2 + reach;
  const hd = walls.depth / 2 + reach;
  shell.box(-hw, hw, at, at + thick, -hd, hd, BLOCK_TRIM);
}

/** The way in, on the middle of the front wall. */
export function door(shell: Shell, walls: BuildingMassing, width: number, rise: number, part = BLOCK_TRIM): void {
  if (rise <= 0 || width <= 0) return;
  const hd = walls.depth / 2;
  shell.box(-width / 2, width / 2, 0, rise, hd, hd + 0.09, part);
}

/** A place in the building's own frame. */
export type Local = [number, number, number];

/**
 * Triangles as they are collected, before they become a geometry. Everything is
 * written out flat: a building of this kind is a few dozen triangles, so an
 * index would cost more than it saves.
 */
export class Shell {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly parts: number[] = [];

  /**
   * Metres along the frontage every place is moved by as it is collected. A
   * wing of a building — the garage beside a house, one end of a shop row — is
   * then built with the helpers here, which all work about the middle, and
   * stood where it belongs afterwards.
   */
  offset = 0;

  /** How many vertices have been collected, which is what a cap is counted in. */
  get count(): number {
    return this.parts.length;
  }

  /** A box, with its six faces facing outward. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, part: number): void {
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], part);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], part);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], part);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], part);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], part);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], part);
  }

  /** A flat panel lying on a deck, seen from above only: two triangles. */
  panel(x0: number, x1: number, y: number, z0: number, z1: number, part: number): void {
    this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], part);
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
      this.positions.push(p[0] + this.offset, p[1], p[2]);
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

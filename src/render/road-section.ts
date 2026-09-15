/**
 * The cross section of a road and the lines painted on it (spec section 6.2),
 * with the small geometry helpers every road part is built with.
 *
 * On the ground the section is the carriageway; on a deck or in a bore it
 * carries the whole width the tier claims. The material tells the parts apart
 * by how far across the road each vertex stands. `tiers.ts` holds
 * the widths themselves; nothing here or in `road-mesh.ts` carries a second
 * copy of them.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import { BufferAttribute, BufferGeometry, Color, ShapeUtils, Vector2, Vector3 } from 'three';
import type { RoadFrame } from '../world/ribbon.ts';
import { footprintHalfWidth, TIERS } from '../world/tiers.ts';
import type { Point, RoadTier } from '../world/types.ts';

/** The tiers, in the order a chunk's batches are built. */
export const TIER_ORDER: readonly RoadTier[] = ['highway', 'arterial', 'street', 'alley', 'dirt'];

/** Metres the carriageway stands above the bed the carve cut for it. */
export const SURFACE_RAISE = 0.06;

/** Metres a kerb stands above the carriageway, where the tier has one. */
export const KERB_RISE = 0.14;

/**
 * Metres the outer edge of a road drops below its bed, burying the edge in the
 * ground beside it. The carve holds one bed per grid cell, so where two roads
 * crowd one cell a road can stand a little off the ground it drives on; the
 * skirt is deeper than that gap, so the ground never shows through the edge.
 */
export const SKIRT = 0.8;

/** Metres the paint stands above the carriageway, so a marking is never buried in it. */
export const MARK_RAISE = 0.012;

/** Metres of paint and of gap in a dashed line. */
const DASH = 3;
const DASH_GAP = 4.5;

/** Metres in from the kerb that an edge line is painted. */
const EDGE_INSET = 0.4;

/** Metres between the two lines of a solid double centre line. */
const DOUBLE_GAP = 0.5;

/** What a vertex belongs to: the cross section of a road, or a structure carrying one. */
export const SURFACE_ROAD = 0;
export const SURFACE_STRUCTURE = 1;

/** One point of a cross section: how far across the road it stands, and how high. */
export interface SectionPoint {
  /** Metres from the centreline, negative to the left of travel. */
  across: number;
  /** Metres above the road bed. */
  rise: number;
}

/** A colour as the renderer wants it: three floats in the working colour space. */
type Rgb = readonly [number, number, number];

export function rgbOf(hex: number): Rgb {
  const colour = new Color(hex);
  return [colour.r, colour.g, colour.b];
}

/**
 * The two colours road paint comes in: yellow keeps the two directions apart,
 * white divides the lanes running the same way and marks the edges.
 */
const YELLOW = rgbOf(0xd8b43a);
const WHITE = rgbOf(0xd7d4cb);

/** One line painted along a road. */
export interface Marking {
  /** Metres from the centreline. */
  across: number;
  /** Metres of paint, then metres of gap. A gap of zero is a solid line. */
  dash: number;
  gap: number;
  colour: Rgb;
}

/** Square metres below which a junction surface is a sliver of rounding and is not drawn. */
const MIN_SURFACE_AREA = 1e-3;

/** Metres two places may stand apart and still be one vertex of a polygon. */
const SAME_PLACE = 1e-6;

/**
 * The cross section of a tier on the ground: the carriageway, flat from kerb to
 * kerb, with each edge dropped into the skirt that buries it. The pavement and
 * the verge beside it are drawn as pieces of their own (`pavement-mesh.ts`),
 * and so is the kerb face, which stands on the edge of the pavement.
 */
export function roadSection(tier: RoadTier): SectionPoint[] {
  const half = TIERS[tier].width / 2;
  return [
    { across: -half, rise: -SKIRT },
    { across: -half, rise: SURFACE_RAISE },
    { across: half, rise: SURFACE_RAISE },
    { across: half, rise: -SKIRT },
  ];
}

/**
 * The cross section of a tier on a deck or in a bore, from its left edge to its
 * right (spec section 6.2). No block stands beside a structure to cut a
 * pavement from, so the section carries the whole width the tier claims. The
 * carriageway is flat between the kerbs; a tier with a pavement takes a kerb
 * face up to it, and one without takes its verge level with the carriageway.
 * Both ends drop into the skirt that buries the edge.
 */
export function structureSection(tier: RoadTier): SectionPoint[] {
  const spec = TIERS[tier];
  const half = spec.width / 2;
  const outer = footprintHalfWidth(tier);
  const left: SectionPoint[] = [{ across: -outer, rise: -SKIRT }];
  if (outer > half) {
    const rise = vergeRise(tier);
    left.push({ across: -outer, rise }, { across: -half, rise });
  }
  left.push({ across: -half, rise: SURFACE_RAISE });
  const right = left.map((point) => ({ across: -point.across, rise: point.rise })).reverse();
  return [...left, ...right];
}

/**
 * Metres above the road bed that the outer edge of a tier's surface stands: the
 * top of the kerb where the tier has a pavement, and the carriageway where it
 * has a verge or nothing. A verge is laid level with the carriageway rather than
 * on the bench itself: a surface laid at exactly the height of the ground under
 * it is a surface the ground shows through wherever the grid samples it. The
 * pavement pieces and street furniture set beside a road stand on this.
 */
export function vergeRise(tier: RoadTier): number {
  return TIERS[tier].pavement > 0 ? SURFACE_RAISE + KERB_RISE : SURFACE_RAISE;
}

/**
 * The lines painted on a tier (spec section 6.2). An alley and a dirt road are
 * unmarked. Everything else takes a centre line, one dashed divider between each
 * pair of lanes, a solid line along each parking strip, and — where the tier
 * runs fast enough to need them — a solid edge line inside each kerb.
 */
export function markingsOf(tier: RoadTier): Marking[] {
  const spec = TIERS[tier];
  if (tier === 'alley' || tier === 'dirt') return [];
  const half = spec.width / 2;
  const lane = half / spec.lanes;
  const out: Marking[] = [];
  if (spec.lanes === 1) {
    out.push({ across: 0, dash: DASH, gap: DASH_GAP, colour: YELLOW });
  } else {
    // Two directions kept apart by a solid double line, as a road this busy is.
    out.push(
      { across: -DOUBLE_GAP / 2, dash: 0, gap: 0, colour: YELLOW },
      { across: DOUBLE_GAP / 2, dash: 0, gap: 0, colour: YELLOW },
    );
  }
  for (let i = 1; i < spec.lanes; i++) {
    out.push(
      { across: -i * lane, dash: DASH, gap: DASH_GAP, colour: WHITE },
      { across: i * lane, dash: DASH, gap: DASH_GAP, colour: WHITE },
    );
  }
  if (spec.parking > 0) {
    // The line between the lane and the parking strip at each kerb.
    out.push(
      { across: -(half - spec.parking), dash: 0, gap: 0, colour: WHITE },
      { across: half - spec.parking, dash: 0, gap: 0, colour: WHITE },
    );
  }
  if (spec.lanes > 1) {
    out.push(
      { across: -(half - EDGE_INSET), dash: 0, gap: 0, colour: WHITE },
      { across: half - EDGE_INSET, dash: 0, gap: 0, colour: WHITE },
    );
  }
  return out;
}

/** True where a tier carries painted markings, and so a batch to draw them in. */
export function isMarked(tier: RoadTier): boolean {
  return markingsOf(tier).length > 0;
}

/**
 * A flat polygon in the scene, wound to face up. Nothing where the ring has no
 * area to draw, which is a corner between two roads with no pavement. Given a
 * `centre` the ring is fanned from it rather than triangulated on its own,
 * which holds for a ring every point of which can be seen from the centre.
 */
export function flatSurface(ring: readonly Vector3[], across: number, centre?: Vector3): BufferGeometry | undefined {
  const points: Vector3[] = [];
  for (const p of ring) {
    const last = points[points.length - 1];
    if (last !== undefined && last.distanceTo(p) < SAME_PLACE) continue;
    points.push(p);
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (first !== undefined && last !== undefined && points.length > 1 && first.distanceTo(last) < SAME_PLACE) points.pop();
  if (points.length < 3) return undefined;
  const flat = points.map((p) => new Vector2(p.x, p.z));
  if (Math.abs(ShapeUtils.area(flat)) < MIN_SURFACE_AREA) return undefined;
  let faces: number[][];
  if (centre === undefined) {
    faces = ShapeUtils.triangulateShape(flat, []);
  } else {
    const hub = points.length;
    points.push(centre);
    faces = points.slice(0, hub).map((_, i) => [hub, i, (i + 1) % hub]);
  }
  if (faces.length === 0) return undefined;

  const count = points.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let v = 0; v < count; v++) {
    const p = points[v] as Vector3;
    positions[v * 3] = p.x;
    positions[v * 3 + 1] = p.y;
    positions[v * 3 + 2] = p.z;
    normals[v * 3 + 1] = 1;
    uvs[v * 2] = p.x;
    uvs[v * 2 + 1] = p.z;
  }
  // The map's y runs into the scene's z, which turns the winding over: a face
  // anticlockwise on the map faces down in the scene, so every face is wound
  // by the way its own three corners turn.
  const index = new Uint32Array(faces.length * 3);
  let at = 0;
  for (const face of faces) {
    const [a, b, c] = face as [number, number, number];
    const pa = points[a] as Vector3;
    const pb = points[b] as Vector3;
    const pc = points[c] as Vector3;
    const up = (pb.x - pa.x) * (pc.z - pa.z) - (pb.z - pa.z) * (pc.x - pa.x);
    if (up < 0) {
      index[at++] = a;
      index[at++] = b;
      index[at++] = c;
    } else {
      index[at++] = a;
      index[at++] = c;
      index[at++] = b;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(index, 1));
  return tag(geometry, new Float32Array(count).fill(across), SURFACE_ROAD);
}

/** Where one point of a cross section stands in the scene. */
export function place(point: Point, frame: RoadFrame, across: number, rise: number): Vector3 {
  const off = across * frame.mitre;
  return new Vector3(point.x + frame.acrossX * off, frame.height + frame.bank * off + rise, point.y + frame.acrossY * off);
}

export function between(a: Vector3, b: Vector3, t: number): Vector3 {
  return new Vector3().lerpVectors(a, b, t);
}

/**
 * Give a geometry the two attributes every road part carries: how far across the
 * road each vertex stands, which the material reads the carriageway, the kerb
 * and the pavement off, and what kind of surface it is.
 */
export function tag(geometry: BufferGeometry, across: Float32Array, kind: number): BufferGeometry {
  geometry.setAttribute('across', new BufferAttribute(across, 1));
  geometry.setAttribute('kind', new BufferAttribute(new Float32Array(across.length).fill(kind), 1));
  return geometry;
}

/** Join several geometries into one, so a portal costs one entry of a batch. */
export function merge(parts: readonly BufferGeometry[]): BufferGeometry {
  const names = ['position', 'normal', 'uv', 'across', 'kind'];
  const sizes = [3, 3, 2, 1, 1];
  const vertices = parts.reduce((sum, part) => sum + part.getAttribute('position').count, 0);
  const indices = parts.reduce((sum, part) => sum + (part.getIndex()?.count ?? 0), 0);
  const geometry = new BufferGeometry();
  const index = new Uint32Array(indices);
  let base = 0;
  let at = 0;
  for (let a = 0; a < names.length; a++) {
    const name = names[a] as string;
    const size = sizes[a] as number;
    const array = new Float32Array(vertices * size);
    let offset = 0;
    for (const part of parts) {
      array.set((part.getAttribute(name) as BufferAttribute).array as Float32Array, offset);
      offset += part.getAttribute(name).count * size;
    }
    geometry.setAttribute(name, new BufferAttribute(array, size));
  }
  for (const part of parts) {
    const source = part.getIndex();
    if (source !== null) for (let i = 0; i < source.count; i++) index[at++] = source.getX(i) + base;
    base += part.getAttribute('position').count;
    part.dispose();
  }
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

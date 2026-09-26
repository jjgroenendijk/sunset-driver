/**
 * The street lamps of one chunk: where they stand, and what they are made of
 * (spec sections 10.5, 13.4).
 *
 * A lamp is placed along a road rather than on a parcel, so the placement is a
 * function of the curve and nothing else: every lamp stands at a whole multiple
 * of its tier's spacing measured from the start of the curve. A run cut at a
 * chunk boundary keeps the distances of the whole curve, so two chunks place the
 * same lamps in the same places and never place one twice. The chunk that owns a
 * lamp is the one the run it came from was cut into; a mast near a boundary may
 * lean a little into the next chunk, as a building on a boundary does.
 *
 * Only the runs that stand on the ground are lit. A deck carries its own
 * lighting when bridges get furniture, and a bore is lit from inside; neither
 * has a verge for a mast to stand on.
 *
 * Every lamp of a tier is the same object, so a chunk draws one geometry and a
 * matrix for each place it stands. Nothing here touches the renderer or TSL, so
 * the tests read it directly.
 */
import { BufferGeometry, BoxGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WorldChunk } from '../world/chunks.ts';
import type { RoadRibbons } from '../world/ribbon.ts';
import { footprintHalfWidth } from '../world/tiers.ts';
import type { RoadTier } from '../world/types.ts';
import { vergeRise } from './road-mesh.ts';

/** What a vertex of a lamp belongs to: the mast and its arm, or the lantern's lens. */
export const LAMP_POST = 0;
export const LAMP_LENS = 1;

/** How a tier is lit. A tier missing from the table carries no lamps at all. */
export interface LampSpec {
  /** Metres along the curve between one lamp and the next. */
  spacing: number;
  /** Metres from the ground to the arm. */
  mast: number;
  /** Metres the arm reaches out over the carriageway. */
  arm: number;
  /** True where a lamp stands on both verges at once, false where the sides alternate. */
  bothSides: boolean;
}

/**
 * What each tier carries (spec section 13.4). A highway takes tall masts far
 * apart, an arterial takes a pair at every junction's spacing, and a street
 * takes short ones alternating from side to side, which is how a residential
 * street is lit. An alley and a dirt road are unlit: the dark corners are the
 * point of them.
 */
export const LAMP_BY_TIER: Partial<Record<RoadTier, LampSpec>> = {
  highway: { spacing: 60, mast: 12, arm: 3.2, bothSides: true },
  arterial: { spacing: 34, mast: 9, arm: 2.6, bothSides: true },
  street: { spacing: 28, mast: 6.5, arm: 1.8, bothSides: false },
};

/** Metres in from the ground the road claims that a mast stands. */
const LAMP_INSET = 0.7;

/** The mast and the arm, in metres across. */
const MAST_THICK = 0.22;
const ARM_THICK = 0.14;

/** The lantern on the end of the arm, in metres. */
const HEAD_LENGTH = 0.72;
const HEAD_WIDTH = 0.36;
const HEAD_DEPTH = 0.2;

/** Metres of lens under the lantern. This is the part that glows. */
const LENS_DEPTH = 0.09;

/** One lamp, in the places the scene works in. */
export interface Lamp {
  tier: RoadTier;
  /** Where the mast stands, and the ground it stands on. */
  x: number;
  y: number;
  height: number;
  /** Unit vector from the mast toward the middle of the road, in the map's axes. */
  towardX: number;
  towardY: number;
  /** Where the lantern hangs: over the carriageway, at the top of the mast. */
  headX: number;
  headY: number;
  headHeight: number;
  /** The place on the centreline the lantern is aimed at, on the road bed. */
  roadX: number;
  roadY: number;
  roadHeight: number;
}

/** The lamps of one chunk, in the order its runs are held. */
export function lampsIn(chunk: WorldChunk, ribbons: RoadRibbons): Lamp[] {
  const out: Lamp[] = [];
  for (const run of chunk.roads) {
    const spec = LAMP_BY_TIER[run.tier];
    if (spec === undefined) continue;
    const offset = footprintHalfWidth(run.tier) - LAMP_INSET;
    const rise = vergeRise(run.tier);
    for (let i = 0; i + 1 < run.points.length; i++) {
      const segment = run.from + i;
      if (!ribbons.isOnGround(run.curve, segment)) continue;
      const a = run.points[i] as { x: number; y: number };
      const b = run.points[i + 1] as { x: number; y: number };
      const from = ribbons.frameAt(run.curve, segment, a.x, a.y).distance;
      const to = ribbons.frameAt(run.curve, segment, b.x, b.y).distance;
      if (to > from) lampsAlong({ run, spec, ribbons, offset, rise, segment, a, b, from, to }, out);
    }
  }
  return out;
}

/** One segment of a run, from `a` at distance `from` along its curve to `b` at `to`. */
interface Stretch {
  run: WorldChunk['roads'][number];
  spec: LampSpec;
  ribbons: RoadRibbons;
  /** Metres from the centreline out to the masts. */
  offset: number;
  /** How far the verge stands over the road bed. */
  rise: number;
  segment: number;
  a: { x: number; y: number };
  b: { x: number; y: number };
  from: number;
  to: number;
}

/** Add the lamps along one stretch to `out`, one each `spacing` along the curve. */
function lampsAlong(stretch: Stretch, out: Lamp[]): void {
  const { run, spec, ribbons, offset, rise, segment, a, b, from, to } = stretch;
  for (let k = Math.ceil(from / spec.spacing); k * spec.spacing < to; k++) {
    const at = k * spec.spacing;
    // The stretches the junctions take carry no road surface, so a mast
    // placed there would stand in the middle of the carriageway. The gaps
    // are the curve's own, so both chunks of a run cut at a boundary leave
    // out the same lamps.
    if (run.gaps.some((gap) => at >= gap.from.distance && at <= gap.to.distance)) continue;
    const t = (at - from) / (to - from);
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const frame = ribbons.frameAt(run.curve, segment, x, y);
    // The sides of a single-sided tier alternate, so one side of the street
    // is never left dark for a whole block.
    const sides = spec.bothSides ? [-1, 1] : [k % 2 === 0 ? -1 : 1];
    for (const side of sides) {
      // Inside a mouth's blend the road banks, so the pavement under the
      // mast stands off the centreline's height by the bank.
      const foot = frame.height + frame.bank * side * offset + rise;
      out.push(lampAt(run.tier, spec, x, y, frame.height, foot, frame.acrossX * side, frame.acrossY * side, offset));
    }
  }
}

/** One lamp, given the way across the road that its verge lies. */
function lampAt(
  tier: RoadTier,
  spec: LampSpec,
  x: number,
  y: number,
  bed: number,
  foot: number,
  outX: number,
  outY: number,
  offset: number,
): Lamp {
  const postX = x + outX * offset;
  const postY = y + outY * offset;
  return {
    tier,
    x: postX,
    y: postY,
    height: foot,
    towardX: -outX,
    towardY: -outY,
    headX: postX - outX * spec.arm,
    headY: postY - outY * spec.arm,
    headHeight: foot + spec.mast - ARM_THICK - HEAD_DEPTH - LENS_DEPTH / 2,
    roadX: x,
    roadY: y,
    roadHeight: bed,
  };
}

/** The lamps of one tier inside one chunk: one geometry, and a place for each. */
export interface LampGeometry {
  tier: RoadTier;
  /** One lamp, in its own frame: the mast at the origin, and +x toward the road. */
  geometry: BufferGeometry;
  /** Where each lamp of the tier stands. */
  matrices: Matrix4[];
}

/**
 * Build the geometry of a chunk's lamps, one entry per lit tier standing in it.
 * The lamps of a tier share their geometry, so a whole street costs one copy of
 * the mast and a matrix for each place it stands.
 */
export function buildChunkLamps(lamps: readonly Lamp[]): LampGeometry[] {
  const byTier = new Map<RoadTier, Matrix4[]>();
  for (const lamp of lamps) {
    const places = byTier.get(lamp.tier) ?? [];
    places.push(placeOf(lamp));
    byTier.set(lamp.tier, places);
  }
  const out: LampGeometry[] = [];
  // The tiers are walked in the table's order, so two chunks batch them alike.
  for (const tier of LIT_TIERS) {
    const matrices = byTier.get(tier);
    if (matrices === undefined) continue;
    out.push({ tier, geometry: lampGeometry(LAMP_BY_TIER[tier] as LampSpec), matrices });
  }
  return out;
}

/** The tiers that carry lamps, in a fixed order. */
const LIT_TIERS: readonly RoadTier[] = ['highway', 'arterial', 'street'];

/**
 * Draw calls one chunk spends on its lamps: one batch if a lit tier runs
 * through it, and nothing otherwise. `chunk-cost.ts` adds this to the rest.
 */
export function lampDrawCalls(chunk: WorldChunk): number {
  return chunk.roads.some((run) => LAMP_BY_TIER[run.tier] !== undefined) ? 1 : 0;
}

/** Where one lamp stands, as a batch wants it: its own frame, in the world. */
function placeOf(lamp: Lamp): Matrix4 {
  const toward = new Vector3(lamp.towardX, 0, lamp.towardY);
  const up = new Vector3(0, 1, 0);
  const side = new Vector3().crossVectors(toward, up);
  return new Matrix4().makeBasis(toward, up, side).setPosition(lamp.x, lamp.height, lamp.y);
}

/**
 * One lamp of a tier: a mast, an arm reaching over the road, the lantern on the
 * end of it and the lens under that. Built about the foot of the mast, with +x
 * the way the arm reaches, so one geometry serves both verges of a road.
 */
export function lampGeometry(spec: LampSpec): BufferGeometry {
  // Nothing stands above the mast: the arm hangs under its top and the lantern
  // under the arm, so a lamp is exactly as tall as its tier says.
  const arm = spec.mast - ARM_THICK / 2;
  const head = spec.mast - ARM_THICK - HEAD_DEPTH / 2;
  const lens = head - (HEAD_DEPTH + LENS_DEPTH) / 2;
  const parts = [
    part(MAST_THICK, spec.mast, MAST_THICK, 0, spec.mast / 2, 0, LAMP_POST),
    part(spec.arm, ARM_THICK, ARM_THICK, spec.arm / 2, arm, 0, LAMP_POST),
    part(HEAD_LENGTH, HEAD_DEPTH, HEAD_WIDTH, spec.arm, head, 0, LAMP_POST),
    part(HEAD_LENGTH * 0.8, LENS_DEPTH, HEAD_WIDTH * 0.8, spec.arm, lens, 0, LAMP_LENS),
  ];
  const merged = mergeGeometries(parts);
  for (const geometry of parts) geometry.dispose();
  return merged;
}

/** One box of a lamp, moved into place and told what it is. */
function part(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  kind: number,
): BufferGeometry {
  const box = new BoxGeometry(width, height, depth);
  box.translate(x, y, z);
  const count = box.getAttribute('position').count;
  box.setAttribute('part', new Float32BufferAttribute(new Float32Array(count).fill(kind), 1));
  return box;
}

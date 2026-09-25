/**
 * A small lofted part: a tapered, chamfered solid run through a row of
 * cross-sections (spec section 10.1). It is how the pieces of a motorcycle
 * are shaped — a tank that swells and narrows, a seat that steps, a mudguard
 * that follows its wheel — where a box would only be a brick.
 *
 * `vehicle-hull.ts` lofts whole car bodies the same way, with rings of its
 * own; both end in {@link partFrom}. No three.js here.
 */
import type { VehicleBox } from './vehicle-parts.ts';

export type Point = [number, number, number];

/** One cross-section across the vehicle, at `x` along it. */
export interface Section {
  x: number;
  bottom: number;
  top: number;
  /** Half the width. */
  half: number;
  /** Where its middle stands across the vehicle; 0 on the centreline. */
  z?: number;
}

/**
 * A part through `sections`, given nose first, each an octagon with its
 * corners cut by `chamfer` of its smaller half-size. The rings all wind the
 * same way, so every face comes out facing outwards; the nose is read
 * backwards to face forwards.
 */
export function loft(sections: readonly Section[], colour: number, chamfer = 0.35): VehicleBox {
  const rings = sections.map((s) => {
    const z = s.z ?? 0;
    const cut = chamfer * Math.min(s.half, (s.top - s.bottom) / 2);
    const corners: [number, number][] = [
      [s.half - cut, s.bottom],
      [s.half, s.bottom + cut],
      [s.half, s.top - cut],
      [s.half - cut, s.top],
      [-s.half + cut, s.top],
      [-s.half, s.top - cut],
      [-s.half, s.bottom + cut],
      [-s.half + cut, s.bottom],
    ];
    return corners.map(([across, y]): Point => [s.x, y, z + across]);
  });
  return solid(rings, colour);
}

/**
 * A closed part through `rings`, each a convex polygon with as many points as
 * the others, joined ring to ring and capped at both ends. The faces are
 * turned outwards by the sign of the volume they close, so the rings may run
 * along any axis and wind either way.
 */
function solid(rings: readonly Point[][], colour: number): VehicleBox {
  const faces: Point[][] = [];
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i] as Point[];
    const b = rings[i + 1] as Point[];
    const n = a.length;
    for (let k = 0; k < n; k++) faces.push([a[k] as Point, a[(k + 1) % n] as Point, b[(k + 1) % n] as Point, b[k] as Point]);
  }
  faces.push([...(rings[0] as Point[])].reverse(), [...(rings[rings.length - 1] as Point[])]);
  if (volume(faces) < 0) for (const face of faces) face.reverse();
  return partFrom(faces, colour);
}

/** Six times the signed volume the faces close: positive when they face outwards. */
function volume(faces: readonly Point[][]): number {
  let sum = 0;
  for (const face of faces) {
    const o = face[0] as Point;
    for (let k = 1; k + 1 < face.length; k++) {
      const a = face[k] as Point;
      const b = face[k + 1] as Point;
      sum += o[0] * (a[1] * b[2] - a[2] * b[1]) - o[1] * (a[0] * b[2] - a[2] * b[0]) + o[2] * (a[0] * b[1] - a[1] * b[0]);
    }
  }
  return sum;
}

/** One cross-section of a wing, a tailplane or a blade, at `z` across the vehicle. */
export interface Chord {
  z: number;
  /** Where its leading and trailing edges stand along the vehicle. */
  front: number;
  back: number;
  /** The height of its middle, and its depth there. */
  y: number;
  thick: number;
}

/**
 * A wing through `chords`, given from one tip to the other: a flat six-sided
 * section, thickest a third of the way back, with a sharp trailing edge.
 */
export function wing(chords: readonly Chord[], colour: number): VehicleBox {
  return solid(
    chords.map((c) => {
      const along = (share: number): number => c.front + (c.back - c.front) * share;
      return [
        [c.front, c.y, c.z],
        [along(0.12), c.y + c.thick * 0.45, c.z],
        [along(0.45), c.y + c.thick / 2, c.z],
        [c.back, c.y + c.thick * 0.1, c.z],
        [along(0.45), c.y - c.thick / 2, c.z],
        [along(0.12), c.y - c.thick * 0.4, c.z],
      ] as Point[];
    }),
    colour,
  );
}

/** One cross-section of a fin, at height `y`. */
export interface FinSection {
  y: number;
  front: number;
  back: number;
  half: number;
  z?: number;
}

/** A fin standing up through `sections`, given from its root to its tip. */
export function fin(sections: readonly FinSection[], colour: number): VehicleBox {
  return solid(
    sections.map((s) => {
      const z = s.z ?? 0;
      const mid = s.front + (s.back - s.front) * 0.35;
      return [
        [s.front, s.y, z],
        [mid, s.y, z + s.half],
        [s.back, s.y, z],
        [mid, s.y, z - s.half],
      ] as Point[];
    }),
    colour,
  );
}

/** An eight-sided disc, a wheel or a hub, turning about the vehicle's cross axis. */
export function disc(x: number, y: number, z: number, radius: number, width: number, colour: number): VehicleBox {
  const ring = (at: number): Point[] =>
    Array.from({ length: 8 }, (_, k): Point => {
      const angle = ((k + 0.5) * Math.PI) / 4;
      return [x + radius * Math.cos(angle), y + radius * Math.sin(angle), at];
    });
  return solid([ring(z - width / 2), ring(z + width / 2)], colour);
}

/** One cross-section of a hull that floats: a keel, a chine each side, and the gunwale. */
export interface HullSection {
  x: number;
  keel: number;
  chine: number;
  top: number;
  half: number;
}

/** A V-bottomed hull through `sections`, bow first. */
export function vHull(sections: readonly HullSection[], colour: number): VehicleBox {
  return solid(
    sections.map((s): Point[] => [
      [s.x, s.keel, 0],
      [s.x, s.chine, s.half * 0.85],
      [s.x, s.top, s.half],
      [s.x, s.top, -s.half],
      [s.x, s.chine, -s.half * 0.85],
    ]),
    colour,
  );
}

/** Polygons in the vehicle's frame as one part of one colour, about the middle of their bounds. */
export function partFrom(faces: readonly Point[][], colour: number): VehicleBox {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const face of faces) {
    for (const p of face) {
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a] as number, p[a] as number);
        hi[a] = Math.max(hi[a] as number, p[a] as number);
      }
    }
  }
  const mid = lo.map((l, a) => (l + (hi[a] as number)) / 2) as Point;
  return {
    length: (hi[0] as number) - (lo[0] as number),
    height: (hi[1] as number) - (lo[1] as number),
    width: (hi[2] as number) - (lo[2] as number),
    x: mid[0],
    y: mid[1],
    z: mid[2],
    colour,
    panel: undefined,
    faces: faces.map((face) => face.flatMap((p) => [p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]])),
  };
}

/**
 * The sections of a strip bent round a wheel: a mudguard over the wheel at
 * `x`, `y` of `radius`, from `from` to `to` radians measured from forward and
 * upward, `thick` deep and `half` wide.
 */
export function arc(x: number, y: number, radius: number, from: number, to: number, thick: number, half: number, steps = 5): Section[] {
  const out: Section[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = from + ((to - from) * i) / steps;
    const top = y + radius * Math.sin(angle) + thick;
    out.push({ x: x + radius * Math.cos(angle), bottom: top - thick, top, half });
  }
  return out;
}

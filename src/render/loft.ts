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
  const faces: Point[][] = [];
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i] as Point[];
    const b = rings[i + 1] as Point[];
    for (let k = 0; k < 8; k++) faces.push([a[k] as Point, a[(k + 1) % 8] as Point, b[(k + 1) % 8] as Point, b[k] as Point]);
  }
  faces.push([...(rings[0] as Point[])].reverse(), rings[rings.length - 1] as Point[]);
  return partFrom(faces, colour);
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

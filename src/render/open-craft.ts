/**
 * The two vehicles with no cabin to loft a hull round: the beach buggy and
 * the speedboat (spec sections 10.1, 11.3), in the clean low-poly of
 * `docs/art-style.md`. Each is a lofted body with its seats, its engine and
 * its rails laid on top, where the cars close a roof over theirs.
 */
import type { VehicleSpec } from '../sim/vehicle.ts';
import { arc, loft, vHull, type Section } from './loft.ts';
import { box, GLASS, LAMP, METAL, SEAT, TAIL, type VehicleBox } from './vehicle-parts.ts';

/** The black of an air intake and of an engine's cowling vents. */
const DARK = 0x1b1d22;

/** A section at `x`, from `bottom` to `top`, `half` wide, its middle at `z`. */
function at(x: number, bottom: number, top: number, half: number, z = 0): Section {
  return { x, bottom, top, half, z };
}

/** The same sections, moved across to `z`. */
function across(sections: readonly Section[], z: number): Section[] {
  return sections.map((s) => ({ ...s, z }));
}

/**
 * A beach buggy: a tub with a sloping nose, a flared wing over each fat
 * tyre, two bucket seats under a roll cage, and the engine out behind.
 */
export function buggy(spec: VehicleSpec): VehicleBox[] {
  const l = spec.halfLength;
  const wheel = spec.wheels[0];
  const wheelY = (wheel?.y ?? -0.3) - spec.suspensionRest;
  const axle = Math.abs(wheel?.x ?? 1.25);
  const track = Math.abs(wheel?.z ?? 0.96);
  const parts = [
    loft([at(l, -0.5, -0.32, 0.46), at(l - 0.45, -0.58, -0.1, 0.66), at(0.5, -0.62, -0.06, 0.7), at(-0.9, -0.62, -0.04, 0.7), at(-l + 0.45, -0.55, -0.08, 0.58)], spec.paint, 0.45),
    // The engine, out in the air behind the seats, with its intakes on top.
    loft([at(-l + 0.55, -0.45, 0.12, 0.42), at(-l + 0.1, -0.4, 0.1, 0.38), at(-l, -0.35, 0.02, 0.3)], spec.trim, 0.45),
    loft([at(-l + 0.45, 0.12, 0.26, 0.1, 0.2), at(-l + 0.25, 0.12, 0.26, 0.1, 0.2)], DARK, 0.5),
    loft([at(-l + 0.45, 0.12, 0.26, 0.1, -0.2), at(-l + 0.25, 0.12, 0.26, 0.1, -0.2)], DARK, 0.5),
    // The roll cage: a hoop behind the seats, and a bar from its top down to
    // the front of the tub each side.
    box(0.07, 0.07, 1.2, METAL, -0.5, 0.78, 0),
  ];
  for (const side of [1, -1]) {
    const z = side * track;
    parts.push(loft(across(arc(axle, wheelY, spec.wheelRadius + 0.06, 0.25, 2.75, 0.05, 0.22), z), spec.paint));
    parts.push(loft(across(arc(-axle, wheelY, spec.wheelRadius + 0.06, 0.4, 2.6, 0.05, 0.22), z), spec.paint));
    // A bucket seat each side of the middle.
    parts.push(loft([at(0.3, -0.06, 0.06, 0.2, side * 0.32), at(-0.2, -0.06, 0.1, 0.24, side * 0.32), at(-0.3, -0.06, 0.12, 0.22, side * 0.32)], SEAT, 0.5));
    parts.push(loft([at(-0.3, -0.04, 0.3, 0.22, side * 0.32), at(-0.42, 0.1, 0.55, 0.2, side * 0.32)], SEAT, 0.5));
    parts.push(box(0.07, 0.8, 0.07, METAL, -0.5, 0.38, side * 0.6));
    parts.push(loft([at(-0.46, 0.72, 0.78, 0.035, side * 0.6), at(0.9, -0.02, 0.04, 0.035, side * 0.56)], METAL, 0.5));
    // Round lamps on the nose, and a tail light each side of the engine.
    parts.push(loft([at(l + 0.02, -0.38, -0.24, 0.07, side * 0.32), at(l - 0.08, -0.4, -0.22, 0.09, side * 0.32)], LAMP, 0.5));
    parts.push(box(0.06, 0.1, 0.12, TAIL, -l + 0.02, -0.12, side * 0.36));
  }
  return parts;
}

/**
 * A speedboat: a V hull that rises to a sharp bow, a rail round the foredeck,
 * a raked screen over the helm, two bucket seats and a bench, and the
 * outboard at the stern.
 */
export function boat(spec: VehicleSpec): VehicleBox[] {
  const l = spec.halfLength;
  const w = spec.halfWidth;
  const deck = 0.28;
  const parts = [
    vHull([
      { x: l, keel: 0.02, chine: 0.12, top: deck + 0.06, half: 0.04 },
      { x: l - 0.8, keel: -0.5, chine: -0.25, top: deck + 0.03, half: w * 0.66 },
      { x: l - 2, keel: -0.68, chine: -0.42, top: deck, half: w * 0.95 },
      { x: -l + 0.6, keel: -0.7, chine: -0.45, top: deck, half: w },
      { x: -l, keel: -0.62, chine: -0.4, top: deck, half: w * 0.96 },
    ], spec.paint),
    // The cockpit floor, and a stripe of the trim down each flank.
    loft([at(0.5, deck - 0.02, deck + 0.02, w * 0.78), at(-l + 0.4, deck - 0.02, deck + 0.02, w * 0.84)], spec.trim, 0.3),
    // The screen, raked back over the helm, and the helm behind it.
    loft([at(0.75, deck, deck + 0.04, w * 0.8), at(0.45, deck, deck + 0.38, w * 0.74), at(0.38, deck, deck + 0.38, w * 0.72)], GLASS, 0.3),
    loft([at(0.3, deck, deck + 0.3, 0.26, -w * 0.4), at(0.05, deck, deck + 0.4, 0.28, -w * 0.4)], spec.trim, 0.45),
    // A bench across the stern, and the outboard hung off it on its leg.
    loft([at(-l + 1, deck, deck + 0.18, w * 0.8), at(-l + 0.4, deck, deck + 0.3, w * 0.82)], SEAT, 0.45),
    loft([at(-l + 0.05, -0.1, 0.58, 0.2), at(-l - 0.25, -0.05, 0.62, 0.22), at(-l - 0.42, 0.05, 0.55, 0.16)], spec.trim, 0.5),
    loft([at(-l + 0.02, 0.35, 0.5, 0.21), at(-l - 0.1, 0.35, 0.5, 0.21)], DARK, 0.5),
    loft([at(-l - 0.1, -0.72, -0.1, 0.06), at(-l - 0.28, -0.72, -0.05, 0.05)], METAL, 0.5),
  ];
  for (const side of [1, -1]) {
    parts.push(loft([at(-0.35, deck, deck + 0.14, 0.22, side * w * 0.4), at(-0.75, deck, deck + 0.14, 0.24, side * w * 0.4)], SEAT, 0.5));
    parts.push(loft([at(-0.75, deck, deck + 0.5, 0.22, side * w * 0.4), at(-0.88, deck + 0.1, deck + 0.52, 0.2, side * w * 0.4)], SEAT, 0.5));
    // The bow rail: a bar from the stem back along each side, on two posts.
    parts.push(loft([at(l - 0.1, deck + 0.24, deck + 0.28, 0.02, side * 0.06), at(l - 1.2, deck + 0.24, deck + 0.28, 0.02, side * w * 0.72), at(l - 2.1, deck + 0.24, deck + 0.28, 0.02, side * w * 0.86)], METAL, 0.5));
    for (const [x, z] of [[l - 1.2, w * 0.72], [l - 2.1, w * 0.86]] as const) parts.push(box(0.03, 0.26, 0.03, METAL, x, deck + 0.13, side * z));
  }
  return parts;
}

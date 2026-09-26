/**
 * The shapes of the aircraft (spec sections 10.1, 11.3), in the clean
 * low-poly of `docs/art-style.md`: a fuselage lofted nose to tail, wings and
 * tailplanes that taper to their tips, fins that lean back, and glass that
 * wraps the nose.
 *
 * From 60 m up an aircraft is a plan view, so what matters is its outline on
 * the ground: the cross of a rotor over a cabin and a boom, or the span of a
 * wing across a fuselage with a tailplane behind it. The wings and the rotor
 * are wider than the body the physics holds, which is the fuselage alone.
 *
 * A rotor and a propeller are marked `spin`, and the model of the player's own
 * aircraft turns them while they fly it (`vehicle.ts`). Parked, they stand.
 */
import type { AircraftClass } from '../../world/types.ts';
import type { VehicleSpec } from '../../sim/vehicles/vehicle.ts';
import { disc, fin, loft, wing, type Section } from './loft.ts';
import { BEACON_BLUE, BEACON_RED, box, GLASS, LAMP, METAL, TAIL, TYRE, type VehicleBox } from './vehicle-parts.ts';

/** The black of an engine's intake and exhaust, and of a rotor blade. */
const DARK = 0x1b1d22;

/** A section of a round fuselage, `half` wide and as tall as `bottom` to `top`. */
function at(x: number, bottom: number, top: number, half: number, z = 0): Section {
  return { x, bottom, top, half, z };
}

/** The same sections, a little larger, cut to the band from `bottom` up. */
function skin(sections: readonly Section[], bottom: number, grow = 0.04): Section[] {
  return sections.map((s) => ({ ...s, bottom: Math.max(s.bottom, bottom), top: s.top + grow, half: s.half + grow }));
}

/**
 * A rotor over the hub at `x`, `y`: two blades crossed, each tapering to its
 * tips, turning about the vehicle's up axis, over a mast and a hub.
 */
function rotor(span: number, x: number, y: number, mast = 0.35): VehicleBox[] {
  const r = span / 2;
  return [
    { ...loft([at(x + r, y - 0.025, y + 0.025, 0.1), at(x, y - 0.04, y + 0.04, 0.16), at(x - r, y - 0.025, y + 0.025, 0.1)], DARK, 0.3), spin: 'rotor' },
    {
      ...wing([
        { z: -r, front: x + 0.1, back: x - 0.1, y, thick: 0.05 },
        { z: 0, front: x + 0.16, back: x - 0.16, y, thick: 0.08 },
        { z: r, front: x + 0.1, back: x - 0.1, y, thick: 0.05 },
      ], DARK),
      spin: 'rotor',
    },
    loft([at(x + 0.25, y - 0.1, y + 0.02, 0.18), at(x - 0.25, y - 0.1, y + 0.02, 0.18)], METAL, 0.5),
    loft([at(x + 0.08, y - mast, y - 0.08, 0.08), at(x - 0.08, y - mast, y - 0.08, 0.08)], METAL, 0.5),
  ];
}

/** A propeller at the nose, turning about the vehicle's forward axis, before a spinner. */
function propeller(nose: number, y: number, span: number, colour: number): VehicleBox[] {
  const r = span / 2;
  return [
    { ...fin([{ y: y - r, front: nose + 0.1, back: nose + 0.02, half: 0.03 }, { y: y + r, front: nose + 0.1, back: nose + 0.02, half: 0.03 }], DARK), spin: 'prop' },
    { ...wing([{ z: -r, front: nose + 0.1, back: nose + 0.02, y, thick: 0.03 }, { z: r, front: nose + 0.1, back: nose + 0.02, y, thick: 0.03 }], DARK), spin: 'prop' },
    loft([at(nose + 0.32, y - 0.02, y + 0.02, 0.02), at(nose + 0.05, y - 0.16, y + 0.16, 0.16), at(nose - 0.1, y - 0.18, y + 0.18, 0.18)], colour, 0.5),
  ];
}

/** A pair of wings from `root` out to `tip` each side, the tips `sweep` behind the root and `lift` above it. */
function wings(root: Omit<Chord, 'z'>, tip: { z: number; chord: number; sweep: number; lift?: number; thick?: number }, colour: number): VehicleBox {
  const tipChord = (side: number): Chord => ({
    z: side * tip.z,
    front: root.front - tip.sweep,
    back: root.front - tip.sweep - tip.chord,
    y: root.y + (tip.lift ?? 0),
    thick: tip.thick ?? root.thick * 0.6,
  });
  return wing([tipChord(-1), { ...root, z: 0 }, tipChord(1)], colour);
}

type Chord = { z: number; front: number; back: number; y: number; thick: number };

/** A tail fin from the top of the tail at `x` up to `top`, leaning back, `chord` long at its root. */
function tailFin(x: number, root: number, top: number, chord: number, colour: number, z = 0, half = 0.07): VehicleBox {
  return fin([
    { y: root, front: x + chord, back: x, half, z },
    { y: top, front: x + chord * 0.35, back: x - chord * 0.15, half: half * 0.6, z },
  ], colour);
}

/** A skid each side: a tube along the ground, turned up at the front, on two struts. */
function skids(front: number, back: number, bottom: number, belly: number, z: number): VehicleBox[] {
  const out: VehicleBox[] = [];
  for (const side of [1, -1]) {
    out.push(loft([at(front + 0.35, bottom + 0.18, bottom + 0.25, 0.04, side * z), at(front, bottom, bottom + 0.07, 0.045, side * z), at(back, bottom, bottom + 0.07, 0.045, side * z)], METAL, 0.5));
    for (const x of [front - 0.3, back + 0.4]) out.push(box(0.07, belly - bottom, 0.07, METAL, x, (belly + bottom) / 2, side * z * 0.85));
  }
  return out;
}

/**
 * A helicopter's pod: a rounded cabin, glass wrapped round its nose, a boom
 * out to a fin with a tail rotor and a tailplane, and a skid under each side.
 */
function helicopter(spec: VehicleSpec, cabin: number, rotorX: number): VehicleBox[] {
  const l = spec.halfLength;
  const h = spec.halfHeight;
  const w = spec.halfWidth;
  const cl = 2 * l * cabin;
  const back = l - cl;
  const nose = [at(l, -h * 0.45, h * 0.05, w * 0.3), at(l - cl * 0.22, -h * 0.8, h * 0.5, w * 0.82), at(l - cl * 0.5, -h * 0.85, h * 0.7, w)];
  const pod = [
    ...nose,
    at(back + cl * 0.1, -h * 0.8, h * 0.68, w * 0.92),
    at(back - 0.5, -h * 0.1, h * 0.5, w * 0.45),
    at(-l + 0.6, h * 0.12, h * 0.36, w * 0.16),
    at(-l, h * 0.14, h * 0.34, w * 0.13),
  ];
  return [
    loft(pod, spec.paint, 0.45),
    loft(skin(nose.slice(0, 2), -h * 0.3, 0.03).concat(at(l - cl * 0.42, -h * 0.25, h * 0.73, w * 1.01)), GLASS, 0.45),
    // The engine and its cowling behind the mast.
    loft([at(rotorX + 0.6, h * 0.5, h * 0.72, w * 0.4), at(rotorX - 0.3, h * 0.5, h * 0.95, w * 0.5), at(rotorX - 1.6, h * 0.4, h * 0.66, w * 0.3)], spec.trim, 0.5),
    loft([at(rotorX - 1.62, h * 0.46, h * 0.62, w * 0.2), at(rotorX - 1.75, h * 0.46, h * 0.62, w * 0.2)], DARK, 0.5),
    tailFin(-l, h * 0.3, h * 1.45, 0.9, spec.trim, 0, 0.06),
    wings({ front: -l + 1.3, back: -l + 0.8, y: h * 0.25, thick: 0.08 }, { z: w * 0.95, chord: 0.35, sweep: 0.1 }, spec.trim),
    disc(-l + 0.1, h * 0.9, w * 0.2, 0.42, 0.04, DARK),
    disc(-l + 0.1, h * 0.9, w * 0.14, 0.09, 0.1, METAL),
    ...skids(back + cl * 0.9, back - 0.1, -h, -h * 0.7, w * 0.95),
    ...rotor(2 * l * 0.95, rotorX, h + 0.14),
  ];
}

/** A light aircraft's fuselage: a spinner and a cowling, a cabin, and a tail that narrows and rises. */
function fuselage(spec: VehicleSpec, widen = 1, rise = 0): VehicleBox {
  const l = spec.halfLength;
  const h = spec.halfHeight;
  const w = spec.halfWidth * widen;
  return loft([
    at(l, -h * 0.35 + rise, h * 0.25 + rise, w * 0.4),
    at(l - 1.1, -h * 0.55 + rise, h * 0.45 + rise, w * 0.8),
    at(l * 0.15, -h * 0.55 + rise, h * 0.6 + rise, w * 0.82),
    at(-l * 0.35, -h * 0.25 + rise, h * 0.45 + rise, w * 0.45),
    at(-l, h * 0.05 + rise, h * 0.35 + rise, w * 0.12),
  ], spec.paint, 0.45);
}

/** Glass round a cabin between `front` and `back`, from `bottom` up to `top`. */
function cabinGlass(front: number, back: number, bottom: number, top: number, half: number): VehicleBox {
  return loft([at(front, bottom, top * 0.7, half * 0.8), at(front - (front - back) * 0.3, bottom, top, half), at(back, bottom, top * 0.9, half * 0.9)], GLASS, 0.45);
}

/** A wheel on a leg, for an aircraft that lands on wheels. */
function gear(x: number, y: number, z: number, radius: number, belly: number): VehicleBox[] {
  return [disc(x, y + radius, z, radius, 0.14, TYRE), box(0.08, belly - y - radius, 0.06, METAL, x, (belly + y + radius) / 2, z * 0.8)];
}

/** The parts of each aircraft, before they are told which panel they are on. */
export function aircraftBoxes(spec: VehicleSpec): VehicleBox[] {
  const l = spec.halfLength;
  const h = spec.halfHeight;
  const w = spec.halfWidth;
  switch (spec.cls as AircraftClass) {
    case 'heli-light':
      return helicopter(spec, 0.42, l * 0.25);
    case 'heli-police':
      return [
        ...helicopter(spec, 0.46, l * 0.22),
        // A band of the trim round the cabin, the searchlight under the nose,
        // a beacon at each side of the roof and the gun at the left door.
        loft([at(l * 0.62, -h * 0.5, -h * 0.28, w * 0.97), at(l * 0.12, -h * 0.5, -h * 0.28, w * 0.98)], spec.trim, 0.3),
        loft([at(l * 0.95, -h * 0.95, -h * 0.65, 0.12), at(l * 0.8, -h * 1.02, -h * 0.62, 0.2), at(l * 0.66, -h * 0.95, -h * 0.7, 0.14)], METAL, 0.5),
        box(0.04, 0.22, 0.26, LAMP, l * 0.965, -h * 0.82, 0),
        loft([at(l * 0.42, h * 0.66, h * 0.8, 0.14, w * 0.45), at(l * 0.28, h * 0.66, h * 0.8, 0.14, w * 0.45)], BEACON_BLUE, 0.5),
        loft([at(l * 0.42, h * 0.66, h * 0.8, 0.14, -w * 0.45), at(l * 0.28, h * 0.66, h * 0.8, 0.14, -w * 0.45)], BEACON_RED, 0.5),
        loft([at(l * 0.5 + 0.7, -h * 0.4, -h * 0.28, 0.05, w * 1.12), at(l * 0.5, -h * 0.47, -h * 0.25, 0.1, w * 1.12), at(l * 0.5 - 0.5, -h * 0.47, -h * 0.25, 0.1, w * 1.12)], METAL, 0.5),
      ];
    case 'heli-transport': {
      const nose = [at(l, -h * 0.55, h * 0.15, w * 0.55), at(l - 1.1, -h * 0.9, h * 0.62, w * 0.94)];
      return [
        loft([...nose, at(l - 2.2, -h * 0.95, h * 0.75, w), at(-l + 1.8, -h * 0.95, h * 0.8, w), at(-l, -h * 0.15, h * 0.8, w * 0.82)], spec.paint, 0.4),
        loft([...skin(nose, -h * 0.2, 0.03), at(l - 1.6, -h * 0.2, h * 0.73, w * 1.01)], GLASS, 0.4),
        // A row of round-cornered windows down each side, and the stripe under them.
        loft([at(l - 2.4, h * 0.05, h * 0.35, w * 1.01), at(-l + 2.4, h * 0.05, h * 0.35, w * 1.01)], GLASS, 0.3),
        loft([at(l - 2.3, -h * 0.35, -h * 0.2, w * 1.01), at(-l + 1.9, -h * 0.35, -h * 0.2, w * 1.01)], spec.trim, 0.3),
        // The pylon at the back that lifts the rear rotor over the front one,
        // and a pod each side for the engines.
        loft([at(-l + 3.4, h * 0.75, h * 0.85, w * 0.5), at(-l + 2, h * 0.75, h * 1.5, w * 0.6), at(-l + 0.3, h * 0.7, h * 1.5, w * 0.45)], spec.paint, 0.45),
        loft([at(l * 0.62 + 0.8, h * 0.7, h * 0.8, w * 0.4), at(l * 0.62, h * 0.7, h * 0.95, w * 0.45), at(l * 0.62 - 0.9, h * 0.7, h * 0.82, w * 0.35)], spec.paint, 0.45),
        ...[1, -1].map((side) => loft([at(-l + 3.2, h * 0.9, h * 1.15, 0.26, side * w * 0.72), at(-l + 2.4, h * 0.85, h * 1.2, 0.32, side * w * 0.72), at(-l + 0.9, h * 0.88, h * 1.15, 0.26, side * w * 0.72)], spec.trim, 0.5)),
        // A sponson low on each side over the wheels.
        ...[1, -1].map((side) => loft([at(l * 0.3, -h * 0.9, -h * 0.4, 0.2, side * (w + 0.12)), at(0, -h, -h * 0.35, 0.3, side * (w + 0.12)), at(-l * 0.35, -h * 0.9, -h * 0.4, 0.2, side * (w + 0.12))], spec.trim, 0.5)),
        ...[1, -1].flatMap((side) => gear(0, -h, side * (w + 0.1), 0.3, -h * 0.5)),
        ...rotor(2 * l * 0.62, l * 0.62, h * 0.95 + 0.14, 0.2),
        ...rotor(2 * l * 0.62, -l * 0.62, h * 1.5 + 0.14, 0.2),
      ];
    }
    case 'heli-attack': {
      const pod = [at(l, -h * 0.4, h * 0.0, w * 0.4), at(l * 0.6, -h * 0.7, h * 0.4, w * 0.85), at(l * 0.1, -h * 0.7, h * 0.55, w), at(-l * 0.2, -h * 0.35, h * 0.5, w * 0.6), at(-l * 0.5, h * 0.1, h * 0.45, w * 0.3), at(-l, h * 0.15, h * 0.4, w * 0.2)];
      return [
        loft(pod, spec.paint, 0.45),
        // Two seats in tandem, each under its own step of glass.
        loft([at(l * 0.85, h * 0.0, h * 0.2, w * 0.42), at(l * 0.62, h * 0.1, h * 0.72, w * 0.82), at(l * 0.42, h * 0.3, h * 0.6, w * 0.8)], GLASS, 0.45),
        loft([at(l * 0.42, h * 0.3, h * 0.95, w * 0.82), at(l * 0.2, h * 0.45, h * 1.0, w * 0.85), at(l * 0.02, h * 0.5, h * 0.7, w * 0.7)], GLASS, 0.45),
        // A stub wing each side with a pod of rockets under its tip, and the
        // gun under the chin.
        wings({ front: l * 0.1 + 0.6, back: l * 0.1 - 0.6, y: -h * 0.05, thick: 0.18 }, { z: w + 1.3, chord: 0.8, sweep: 0.3, lift: -0.15 }, spec.paint),
        ...[1, -1].map((side) => loft([at(l * 0.1 + 0.8, -h * 0.55, -h * 0.35, 0.08, side * (w + 1)), at(l * 0.1 + 0.5, -h * 0.65, -h * 0.25, 0.2, side * (w + 1)), at(l * 0.1 - 0.7, -h * 0.65, -h * 0.25, 0.2, side * (w + 1))], spec.trim, 0.5)),
        loft([at(l + 0.5, -h * 0.72, -h * 0.64, 0.04), at(l - 0.1, -h * 0.75, -h * 0.6, 0.07), at(l - 0.5, -h * 0.9, -h * 0.5, 0.2)], METAL, 0.5),
        // The engines each side of the mast, their exhausts turned out.
        ...[1, -1].map((side) => loft([at(l * 0.1 + 0.6, h * 0.45, h * 0.7, 0.2, side * w * 0.55), at(l * 0.1, h * 0.45, h * 0.8, 0.26, side * w * 0.55), at(-l * 0.25, h * 0.45, h * 0.7, 0.2, side * w * 0.6)], spec.trim, 0.5)),
        tailFin(-l, h * 0.3, h * 1.5, 1.1, spec.trim, 0, 0.08),
        wings({ front: -l + 1.6, back: -l + 0.9, y: h * 0.3, thick: 0.1 }, { z: w + 0.5, chord: 0.45, sweep: 0.15 }, spec.trim),
        disc(-l + 0.2, h * 0.95, 0.15, 0.55, 0.04, DARK),
        ...[1, -1].flatMap((side) => gear(l * 0.45, -h, side * w * 0.9, 0.18, -h * 0.6)),
        ...gear(-l + 0.6, -h * 0.2, 0, 0.13, h * 0.15),
        ...rotor(2 * l * 0.95, l * 0.05, h + 0.14),
      ];
    }
    case 'plane-light': {
      const body = fuselage(spec);
      return [
        body,
        cabinGlass(l - 1.1, l * 0.05, h * 0.05, h * 0.62, w * 0.84),
        // The high wing over the cabin, tapering to its tips, on a strut each side.
        wings({ front: l * 0.2 + 0.8, back: l * 0.2 - 0.8, y: h * 0.68, thick: 0.16 }, { z: l * 1.3, chord: 1.1, sweep: 0.3 }, spec.paint),
        ...[1, -1].map((side) => wing([{ z: side * w * 0.7, front: l * 0.2 + 0.05, back: l * 0.2 - 0.1, y: -h * 0.4, thick: 0.05 }, { z: side * l * 0.6, front: l * 0.2 + 0.05, back: l * 0.2 - 0.1, y: h * 0.6, thick: 0.05 }], METAL)),
        wings({ front: -l * 0.7, back: -l - 0.05, y: h * 0.18, thick: 0.1 }, { z: 1.7, chord: 0.55, sweep: 0.2 }, spec.paint),
        tailFin(-l - 0.05, h * 0.3, h * 1.4, 1.1, spec.trim),
        ...propeller(l, 0, 1.9, spec.trim),
        ...[1, -1].flatMap((side) => gear(l * 0.05, -h, side * w * 1.1, 0.24, -h * 0.5)),
        ...gear(l - 0.6, -h, 0, 0.2, -h * 0.4),
      ];
    }
    case 'seaplane': {
      const body = fuselage(spec, 0.9, h * 0.2);
      return [
        body,
        cabinGlass(l - 1.2, l * 0.05, h * 0.25, h * 0.82, w * 0.76),
        wings({ front: l * 0.15 + 0.85, back: l * 0.15 - 0.85, y: h * 0.9, thick: 0.16 }, { z: l * 1.25, chord: 1.15, sweep: 0.3 }, spec.paint),
        wings({ front: -l * 0.7, back: -l - 0.05, y: h * 0.4, thick: 0.1 }, { z: 1.8, chord: 0.55, sweep: 0.2 }, spec.paint),
        tailFin(-l - 0.05, h * 0.5, h * 1.5, 1.1, spec.trim),
        ...propeller(l, h * 0.2, 1.9, spec.trim),
        // The floats it lands on, where a light plane has wheels: each a hull
        // with a pointed bow and a step under it, on two struts.
        ...[1, -1].flatMap((side) => [
          loft([at(l * 0.95, -h * 0.72, -h * 0.55, 0.05, side * w * 1.1), at(l * 0.7, -h * 0.98, -h * 0.5, 0.24, side * w * 1.1), at(-l * 0.1, -h, -h * 0.5, 0.26, side * w * 1.1), at(-l * 0.65, -h * 0.72, -h * 0.55, 0.1, side * w * 1.1)], spec.trim, 0.45),
          box(0.08, h * 0.75, 0.07, METAL, l * 0.4, -h * 0.15, side * w * 0.85),
          box(0.08, h * 0.75, 0.07, METAL, -l * 0.15, -h * 0.15, side * w * 0.85),
        ]),
      ];
    }
    case 'biplane': {
      const body = fuselage(spec, 0.85, -h * 0.15);
      return [
        body,
        // An open cockpit with a small screen before it.
        loft([at(-l * 0.05, h * 0.3, h * 0.36, w * 0.4), at(-l * 0.4, h * 0.3, h * 0.36, w * 0.36)], DARK, 0.5),
        cabinGlass(l * 0.05, -l * 0.05, h * 0.3, h * 0.6, w * 0.4),
        // Two wings, one over the other, in the trim, which is what reads as a
        // biplane from above: the lower one shows past the upper at the front.
        wings({ front: l * 0.35 + 0.65, back: l * 0.35 - 0.65, y: h * 0.8, thick: 0.14 }, { z: l * 1.15, chord: 1.0, sweep: 0.15 }, spec.trim),
        wings({ front: l * 0.2 + 0.6, back: l * 0.2 - 0.6, y: -h * 0.6, thick: 0.14 }, { z: l * 1.05, chord: 0.95, sweep: 0.15, lift: 0.1 }, spec.trim),
        ...[1, -1].flatMap((side) => [0.3, 0.9].map((share) => box(0.07, h * 1.35, 0.06, METAL, l * 0.28, h * 0.1, side * l * share))),
        wings({ front: -l * 0.65, back: -l - 0.05, y: h * 0.0, thick: 0.1 }, { z: 1.4, chord: 0.45, sweep: 0.2 }, spec.trim),
        tailFin(-l - 0.05, h * 0.1, h * 1.1, 0.9, spec.paint),
        ...propeller(l, -h * 0.15, 1.8, spec.paint),
        ...[1, -1].flatMap((side) => gear(l * 0.45, -h, side * w * 0.8, 0.26, -h * 0.55)),
      ];
    }
    case 'bizjet': {
      const root = l * 0.1 + 1.8;
      const span = l * 1.05;
      const body = [at(l + 0.1, -h * 0.25, h * 0.1, w * 0.2), at(l - 1.4, -h * 0.75, h * 0.6, w * 0.82), at(l - 3, -h * 0.8, h * 0.8, w), at(-l * 0.45, -h * 0.8, h * 0.8, w), at(-l + 1.2, -h * 0.2, h * 0.7, w * 0.55), at(-l, h * 0.25, h * 0.6, w * 0.2)];
      return [
        loft(body, spec.paint, 0.45),
        loft([at(l - 0.5, h * 0.0, h * 0.3, w * 0.55), at(l - 1.3, h * 0.25, h * 0.64, w * 0.84), at(l - 1.8, h * 0.4, h * 0.66, w * 0.86)], GLASS, 0.45),
        // A row of windows down each side, and a cheat line under them.
        loft([at(l - 3.1, h * 0.25, h * 0.5, w * 1.01), at(-l * 0.45, h * 0.25, h * 0.5, w * 1.01)], GLASS, 0.3),
        loft([at(l - 1.2, -h * 0.05, h * 0.08, w * 0.9), at(l - 3, -h * 0.05, h * 0.08, w * 1.01), at(-l + 1.4, -h * 0.05, h * 0.08, w * 0.6)], spec.trim, 0.3),
        // Low wings swept back, with a winglet at each tip.
        wings({ front: root, back: -l * 0.1 - 1.6, y: -h * 0.6, thick: 0.3 }, { z: span, chord: 1.2, sweep: 3.2, lift: 0.35, thick: 0.12 }, spec.paint),
        ...[1, -1].map((side) => tailFin(root - 3.2 - 1.2, -h * 0.6 + 0.35, h * 0.6, 1.1, spec.trim, side * span, 0.05)),
        // An engine each side of the tail, on a pylon that runs from inside
        // the fuselage into the nacelle, so no daylight shows between them,
        // and a T-tail over them.
        ...[1, -1].flatMap((side) => [
          loft([at(-l * 0.4, h * 0.05, h * 0.75, 0.38, side * (w + 0.4)), at(-l * 0.5, 0, h * 0.8, 0.42, side * (w + 0.4)), at(-l * 0.75, h * 0.1, h * 0.7, 0.34, side * (w + 0.4))], spec.trim, 0.5),
          loft([at(-l * 0.4 + 0.02, h * 0.12, h * 0.68, 0.32, side * (w + 0.4)), at(-l * 0.4 + 0.01, h * 0.12, h * 0.68, 0.32, side * (w + 0.4))], DARK, 0.5),
          wing([{ z: side * w * 0.4, front: -l * 0.45, back: -l * 0.7, y: h * 0.4, thick: 0.3 }, { z: side * (w + 0.4), front: -l * 0.45, back: -l * 0.7, y: h * 0.4, thick: 0.3 }], spec.trim),
        ]),
        tailFin(-l + 0.1, h * 0.6, h * 2.6, 2.2, spec.trim, 0, 0.12),
        wings({ front: -l + 1.1, back: -l - 0.1, y: h * 2.6, thick: 0.12 }, { z: 2.7, chord: 0.6, sweep: 0.8 }, spec.trim),
        ...[1, -1].flatMap((side) => gear(-l * 0.05, -h, side * w * 1.4, 0.28, -h * 0.6)),
        ...gear(l - 1.5, -h, 0, 0.22, -h * 0.7),
      ];
    }
    case 'fighter': {
      const body = [at(l + 0.4, -h * 0.05, h * 0.05, 0.05), at(l - 1.2, -h * 0.4, h * 0.45, w * 0.35), at(l * 0.35, -h * 0.6, h * 0.65, w * 0.55), at(-l * 0.4, -h * 0.65, h * 0.6, w * 0.7), at(-l, -h * 0.5, h * 0.45, w * 0.62)];
      return [
        loft(body, spec.paint, 0.45),
        // A bubble canopy, and the intakes beside the cockpit.
        loft([at(l * 0.7, h * 0.35, h * 0.45, w * 0.1), at(l * 0.5, h * 0.35, h * 1.0, w * 0.3), at(l * 0.2, h * 0.4, h * 0.95, w * 0.28), at(-l * 0.02, h * 0.5, h * 0.6, w * 0.1)], GLASS, 0.5),
        ...[1, -1].flatMap((side) => [
          loft([at(l * 0.35, -h * 0.5, h * 0.25, w * 0.22, side * w * 0.6), at(-l * 0.1, -h * 0.55, h * 0.3, w * 0.28, side * w * 0.62), at(-l * 0.4, -h * 0.5, h * 0.25, w * 0.2, side * w * 0.6)], spec.paint, 0.4),
          loft([at(l * 0.36, -h * 0.42, h * 0.18, w * 0.18, side * w * 0.6), at(l * 0.34, -h * 0.42, h * 0.18, w * 0.18, side * w * 0.6)], DARK, 0.4),
        ]),
        // A delta: a long root that narrows to the tips, swept hard.
        wings({ front: l * 0.25, back: -l * 0.75, y: -h * 0.15, thick: 0.28 }, { z: l * 0.62, chord: 1.4, sweep: l * 0.62, thick: 0.08 }, spec.paint),
        wings({ front: -l * 0.7, back: -l - 0.2, y: -h * 0.15, thick: 0.14 }, { z: 2.6, chord: 0.6, sweep: 1, thick: 0.06 }, spec.paint),
        // Twin fins, canted a little apart, and the nozzle between them.
        ...[1, -1].map((side) => tailFin(-l * 0.95, h * 0.4, h * 1.9, 2.4, spec.trim, side * w * 0.45, 0.08)),
        loft([at(-l + 0.4, -h * 0.45, h * 0.4, w * 0.5), at(-l - 0.3, -h * 0.35, h * 0.3, w * 0.38)], METAL, 0.5),
        loft([at(-l - 0.28, -h * 0.3, h * 0.25, w * 0.33), at(-l - 0.32, -h * 0.3, h * 0.25, w * 0.33)], TAIL, 0.5),
        ...[1, -1].flatMap((side) => gear(-l * 0.25, -h, side * w * 0.9, 0.28, -h * 0.55)),
        ...gear(l * 0.55, -h, 0, 0.22, -h * 0.4),
      ];
    }
  }
}

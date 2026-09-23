/**
 * The shapes of the aircraft (spec sections 10.1, 11.3), in the boxes
 * `vehicle-mesh.ts` draws every vehicle with.
 *
 * From 60 m up an aircraft is a plan view, so what matters is its outline on
 * the ground: the cross of a rotor over a cabin and a boom, or the span of a
 * wing across a fuselage with a tailplane behind it. The wings and the rotor
 * are wider than the body the physics holds, which is the fuselage alone.
 *
 * A rotor and a propeller are marked `spin`, and the model of the player's own
 * aircraft turns them while they fly it (`vehicle.ts`). Parked, they stand.
 */
import type { AircraftClass } from '../world/types.ts';
import type { VehicleSpec } from '../sim/vehicle.ts';
import { BEACON_BLUE, BEACON_RED, GLASS, LAMP, METAL, TAIL, type VehicleBox } from './vehicle-mesh.ts';

/** The black of an engine's intake and exhaust. */
const DARK = 0x1b1d22;

/** One box of an aircraft, in the vehicle's own frame. */
function part(length: number, height: number, width: number, colour: number, x: number, y: number, z: number, outlined = true): VehicleBox {
  return { length, height, width, x, y, z, colour, outlined, panel: undefined };
}

/** A rotor: two blades crossed over a hub, turning about the vehicle's up axis. */
function rotor(span: number, x: number, y: number): VehicleBox[] {
  return [
    { ...part(span, 0.06, 0.3, DARK, x, y, 0, false), spin: 'rotor' },
    { ...part(0.3, 0.06, span, DARK, x, y, 0, false), spin: 'rotor' },
    part(0.4, 0.3, 0.4, METAL, x, y - 0.15, 0, false),
  ];
}

/** A propeller at the nose, turning about the vehicle's forward axis. */
function propeller(spec: VehicleSpec, y: number, span: number): VehicleBox[] {
  return [
    { ...part(0.08, span, 0.22, DARK, spec.halfLength + 0.06, y, 0, false), spin: 'prop' },
    { ...part(0.08, 0.22, span, DARK, spec.halfLength + 0.06, y, 0, false), spin: 'prop' },
  ];
}

/** A wing of `span` across and `chord` along, its middle at `x` and `y`. */
function wing(chord: number, span: number, x: number, y: number, colour: number, thick = 0.14): VehicleBox {
  return part(chord, thick, span, colour, x, y, 0);
}

/**
 * A helicopter's body: a cabin at the front with glass round its nose, a boom
 * out to a fin at the tail, and a skid under each side.
 */
function helicopter(spec: VehicleSpec, cabin: number): VehicleBox[] {
  const l = spec.halfLength;
  const h = spec.halfHeight;
  const w = spec.halfWidth;
  const cabinLength = 2 * l * cabin;
  const cabinX = l - cabinLength / 2;
  const boomLength = 2 * l - cabinLength;
  return [
    part(cabinLength, 2 * h * 0.78, 2 * w, spec.paint, cabinX, -h * 0.12, 0),
    part(cabinLength * 0.3, 2 * h * 0.5, 2 * w * 1.02, GLASS, l - cabinLength * 0.18, h * 0.05, 0, false),
    part(boomLength, h * 0.35, w * 0.4, spec.paint, -l + boomLength / 2, h * 0.15, 0),
    part(0.9, h * 1.1, 0.1, spec.trim, -l + 0.45, h * 0.55, 0),
    part(0.5, 0.06, w * 1.6, spec.trim, -l + 0.9, h * 0.15, 0, false),
    part(cabinLength * 1.05, 0.08, 0.1, METAL, cabinX, -h + 0.04, w * 0.85, false),
    part(cabinLength * 1.05, 0.08, 0.1, METAL, cabinX, -h + 0.04, -w * 0.85, false),
  ];
}

/** The boxes of each aircraft, before they are told which panel they are on. */
export function aircraftBoxes(spec: VehicleSpec): VehicleBox[] {
  const l = spec.halfLength;
  const h = spec.halfHeight;
  const w = spec.halfWidth;
  switch (spec.cls as AircraftClass) {
    case 'heli-light':
      return [...helicopter(spec, 0.42), ...rotor(2 * l * 0.95, l * 0.25, h + 0.12)];
    case 'heli-police':
      return [
        ...helicopter(spec, 0.46),
        ...rotor(2 * l * 0.95, l * 0.22, h + 0.12),
        // A band of the trim round the cabin, the searchlight under the nose,
        // a beacon at each side of the roof and the gun at the left door.
        part(2 * l * 0.3, 0.2, 2 * w * 1.03, spec.trim, l * 0.45, -h * 0.35, 0, false),
        part(0.5, 0.35, 0.5, LAMP, l * 0.85, -h * 0.85, 0, false),
        part(0.3, 0.15, 0.3, BEACON_BLUE, l * 0.35, h * 0.72, w * 0.5, false),
        part(0.3, 0.15, 0.3, BEACON_RED, l * 0.35, h * 0.72, -w * 0.5, false),
        part(1.4, 0.18, 0.18, METAL, l * 0.5, -h * 0.4, w * 1.15, false),
      ];
    case 'heli-transport':
      return [
        part(2 * l, 2 * h * 0.8, 2 * w, spec.paint, 0, -h * 0.1, 0),
        part(1.2, 2 * h * 0.45, 2 * w * 1.02, GLASS, l - 0.6, h * 0.05, 0, false),
        part(1.8, 2 * h * 0.35, 2 * w * 0.6, spec.paint, -l + 0.9, h * 0.75, 0),
        part(2 * l * 0.8, 0.08, 0.12, METAL, 0, -h + 0.04, w * 0.9, false),
        part(2 * l * 0.8, 0.08, 0.12, METAL, 0, -h + 0.04, -w * 0.9, false),
        ...rotor(2 * l * 0.62, l * 0.62, h * 0.72 + 0.12),
        ...rotor(2 * l * 0.62, -l * 0.62, h * 1.1 + 0.12),
      ];
    case 'heli-attack':
      return [
        ...helicopter(spec, 0.5),
        // Two seats in tandem under their own glass, and a stub wing each side
        // with a pod of rockets under it.
        part(2 * l * 0.28, h * 0.5, 2 * w * 0.9, GLASS, l * 0.55, h * 0.5, 0, false),
        wing(1, 2 * w + 2.6, l * 0.1, -h * 0.1, spec.paint),
        part(1.4, 0.35, 0.35, spec.trim, l * 0.1, -h * 0.35, w + 1, false),
        part(1.4, 0.35, 0.35, spec.trim, l * 0.1, -h * 0.35, -w - 1, false),
        part(0.8, 0.14, 0.14, METAL, l + 0.3, -h * 0.6, 0, false),
        ...rotor(2 * l * 0.95, l * 0.1, h + 0.12),
      ];
    case 'plane-light':
      return [
        part(2 * l * 0.95, 2 * h * 0.62, 2 * w * 0.85, spec.paint, -l * 0.05, -h * 0.1, 0),
        part(2 * l * 0.2, 2 * h * 0.3, 2 * w * 0.87, GLASS, l * 0.3, h * 0.3, 0, false),
        // The high wing over the cabin, the tailplane and the fin.
        wing(1.5, 2 * l * 1.3, l * 0.2, h * 0.62, spec.paint),
        wing(0.9, 3.4, -l * 0.88, h * 0.05, spec.paint, 0.1),
        part(1, h * 1.1, 0.1, spec.trim, -l * 0.9, h * 0.55, 0),
        ...propeller(spec, 0, 1.9),
      ];
    case 'seaplane':
      return [
        part(2 * l * 0.9, 2 * h * 0.55, 2 * w * 0.7, spec.paint, 0, h * 0.2, 0),
        part(2 * l * 0.18, 2 * h * 0.25, 2 * w * 0.72, GLASS, l * 0.35, h * 0.55, 0, false),
        wing(1.6, 2 * l * 1.25, l * 0.15, h * 0.85, spec.paint),
        wing(0.9, 3.6, -l * 0.85, h * 0.4, spec.paint, 0.1),
        part(1, h, 0.1, spec.trim, -l * 0.88, h * 0.85, 0),
        // The floats it lands on, where a light plane has wheels.
        part(2 * l * 0.8, h * 0.45, 0.5, spec.trim, l * 0.05, -h * 0.75, w * 1.1),
        part(2 * l * 0.8, h * 0.45, 0.5, spec.trim, l * 0.05, -h * 0.75, -w * 1.1),
        ...propeller(spec, h * 0.2, 1.9),
      ];
    case 'biplane':
      return [
        part(2 * l * 0.95, 2 * h * 0.5, 2 * w * 0.7, spec.paint, -l * 0.05, -h * 0.15, 0),
        part(0.9, 0.3, 2 * w * 0.5, GLASS, -l * 0.15, h * 0.2, 0, false),
        // Two wings, one over the other, in the trim, which is what reads as a
        // biplane from above: the lower one shows past the upper at the front.
        wing(1.3, 2 * l * 1.15, l * 0.35, h * 0.7, spec.trim),
        wing(1.2, 2 * l * 1.05, l * 0.2, -h * 0.6, spec.trim),
        wing(0.8, 2.8, -l * 0.88, h * 0.05, spec.trim, 0.1),
        part(0.9, h * 0.9, 0.1, spec.paint, -l * 0.9, h * 0.45, 0),
        ...propeller(spec, -h * 0.15, 1.8),
      ];
    case 'bizjet':
      return [
        part(2 * l, 2 * h * 0.8, 2 * w, spec.paint, 0, 0, 0),
        part(1.4, h * 0.6, 2 * w * 0.9, GLASS, l - 0.9, h * 0.3, 0, false),
        // A row of windows down each side.
        part(2 * l * 0.45, 0.3, 2 * w * 1.02, GLASS, l * 0.2, h * 0.25, 0, false),
        // Low wings a little swept, an engine each side of the tail, a T-tail.
        wing(3, 2 * l * 1.05, -l * 0.05, -h * 0.55, spec.paint, 0.2),
        wing(1.8, 2 * l * 0.55, l * 0.1, -h * 0.55, spec.paint, 0.2),
        part(2.6, 0.9, 0.9, spec.trim, -l * 0.62, h * 0.4, w + 0.5),
        part(2.6, 0.9, 0.9, spec.trim, -l * 0.62, h * 0.4, -w - 0.5),
        part(0.3, 0.8, 0.8, DARK, -l * 0.62 - 1.3, h * 0.4, w + 0.5, false),
        part(0.3, 0.8, 0.8, DARK, -l * 0.62 - 1.3, h * 0.4, -w - 0.5, false),
        part(2, h * 2.2, 0.2, spec.trim, -l + 1, h * 1.5, 0),
        wing(1.4, 5.4, -l + 0.9, h * 2.6, spec.trim, 0.12),
      ];
    case 'fighter':
      return [
        part(2 * l, 2 * h * 0.75, 2 * w * 0.7, spec.paint, 0, 0, 0),
        part(2.6, h * 0.6, 2 * w * 0.45, GLASS, l * 0.45, h * 0.7, 0, false),
        // A delta: a wide root that narrows toward the tips, drawn as two
        // wings of different spans.
        wing(2 * l * 0.45, 2 * l * 0.65, -l * 0.2, -h * 0.2, spec.paint, 0.2),
        wing(2 * l * 0.22, 2 * l * 0.95, -l * 0.3, -h * 0.2, spec.paint, 0.18),
        wing(1.6, 5.2, -l * 0.92, -h * 0.1, spec.paint, 0.14),
        part(2.2, h * 1.5, 0.15, spec.trim, -l * 0.75, h * 1.1, w * 0.45),
        part(2.2, h * 1.5, 0.15, spec.trim, -l * 0.75, h * 1.1, -w * 0.45),
        part(1.4, h * 0.8, 0.6, DARK, l * 0.25, -h * 0.2, w * 0.75, false),
        part(1.4, h * 0.8, 0.6, DARK, l * 0.25, -h * 0.2, -w * 0.75, false),
        part(0.3, h * 0.9, w * 0.9, TAIL, -l - 0.1, 0, 0, false),
      ];
  }
}

/**
 * What one part of a vehicle's model is, and the colours no roster row picks.
 *
 * `vehicle-mesh.ts` says which parts each class is made of, and
 * `vehicle-hull.ts` lofts the bodies of the road classes. Both build the
 * parts described here, so this file sits under both of them. It holds no
 * three.js: `vehicle-geometry.ts` turns a part into geometry.
 */
import type { Panel } from '../sim/damage.ts';
import { BONNET_LEAF } from '../sim/leaves.ts';

/** Glass, lamps and the bare metal of a cage: the colours no row picks. */
export const GLASS = 0x2e3a6a;
export const LAMP = 0xffe7b0;
export const TAIL = 0x6e1210;
export const METAL = 0xb8b3cc;
export const TYRE = 0x2f2838;
/** The dark of a seat, which is plum leather on every bike in the city. */
export const SEAT = 0x3a2a3e;
/** The blue-white of the arc at a tram's pantograph (`tram.ts`). */
export const SPARK = 0xbcd6ff;
/** The blue and red of a patrol car's light bar. */
export const BEACON_BLUE = 0x2f6fe0;
export const BEACON_RED = 0xd32c2c;
/** The underside of a body, and the engine bay a lost bonnet shows. */
export const UNDER = 0x1d2026;
/** The inside of a door and of the cabin. */
export const TRIM_INSIDE = 0x2c2433;

/**
 * How much of the light the glass lets through. The glass is tinted, so a car
 * keeps its look from above, and the people inside still show through it.
 */
export const GLASS_OPACITY = 0.55;

/**
 * The leaves of a vehicle that open: the four doors and the bonnet. A leaf is
 * its index in the record's `leaves` (`sim/leaves.ts`): 0 the driver's front
 * door, 1 the front door across from it, 2 and 3 the rear doors behind them,
 * and the bonnet after the doors.
 */
export const BONNET = BONNET_LEAF;

/**
 * Where a leaf turns. A door swings about the up axis at its front edge, the
 * bonnet about the axle axis at its rear edge, and the sliding door of a van
 * runs back along the flank.
 */
export interface Hinge {
  leaf: number;
  axis: 'y' | 'z' | 'slide';
  /** The point it turns about, in the vehicle's own frame. */
  x: number;
  y: number;
  z: number;
}

/** One part of a vehicle's model. */
export interface VehicleBox {
  length: number;
  height: number;
  width: number;
  /** The middle of the part, in the vehicle's own frame. */
  x: number;
  y: number;
  z: number;
  colour: number;
  /**
   * The panel this part belongs to (spec section 11.3), and undefined on the
   * shell in the middle of the body. A dent pushes in the parts of the panel
   * it lands on, and a panel torn off takes its parts with it; the shell stays,
   * because a vehicle with no middle is not a vehicle.
   */
  panel: Panel | undefined;
  /**
   * The faces of a part that is not a box, each a convex polygon as a flat
   * list of x, y, z about the part's middle, wound so it faces outwards. A
   * part without faces is the box its length, height and width say.
   */
  faces?: readonly (readonly number[])[];
  /**
   * The panel a lofted part was cut for, which `panelAt` cannot read off its
   * middle: a bonnet stands as high as a roof. 'shell' is no panel at all.
   */
  on?: Panel | 'shell';
  /** Set on a part of a leaf that opens: a door or the bonnet. */
  hinge?: Hinge;
  /** True on glass that is seen through. */
  glass?: boolean;
  /**
   * Set on a rotor blade, which turns about the vehicle's up axis, and on a
   * propeller blade, which turns about its forward axis (`aircraft-mesh.ts`).
   */
  spin?: 'rotor' | 'prop';
}

/** A box of one colour, standing on no panel until `vehicleBoxes` reads it. */
export function box(
  length: number,
  height: number,
  width: number,
  colour: number,
  x: number,
  y: number,
  z: number,
): VehicleBox {
  return { length, height, width, x, y, z, colour, panel: undefined };
}

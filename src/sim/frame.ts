/**
 * The vehicle's own frame: forward along local `+x`, up `+y`, axle `+z`.
 *
 * A vehicle's pose is a quaternion in the record, and everything the physics
 * does with a point of the vehicle — a wheel, a quarter of a hull, the panel a
 * blow landed on — is one of these two turns. They are written out rather than
 * built on a vector library so a tick allocates nothing.
 */
import type { VehicleState } from './vehicle.ts';

/** Turn an offset in world axes into the vehicle's own frame: {@link rotate} the other way. */
export function unrotate(out: { x: number; y: number; z: number }, v: VehicleState, x: number, y: number, z: number): void {
  // The conjugate of a unit quaternion is its inverse, so this is the same
  // product with the vector part negated.
  const tx = 2 * (v.qz * y - v.qy * z);
  const ty = 2 * (v.qx * z - v.qz * x);
  const tz = 2 * (v.qy * x - v.qx * y);
  out.x = x + v.qw * tx - v.qy * tz + v.qz * ty;
  out.y = y + v.qw * ty - v.qz * tx + v.qx * tz;
  out.z = z + v.qw * tz - v.qx * ty + v.qy * tx;
}

/** Turn a point of the vehicle's own frame into an offset in world axes. */
export function rotate(out: { x: number; y: number; z: number }, v: VehicleState, x: number, y: number, z: number): void {
  // q * (x, y, z) * q⁻¹, written out so a tick allocates nothing.
  const tx = 2 * (v.qy * z - v.qz * y);
  const ty = 2 * (v.qz * x - v.qx * z);
  const tz = 2 * (v.qx * y - v.qy * x);
  out.x = x + v.qw * tx + v.qy * tz - v.qz * ty;
  out.y = y + v.qw * ty + v.qz * tx - v.qx * tz;
  out.z = z + v.qw * tz + v.qx * ty - v.qy * tx;
}

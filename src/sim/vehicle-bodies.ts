/**
 * The player's vehicle as Rapier bodies (spec sections 11.3, 11.5): the moving
 * chassis and its wheels while somebody drives it, the fixed body while it is
 * parked, and the read of the stepped chassis back into the record.
 *
 * `physics.ts` owns the bodies these build and decides which one stands in the
 * world; this file only makes them from a {@link VehicleState} and reads them
 * back. The record stays the truth, so a body built here from a record and read
 * straight back gives the same numbers.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { rotate } from './frame.ts';
import type { VehicleSpec, VehicleState, WheelSpec, WheelState } from './vehicle.ts';

/**
 * Metres per second the vehicle has to be sliding across its own axle before a
 * tyre counts as skidding (spec section 11.3). It is one rule for every way of
 * getting there: a handbrake turn, a corner taken too fast and a spin all push
 * the vehicle sideways, and a tyre that is being pushed sideways is a tyre
 * leaving a mark. Below this the tyre is scrubbing, not sliding.
 */
const SKID_SLIP = 2.2;

/** A body, its collider and the wheels it drives on, or no wheels at all on a boat. */
export interface Built {
  chassis: RAPIER.RigidBody;
  wheels: RAPIER.DynamicRayCastVehicleController | undefined;
  collider: RAPIER.Collider;
}

/** A parked vehicle's fixed body and its collider. */
export interface Parked {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

/** Scratch vectors for the read, so a tick allocates nothing. */
const along = { x: 0, y: 0, z: 0 };
const across = { x: 0, y: 0, z: 0 };

/** Build the chassis body, its collider and the wheels, from the state. */
export function buildVehicle(world: RAPIER.World, spec: VehicleSpec, v: VehicleState): Built {
  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(v.x, v.y, v.z)
      .setRotation({ x: v.qx, y: v.qy, z: v.qz, w: v.qw })
      .setLinvel(v.vx, v.vy, v.vz)
      .setAngvel({ x: v.ax, y: v.ay, z: v.az })
      // Air drag, and enough angular damping that the body settles rather
      // than rocking on its springs.
      .setLinearDamping(spec.drag)
      .setAngularDamping(0.6),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(spec.halfLength, spec.halfHeight, spec.halfWidth)
      .setMass(spec.mass)
      // A hull slides over what it grounds on; a car body digs in.
      .setFriction(spec.hull === undefined ? 0.6 : 0.2),
    chassis,
  );
  if (spec.wheels.length === 0) return { chassis, wheels: undefined, collider };

  const wheels = world.createVehicleController(chassis);
  // Forward is the chassis' local +x and up is +y, the frame the model and
  // the map heading already share (`vehicle.ts`).
  wheels.setIndexForwardAxis = 0;
  wheels.indexUpAxis = 1;
  for (let i = 0; i < spec.wheels.length; i++) {
    const wheel = spec.wheels[i] as WheelSpec;
    wheels.addWheel(
      { x: wheel.x, y: wheel.y, z: wheel.z },
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 },
      spec.suspensionRest,
      spec.wheelRadius,
    );
    wheels.setWheelSuspensionStiffness(i, spec.suspensionStiffness);
    wheels.setWheelSuspensionCompression(i, spec.suspensionCompression);
    wheels.setWheelSuspensionRelaxation(i, spec.suspensionRelaxation);
    wheels.setWheelMaxSuspensionTravel(i, spec.suspensionTravel);
    wheels.setWheelMaxSuspensionForce(i, spec.maxSuspensionForce);
    wheels.setWheelSteering(i, (v.wheels[i] as WheelState).steer);
  }
  return { chassis, wheels, collider };
}

/**
 * The parked vehicle of spec section 11.5: the record's pose as a fixed body.
 *
 * Nothing drives it, so nothing has to simulate it, and the player walks
 * round it rather than through it. Entering it builds the moving body again
 * from the same record, so the car is where it was left.
 */
export function buildParked(world: RAPIER.World, spec: VehicleSpec, v: VehicleState): Parked {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation(v.x, v.y, v.z)
      .setRotation({ x: v.qx, y: v.qy, z: v.qz, w: v.qw }),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(spec.halfLength, spec.halfHeight, spec.halfWidth),
    body,
  );
  return { body, collider };
}

/** Read the vehicle's body and wheels back into its record. */
export function readVehicle(
  v: VehicleState,
  chassis: RAPIER.RigidBody,
  wheels: RAPIER.DynamicRayCastVehicleController | undefined,
  spec: VehicleSpec,
): void {
  const t = chassis.translation();
  const r = chassis.rotation();
  const linear = chassis.linvel();
  const angular = chassis.angvel();
  v.x = t.x;
  v.y = t.y;
  v.z = t.z;
  v.qx = r.x;
  v.qy = r.y;
  v.qz = r.z;
  v.qw = r.w;
  v.vx = linear.x;
  v.vy = linear.y;
  v.vz = linear.z;
  v.ax = angular.x;
  v.ay = angular.y;
  v.az = angular.z;
  if (wheels === undefined) {
    // A boat has no wheel to read a speed off, so the speed is what the hull
    // is making along its own length.
    rotate(along, v, 1, 0, 0);
    v.speed = v.vx * along.x + v.vy * along.y + v.vz * along.z;
    return;
  }
  v.speed = wheels.currentVehicleSpeed();
  // How fast the body is going across its own axle. A tyre on the ground
  // that is being pushed sideways this hard is sliding, not rolling, and a
  // sliding tyre leaves a mark (spec section 11.3).
  rotate(across, v, 0, 0, 1);
  const slip = v.vx * across.x + v.vy * across.y + v.vz * across.z;
  const sliding = Math.abs(slip) > SKID_SLIP;
  for (let i = 0; i < v.wheels.length; i++) {
    const wheel = v.wheels[i] as WheelState;
    wheel.rotation = wheels.wheelRotation(i) ?? wheel.rotation;
    wheel.steer = wheels.wheelSteering(i) ?? 0;
    wheel.suspension = wheels.wheelSuspensionLength(i) ?? spec.suspensionRest;
    wheel.contact = wheels.wheelIsInContact(i);
    wheel.skid = wheel.contact && sliding;
  }
}

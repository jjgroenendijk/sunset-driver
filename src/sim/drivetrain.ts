/**
 * What the driver's input does to the vehicle: the wheels of a car, the rider
 * of a two-wheeler and the hull of a boat (spec section 11.3).
 *
 * Everything here reads the roster row and the ground and writes forces into
 * Rapier. `physics.ts` owns the bodies and calls one of the three each tick;
 * `vehicle.ts` holds the numbers a vehicle is made of, and the grip table.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { Surface } from '../world/surface.ts';
import { TICK_RATE } from './clock.ts';
import { enginePowerScale } from './damage.ts';
import { rotate } from './frame.ts';
import type { Ground } from './ground-bodies.ts';
import type { InputFrame } from './input.ts';
import {
  gripOf,
  type HullSpec,
  type VehicleSpec,
  type VehicleState,
  type WheelSpec,
  type WheelState,
} from './vehicle.ts';

/** Metres per second squared. Earth's, so a car falls the way a car falls. */
const GRAVITY = 9.81;

/**
 * Metres per second under which a car with no throttle holds its brakes. Below
 * a walking pace a parked car should stay parked, on a hill as much as on the
 * flat.
 */
const PARKING_SPEED = 1.5;

/**
 * Points the buoyancy of a hull is taken at: one at each quarter of it, so a
 * boat pitches and rolls with the forces on it rather than bobbing as a point.
 */
const LIFT_POINTS = 4;

/**
 * How hard the rider damps the roll they are correcting, as a fraction of the
 * spring they correct it with.
 *
 * Both numbers are bounded by the tick, not by what a rider could do. The
 * correction is integrated once a step, so a damping of more than about half
 * the roll inertia per step overshoots and the bike shakes itself over instead
 * of settling. A motorcycle's roll inertia is about 15 kg m², so this and
 * `VehicleSpec.balance` are together a spring that settles in a third of a
 * second and is still stiffer than the gravity it holds the bike up against.
 */
const BALANCE_DAMPING = 0.1;

/** The controllers of one session. It owns no state but its scratch vectors. */
export class Drivetrain {
  private readonly ground: Ground;
  /** Scratch vectors, so a tick allocates nothing. */
  private readonly point = { x: 0, y: 0, z: 0 };
  private readonly axis = { x: 0, y: 0, z: 0 };
  private readonly force = { x: 0, y: 0, z: 0 };
  private readonly at = { x: 0, y: 0, z: 0 };

  constructor(ground: Ground) {
    this.ground = ground;
  }

  /** Apply the input to the wheels: steering, engine, brakes and the grip of the ground. */
  drive(controller: RAPIER.DynamicRayCastVehicleController, v: VehicleState, input: InputFrame, spec: VehicleSpec, wetness: number): void {
    const speed = v.speed;
    const forward = Math.abs(speed);

    // Steering closes down as the speed rises: full lock at any speed worth
    // driving at spins the car rather than turning it.
    const reach = Math.min(1, forward / spec.topSpeed);
    const limit = spec.maxSteer * (1 - (1 - spec.steerAtSpeed) * reach);
    // Rapier turns a wheel about the chassis' up axis, and the map's heading
    // runs the other way round the same axis, so steering right is negative
    // here. The state carries Rapier's angle, which is the one the model turns
    // its wheels by.
    const wanted = -input.steer * limit;

    // Throttle forward, and brake rather than change gear while still rolling
    // the other way. Reverse is geared short, so it is slow and it pulls hard.
    // A damaged engine gives less of its power, and a burnt-out one gives none
    // at all (spec section 11.3).
    const power = spec.enginePower * enginePowerScale(v.damage);
    let engine = 0;
    let pedal = 0;
    if (input.throttle > 0) {
      if (speed < -0.5) pedal = input.throttle;
      else engine = input.throttle * power * Math.max(0, 1 - speed / spec.topSpeed);
    } else if (input.throttle < 0) {
      if (speed > 0.5) pedal = -input.throttle;
      else {
        const top = spec.topSpeed * spec.reverse;
        engine = input.throttle * power * spec.reverse * Math.max(0, 1 + speed / top);
      }
    }

    // A car left alone at walking pace holds where it is rather than rolling
    // off down the hill: the driver has stopped, so the car has stopped.
    if (input.throttle === 0 && forward < PARKING_SPEED) pedal = 1;

    const driven = spec.wheels.reduce((n, w) => n + (w.driven ? 1 : 0), 0) || 1;
    for (let i = 0; i < spec.wheels.length; i++) {
      const wheel = spec.wheels[i] as WheelSpec;
      const state = v.wheels[i] as WheelState;
      const grip = gripOf(this.surfaceUnder(v, wheel), wetness, spec.tyres);

      const steer = wheel.steered ? approach(state.steer, wanted, spec.steerRate / TICK_RATE) : 0;
      controller.setWheelSteering(i, steer);

      // What the surface costs this wheel, in newtons. A wheel the engine is
      // pushing ignores its brake, so the loss comes off the drive there and
      // off the brake everywhere else. Either way the ground is always felt.
      const rolling = (grip.roll * spec.mass * GRAVITY) / spec.wheels.length;
      const drive = wheel.driven ? engine / driven : 0;
      controller.setWheelEngineForce(i, drive > 0 ? Math.max(0, drive - rolling) : Math.min(0, drive + rolling));

      let brake = pedal * spec.brakeForce + rolling;
      let side = grip.side;
      if (input.handbrake && wheel.handbraked) {
        brake = spec.handbrakeForce;
        // A locked wheel gives up most of its bite across the road, which is
        // what turns a handbrake into a drift rather than a stop.
        side *= 0.35;
      }
      // Rapier takes the engine as a force and the brake as the impulse of one
      // step, so the brake is what the table says divided by the tick rate.
      controller.setWheelBrake(i, brake / TICK_RATE);
      controller.setWheelFrictionSlip(i, grip.friction);
      controller.setWheelSideFrictionStiffness(i, side);
    }
  }

  /**
   * The rider of a two-wheeler (spec section 11.3). Its wheels stand on the
   * centreline, so the suspension gives it no roll stiffness at all and its two
   * contact points are in line, so nothing steadies it in pitch either. The
   * rider is both:
   *
   * - roll is sprung back toward level and damped, because a bike left to lean
   *   simply falls over;
   * - pitch is damped and never sprung, because a bike on a hill should point
   *   up the hill. Damping alone still takes the violence out of a wheelie and
   *   out of the porpoising two contact points fall into.
   */
  hold(chassis: RAPIER.RigidBody, v: VehicleState, spec: VehicleSpec): void {
    const stiffness = spec.balance;
    if (stiffness === 0) return;
    const damping = stiffness * BALANCE_DAMPING;
    // The axle is local +z, so how far its world `y` has tipped is the sine of
    // the roll; the forward axis is the axis that roll turns about, and the
    // axle itself is the axis pitch turns about.
    rotate(this.axis, v, 0, 0, 1);
    rotate(this.point, v, 1, 0, 0);
    const rolling = v.ax * this.point.x + v.ay * this.point.y + v.az * this.point.z;
    const pitching = v.ax * this.axis.x + v.ay * this.axis.y + v.az * this.axis.z;
    const roll = stiffness * this.axis.y - damping * rolling;
    const pitch = -damping * pitching;
    this.force.x = this.point.x * roll + this.axis.x * pitch;
    this.force.y = this.point.y * roll + this.axis.y * pitch;
    this.force.z = this.point.z * roll + this.axis.z * pitch;
    chassis.addTorque(this.force, true);
  }

  /**
   * The boat controller of spec section 11.3.
   *
   * The hull is held up by the water it displaces, taken at the four quarters
   * of it so the boat pitches and rolls; the water takes back much more across
   * the hull than along it, which is what makes a boat track rather than slide;
   * and the rudder's bite grows with the water flowing past it, so a boat at a
   * standstill cannot turn on the spot. Out of the water none of it applies and
   * the hull is a box resting on the ground.
   */
  sail(chassis: RAPIER.RigidBody, v: VehicleState, input: InputFrame, spec: VehicleSpec): void {
    const hull = spec.hull as HullSpec;
    const sea = this.ground.seaLevel;
    const weight = spec.mass * GRAVITY;

    let under = 0;
    for (let i = 0; i < LIFT_POINTS; i++) {
      const along = i < 2 ? 1 : -1;
      const across = i % 2 === 0 ? 1 : -1;
      rotate(
        this.point,
        v,
        along * spec.halfLength * hull.liftLength,
        -spec.halfHeight,
        across * spec.halfWidth * hull.liftWidth,
      );
      const y = v.y + this.point.y;
      const depth = sea - y;
      if (depth <= 0) continue;
      under++;
      this.force.x = 0;
      this.force.y = (Math.min(depth / hull.draft, hull.buoyancy) * weight) / LIFT_POINTS;
      this.force.z = 0;
      this.at.x = v.x + this.point.x;
      this.at.y = y;
      this.at.z = v.z + this.point.z;
      chassis.addForceAtPoint(this.force, this.at, true);
    }
    v.afloat = under > 0;
    if (under === 0) return;
    // A hull half out of the water is half held, half dragged and half driven.
    const wet = under / LIFT_POINTS;

    rotate(this.point, v, 1, 0, 0);
    rotate(this.axis, v, 0, 0, 1);
    const along = v.vx * this.point.x + v.vy * this.point.y + v.vz * this.point.z;
    const across = v.vx * this.axis.x + v.vy * this.axis.y + v.vz * this.axis.z;

    let thrust = 0;
    if (input.throttle > 0) {
      thrust = input.throttle * hull.thrust * Math.max(0, 1 - along / hull.topSpeed);
    } else if (input.throttle < 0) {
      const top = hull.topSpeed * hull.reverse;
      thrust = input.throttle * hull.thrust * hull.reverse * Math.max(0, 1 + along / top);
    }

    const push = (thrust - hull.waterDrag * spec.mass * along) * wet;
    const slip = -hull.sideDrag * spec.mass * across * wet;
    this.force.x = this.point.x * push + this.axis.x * slip;
    this.force.y = this.point.y * push + this.axis.y * slip - hull.heave * spec.mass * v.vy * wet;
    this.force.z = this.point.z * push + this.axis.z * slip;
    chassis.addForce(this.force, true);

    // The rudder turns the boat the way the wheel turns a car: the map's
    // heading runs the other way round the up axis, so steering right is a
    // negative yaw. It bites with the water flowing past it, and it bites the
    // other way when the boat is going astern.
    const flow = Math.max(-1, Math.min(1, along / hull.topSpeed));
    this.force.x = 0;
    this.force.y = -input.steer * hull.rudder * flow * wet;
    this.force.z = 0;
    chassis.addTorque(this.force, true);
  }

  /** What the ground is made of under one wheel of a vehicle at its current pose. */
  private surfaceUnder(v: VehicleState, wheel: WheelSpec): Surface {
    rotate(this.point, v, wheel.x, wheel.y, wheel.z);
    return this.ground.surfaceAt(v.x + this.point.x, v.z + this.point.z);
  }

}

/** Move `from` toward `to` by at most `step`. */
function approach(from: number, to: number, step: number): number {
  if (to > from) return Math.min(to, from + step);
  return Math.max(to, from - step);
}

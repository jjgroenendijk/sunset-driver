/**
 * Rapier, stepped inside the simulation (spec sections 2.1, 2.2, 11.3).
 *
 * The physics world is not simulation state. Simulation state is the plain,
 * serialisable record in `simulation.ts`; this builds a Rapier world from it,
 * steps that world once per tick, and writes what came out back into the
 * record. So a session can be saved, sent or replayed as numbers, and the
 * bodies are made again from those numbers on the other side.
 *
 * The ground is a heightfield collider per tile of a grid around the player, so
 * the physics streams the way the city does (spec section 9.1). A tile samples
 * the same carved ground the renderer draws, on a grid anchored on the origin,
 * so two tiles agree along the edge they share and a tile built late is the
 * same tile as one built early.
 *
 * The world it stands on comes in as a {@link Ground}: the height of the ground
 * at a place and what that ground is made of. The game hands it the carve and
 * the surface index of `src/world`; a test can hand it a hillside of its own.
 * That is what keeps this file free of world generation.
 *
 * Only the player's car has a body. Ambient traffic is kinematic and evaluated
 * from `(seed, tick)` until something touches it (spec section 5.3), so the
 * physics slice of spec section 2.4 pays for one vehicle and the ground.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { Surface } from '../world/surface.ts';
import { TICK_RATE } from './clock.ts';
import type { InputFrame } from './input.ts';
import type { SimState } from './simulation.ts';
import {
  createVehicleState,
  gripOf,
  headingOf,
  rideHeight,
  SALOON,
  type VehicleSpec,
  type VehicleState,
  type WheelSpec,
  type WheelState,
} from './vehicle.ts';

/** Metres per second squared. Earth's, so a car falls the way a car falls. */
const GRAVITY = 9.81;

/** Metres each way of one tile of ground the physics holds. */
export const PHYSICS_TILE = 50;

/** Metres between height samples of a tile. Four to a cell of the chunk terrain grid. */
export const PHYSICS_CELL = 2.5;

/** Tiles each way of the player that carry a collider: a 250 m box around the car. */
export const PHYSICS_RADIUS = 2;

/**
 * Metres per second under which a car with no throttle holds its brakes. Below
 * a walking pace a parked car should stay parked, on a hill as much as on the
 * flat.
 */
const PARKING_SPEED = 1.5;

/** Height samples each way of one tile. */
const TILE_CELLS = PHYSICS_TILE / PHYSICS_CELL;

/**
 * What the world is, as the physics needs it: how high the ground is at a place
 * and what it is made of. `src/world` answers both; nothing here knows how.
 */
export interface Ground {
  /** The carved height of the ground at a place, in metres. */
  heightAt(x: number, y: number): number;
  /** What the ground is made of there. */
  surfaceAt(x: number, y: number): Surface;
}

/** Load Rapier's WebAssembly. Call once before the first {@link SimPhysics}. */
export async function initPhysics(): Promise<void> {
  await RAPIER.init();
}

/** One tile of ground, and where it stands. */
interface GroundTile {
  cx: number;
  cy: number;
  collider: RAPIER.Collider;
}

/**
 * The physics of a session: the ground under the player and the car on it.
 *
 * Build one, step it once per simulation tick, and throw it away with the
 * session. It owns no simulation state; everything it decides is written back
 * into the {@link SimState} it is given.
 */
export class SimPhysics {
  /** How wet the ground is, 0 to 1. Weather (spec section 13.4) will set it. */
  wetness = 0;

  private readonly world: RAPIER.World;
  private readonly ground: Ground;
  private readonly spec: VehicleSpec;
  private readonly tiles: GroundTile[] = [];
  private chassis: RAPIER.RigidBody;
  private vehicle: RAPIER.DynamicRayCastVehicleController;
  /** Scratch vectors, so a tick allocates nothing. */
  private readonly point = { x: 0, y: 0, z: 0 };

  constructor(ground: Ground, state: SimState, spec: VehicleSpec = SALOON) {
    this.ground = ground;
    this.spec = spec;
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    // The step is the tick. Simulation code never sees a frame delta.
    this.world.timestep = 1 / TICK_RATE;
    this.cover(state.vehicle.x, state.vehicle.z);
    const built = this.build(state.vehicle);
    this.chassis = built.chassis;
    this.vehicle = built.vehicle;
  }

  /**
   * Put the vehicle down on the ground at a place on the map and rebuild its
   * body there. This is how a session starts, and how a respawn will place a
   * car once spec section 11.7 lands.
   */
  spawn(state: SimState, x: number, y: number, heading = 0): void {
    const height = this.ground.heightAt(x, y) + rideHeight(this.spec);
    state.vehicle = createVehicleState(this.spec, x, y, height, heading);
    this.cover(x, y);
    this.adopt(state);
  }

  /**
   * Rebuild the Rapier body from the state. Call it after loading a save or
   * moving the player: the state is the record, and this makes the world agree
   * with it again.
   */
  adopt(state: SimState): void {
    this.release();
    this.cover(state.vehicle.x, state.vehicle.z);
    const built = this.build(state.vehicle);
    this.chassis = built.chassis;
    this.vehicle = built.vehicle;
  }

  /**
   * Advance the physics by one tick and write the result into the state.
   *
   * The gradient needs no rule of its own: the chassis is a rigid body, so on a
   * climb the engine force has gravity along the slope to fight, and on a
   * descent it has gravity behind it and the brakes take longer. What the
   * surface does need is a rule, and it is the grip table of `vehicle.ts`, read
   * per wheel at the ground each wheel stands on.
   */
  step(state: SimState, input: InputFrame): void {
    const v = state.vehicle;
    this.cover(v.x, v.z);
    this.drive(v, input);
    this.vehicle.updateVehicle(this.world.timestep);
    this.world.step();
    this.read(state);
  }

  /** Release the Rapier world and everything in it. */
  dispose(): void {
    this.vehicle.free();
    this.world.free();
    this.tiles.length = 0;
  }

  /** How many tiles of ground carry a collider, which the budget test measures. */
  get groundTiles(): number {
    return this.tiles.length;
  }

  /** Apply the input to the wheels: steering, engine, brakes and the grip of the ground. */
  private drive(v: VehicleState, input: InputFrame): void {
    const spec = this.spec;
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
    let engine = 0;
    let pedal = 0;
    if (input.throttle > 0) {
      if (speed < -0.5) pedal = input.throttle;
      else engine = input.throttle * spec.enginePower * Math.max(0, 1 - speed / spec.topSpeed);
    } else if (input.throttle < 0) {
      if (speed > 0.5) pedal = -input.throttle;
      else {
        const top = spec.topSpeed * spec.reverse;
        engine = input.throttle * spec.enginePower * spec.reverse * Math.max(0, 1 + speed / top);
      }
    }

    // A car left alone at walking pace holds where it is rather than rolling
    // off down the hill: the driver has stopped, so the car has stopped.
    if (input.throttle === 0 && forward < PARKING_SPEED) pedal = 1;

    const driven = spec.wheels.reduce((n, w) => n + (w.driven ? 1 : 0), 0) || 1;
    for (let i = 0; i < spec.wheels.length; i++) {
      const wheel = spec.wheels[i] as WheelSpec;
      const state = v.wheels[i] as WheelState;
      const grip = gripOf(this.surfaceUnder(v, wheel), this.wetness);

      const steer = wheel.steered ? approach(state.steer, wanted, spec.steerRate / TICK_RATE) : 0;
      this.vehicle.setWheelSteering(i, steer);

      // What the surface costs this wheel, in newtons. A wheel the engine is
      // pushing ignores its brake, so the loss comes off the drive there and
      // off the brake everywhere else. Either way the ground is always felt.
      const rolling = (grip.roll * spec.mass * GRAVITY) / spec.wheels.length;
      const drive = wheel.driven ? engine / driven : 0;
      this.vehicle.setWheelEngineForce(i, drive > 0 ? Math.max(0, drive - rolling) : Math.min(0, drive + rolling));

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
      this.vehicle.setWheelBrake(i, brake / TICK_RATE);
      this.vehicle.setWheelFrictionSlip(i, grip.friction);
      this.vehicle.setWheelSideFrictionStiffness(i, side);
    }
  }

  /** What the ground is made of under one wheel of a vehicle at its current pose. */
  private surfaceUnder(v: VehicleState, wheel: WheelSpec): Surface {
    rotate(this.point, v, wheel.x, wheel.y, wheel.z);
    return this.ground.surfaceAt(v.x + this.point.x, v.z + this.point.z);
  }

  /** Read the stepped world back into the state. Nothing else writes the vehicle. */
  private read(state: SimState): void {
    const v = state.vehicle;
    const t = this.chassis.translation();
    const r = this.chassis.rotation();
    const linear = this.chassis.linvel();
    const angular = this.chassis.angvel();
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
    v.speed = this.vehicle.currentVehicleSpeed();
    for (let i = 0; i < v.wheels.length; i++) {
      const wheel = v.wheels[i] as WheelState;
      wheel.rotation = this.vehicle.wheelRotation(i) ?? wheel.rotation;
      wheel.steer = this.vehicle.wheelSteering(i) ?? 0;
      wheel.suspension = this.vehicle.wheelSuspensionLength(i) ?? this.spec.suspensionRest;
      wheel.contact = this.vehicle.wheelIsInContact(i);
    }
    // The player is where their car is, until they can get out of it
    // (spec section 11.5).
    const p = state.player;
    p.x = v.x;
    p.y = v.z;
    p.heading = headingOf(v);
    p.speed = v.speed;
  }

  /** Build the chassis body, its collider and the wheels, from the state. */
  private build(v: VehicleState): {
    chassis: RAPIER.RigidBody;
    vehicle: RAPIER.DynamicRayCastVehicleController;
  } {
    const spec = this.spec;
    const chassis = this.world.createRigidBody(
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
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(spec.halfLength, spec.halfHeight, spec.halfWidth)
        .setMass(spec.mass)
        .setFriction(0.6),
      chassis,
    );

    const vehicle = this.world.createVehicleController(chassis);
    // Forward is the chassis' local +x and up is +y, the frame the model and
    // the map heading already share (`vehicle.ts`).
    vehicle.setIndexForwardAxis = 0;
    vehicle.indexUpAxis = 1;
    for (let i = 0; i < spec.wheels.length; i++) {
      const wheel = spec.wheels[i] as WheelSpec;
      vehicle.addWheel(
        { x: wheel.x, y: wheel.y, z: wheel.z },
        { x: 0, y: -1, z: 0 },
        { x: 0, y: 0, z: 1 },
        spec.suspensionRest,
        spec.wheelRadius,
      );
      vehicle.setWheelSuspensionStiffness(i, spec.suspensionStiffness);
      vehicle.setWheelSuspensionCompression(i, spec.suspensionCompression);
      vehicle.setWheelSuspensionRelaxation(i, spec.suspensionRelaxation);
      vehicle.setWheelMaxSuspensionTravel(i, spec.suspensionTravel);
      vehicle.setWheelMaxSuspensionForce(i, spec.maxSuspensionForce);
      vehicle.setWheelSteering(i, (v.wheels[i] as WheelState).steer);
    }
    return { chassis, vehicle };
  }

  /** Take the vehicle's body out of the world, so a new one can be built from the state. */
  private release(): void {
    this.vehicle.free();
    this.world.removeRigidBody(this.chassis);
  }

  /**
   * Make sure every tile within {@link PHYSICS_RADIUS} of a place carries a
   * collider, and drop the ones the player has left behind. The grid is
   * anchored on the origin, so a tile is the same tile whenever it is built.
   */
  private cover(x: number, z: number): void {
    const cx = Math.floor(x / PHYSICS_TILE);
    const cy = Math.floor(z / PHYSICS_TILE);
    for (let i = this.tiles.length - 1; i >= 0; i--) {
      const tile = this.tiles[i] as GroundTile;
      if (Math.max(Math.abs(tile.cx - cx), Math.abs(tile.cy - cy)) <= PHYSICS_RADIUS) continue;
      this.world.removeCollider(tile.collider, false);
      this.tiles.splice(i, 1);
    }
    // Row by row and column by column, so the colliders go into the world in
    // the same order however the player reached the place.
    for (let ty = cy - PHYSICS_RADIUS; ty <= cy + PHYSICS_RADIUS; ty++) {
      for (let tx = cx - PHYSICS_RADIUS; tx <= cx + PHYSICS_RADIUS; tx++) {
        if (this.tiles.some((tile) => tile.cx === tx && tile.cy === ty)) continue;
        this.tiles.push({ cx: tx, cy: ty, collider: this.layTile(tx, ty) });
      }
    }
  }

  /**
   * One tile of ground as a Rapier heightfield.
   *
   * Rapier lays a heightfield in the XZ plane, centred on the collider, and
   * reads its samples as `heights[j * (rows + 1) + i]`: `i` walks `z` and `j`
   * walks `x`. The far row and column of a tile are the near ones of the next,
   * sampled from the same ground, so the seam between two tiles is flat.
   */
  private layTile(tx: number, ty: number): RAPIER.Collider {
    const heights = new Float32Array((TILE_CELLS + 1) * (TILE_CELLS + 1));
    const x0 = tx * PHYSICS_TILE;
    const y0 = ty * PHYSICS_TILE;
    for (let j = 0; j <= TILE_CELLS; j++) {
      for (let i = 0; i <= TILE_CELLS; i++) {
        heights[j * (TILE_CELLS + 1) + i] = this.ground.heightAt(x0 + j * PHYSICS_CELL, y0 + i * PHYSICS_CELL);
      }
    }
    return this.world.createCollider(
      RAPIER.ColliderDesc.heightfield(TILE_CELLS, TILE_CELLS, heights, {
        x: PHYSICS_TILE,
        y: 1,
        z: PHYSICS_TILE,
      })
        .setTranslation(x0 + PHYSICS_TILE / 2, 0, y0 + PHYSICS_TILE / 2)
        .setFriction(1),
    );
  }
}

/** Move `from` toward `to` by at most `step`. */
function approach(from: number, to: number, step: number): number {
  if (to > from) return Math.min(to, from + step);
  return Math.max(to, from - step);
}

/** Turn a point of the vehicle's own frame into an offset in world axes. */
function rotate(out: { x: number; y: number; z: number }, v: VehicleState, x: number, y: number, z: number): void {
  // q * (x, y, z) * q⁻¹, written out so a tick allocates nothing.
  const tx = 2 * (v.qy * z - v.qz * y);
  const ty = 2 * (v.qz * x - v.qx * z);
  const tz = 2 * (v.qx * y - v.qy * x);
  out.x = x + v.qw * tx + v.qy * tz - v.qz * ty;
  out.y = y + v.qw * ty + v.qz * tx - v.qx * tz;
  out.z = z + v.qw * tz + v.qx * ty - v.qy * tx;
}

/**
 * Rapier, stepped inside the simulation (spec sections 2.1, 2.2, 11.3).
 *
 * The physics world is not simulation state. Simulation state is the plain,
 * serialisable record in `simulation.ts`; this builds a Rapier world from it,
 * steps that world once per tick, and writes what came out back into the
 * record. So a session can be saved, sent or replayed as numbers, and the
 * bodies are made again from those numbers on the other side. The record says
 * which row of the roster is being driven, so the body, the wheels and the
 * handling are all rebuilt from it too.
 *
 * The ground is a heightfield collider per tile of a grid around the player, so
 * the physics streams the way the city does (spec section 9.1). A tile samples
 * the same carved ground the renderer draws, on a grid anchored on the origin,
 * so two tiles agree along the edge they share and a tile built late is the
 * same tile as one built early.
 *
 * The world it stands on comes in as a {@link Ground}: the height of the ground
 * at a place, what that ground is made of, and where the sea stands. The game
 * hands it the carve, the surface index of `src/world` and the world's sea
 * level; a test can hand it a hillside of its own. That is what keeps this file
 * free of world generation.
 *
 * A wheeled vehicle drives on Rapier's `DynamicRayCastVehicleController`. A
 * boat has no wheels, so it gets its own controller instead: it is held up by
 * the water it displaces, pushed from the stern and turned by a rudder that
 * only bites while water is flowing past it (spec section 11.3).
 *
 * The player on foot is a capsule on Rapier's `KinematicCharacterController`
 * (spec sections 11.2, 11.5). Exactly one of the two is driven at a time: the
 * record says which, and the bodies follow it. A vehicle nobody is in is a
 * fixed body built from the record, so the player walks round their parked car
 * rather than through it and the car is not simulated while it stands still.
 * `on-foot.ts` holds the numbers a person is made of and the rules for getting
 * in and out; this file is the Rapier half of them.
 *
 * Only the player's vehicle has a moving body. Ambient traffic is kinematic and
 * evaluated from `(seed, tick)` until something touches it (spec section 5.3),
 * so the physics slice of spec section 2.4 pays for one vehicle, one player and
 * the ground.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { Surface } from '../world/surface.ts';
import { TICK_RATE } from './clock.ts';
import {
  blastDamageAt,
  BLAST_LIFT,
  CRASH_DAMAGE,
  enginePowerScale,
  hitVehicle,
  tickFire,
} from './damage.ts';
import { EMPTY_INPUT, type InputFrame } from './input.ts';
import {
  besidePlayer,
  capsuleOf,
  exitPlace,
  EXIT_SPEED,
  hurt,
  JUMP_SPEED,
  MAX_CLIMB,
  MIN_SLIDE,
  paceOf,
  reachesVehicle,
  SKIN,
  SNAP_DISTANCE,
  STEP_HEIGHT,
  STEP_WIDTH,
  TERMINAL_SPEED,
  TURN_RATE,
  turnToward,
} from './on-foot.ts';
import type { SimState } from './simulation.ts';
import { createTheft, isLocked, stepTheft, THEFT_HEAT, type TheftState } from './theft.ts';
import {
  createVehicleState,
  gripOf,
  headingOf,
  rideHeight,
  specOf,
  type HullSpec,
  type VehicleClass,
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

/**
 * Metres per second the vehicle has to be sliding across its own axle before a
 * tyre counts as skidding (spec section 11.3). It is one rule for every way of
 * getting there: a handbrake turn, a corner taken too fast and a spin all push
 * the vehicle sideways, and a tyre that is being pushed sideways is a tyre
 * leaving a mark. Below this the tyre is scrubbing, not sliding.
 */
const SKID_SLIP = 2.2;

/** Height samples each way of one tile. */
const TILE_CELLS = PHYSICS_TILE / PHYSICS_CELL;

/**
 * What the world is, as the physics needs it: how high the ground is at a
 * place, what it is made of, and where the sea stands. `src/world` answers all
 * three; nothing here knows how.
 */
export interface Ground {
  /** The carved height of the ground at a place, in metres. */
  heightAt(x: number, y: number): number;
  /** What the ground is made of there. */
  surfaceAt(x: number, y: number): Surface;
  /** The one level the sea, the straits, the river and the harbour stand at. */
  seaLevel: number;
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

/** A body and the wheels it drives on, or no wheels at all on a boat. */
interface Built {
  chassis: RAPIER.RigidBody;
  wheels: RAPIER.DynamicRayCastVehicleController | undefined;
}

/** The player on foot: the kinematic capsule and the controller that walks it. */
interface Walker {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  controller: RAPIER.KinematicCharacterController;
  /** Metres from the middle of the capsule down to the feet. */
  rise: number;
}

/**
 * The physics of a session: the ground under the player and the vehicle on it.
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
  private readonly tiles: GroundTile[] = [];
  /** The row of the roster the body was built from. `adopt` reads it off the record. */
  private spec: VehicleSpec;
  /** The vehicle's moving body, and undefined while nobody is in it. */
  private chassis: RAPIER.RigidBody | undefined;
  private wheels: RAPIER.DynamicRayCastVehicleController | undefined;
  /** The parked vehicle's fixed body, and undefined while it is being driven. */
  private parked: RAPIER.RigidBody | undefined;
  /** The player's capsule, and undefined while they are in a vehicle. */
  private walker: Walker | undefined;
  /** Scratch vectors and forces, so a tick allocates nothing. */
  private readonly point = { x: 0, y: 0, z: 0 };
  private readonly axis = { x: 0, y: 0, z: 0 };
  private readonly force = { x: 0, y: 0, z: 0 };
  private readonly at = { x: 0, y: 0, z: 0 };

  constructor(ground: Ground, state: SimState) {
    this.ground = ground;
    this.spec = specOf(state.vehicle.cls);
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    // The step is the tick. Simulation code never sees a frame delta.
    this.world.timestep = 1 / TICK_RATE;
    this.adopt(state);
  }

  /**
   * Put a vehicle down on the ground at a place on the map and rebuild its body
   * there. This is how a session starts, how the debug picker of spec section
   * 11.3 changes what is being driven, and how a respawn will place a vehicle
   * once spec section 11.7 lands.
   *
   * A boat is put down on the water rather than on the ground, since that is
   * what it rests on; on ground that stands above the sea it simply sits there.
   *
   * A vehicle put down while the player is on foot stands beside them rather
   * than on them, and they stay on foot: the debug picker of spec section 11.3
   * leaves a car at the kerb to walk over to.
   */
  spawn(state: SimState, x: number, y: number, heading = 0, cls: VehicleClass = state.vehicle.cls): void {
    const spec = specOf(cls);
    const place = state.player.driving ? { x, y, heading } : besidePlayer(state.player, spec);
    const ground = this.ground.heightAt(place.x, place.y);
    const rest = spec.hull === undefined ? ground : Math.max(ground, this.ground.seaLevel);
    state.vehicle = createVehicleState(spec, place.x, place.y, rest + rideHeight(spec), place.heading);
    // A vehicle put down under a player who is driving is open to them, since
    // they are sitting in it: a session does not start with a break-in. One
    // left at the kerb beside a player on foot is not (spec section 11.4).
    state.vehicle.hotwired = state.player.driving;
    // An attempt at the lock of the vehicle this one replaces means nothing:
    // the new one carries its own lock.
    state.theft = null;
    this.adopt(state);
    // The record of a player in the vehicle says where the vehicle is, so a
    // vehicle put down somewhere else takes the player with it.
    if (state.player.driving) this.follow(state);
  }

  /**
   * Rebuild the Rapier bodies from the state. Call it after loading a save or
   * moving the player: the state is the record, and this makes the world agree
   * with it again. The record says whether the player is driving, so it says
   * which of the two bodies moves and which one stands still.
   */
  adopt(state: SimState): void {
    this.release();
    this.spec = specOf(state.vehicle.cls);
    const p = state.player;
    this.cover(p.driving ? state.vehicle.x : p.x, p.driving ? state.vehicle.z : p.y);
    if (p.driving) {
      const built = this.build(state.vehicle);
      this.chassis = built.chassis;
      this.wheels = built.wheels;
    } else {
      this.parked = this.buildParked(state.vehicle);
      this.walker = this.buildWalker(state);
    }
  }

  /**
   * Advance the physics by one tick and write the result into the state.
   *
   * The gradient needs no rule of its own: the chassis is a rigid body, so on a
   * climb the engine force has gravity along the slope to fight, and on a
   * descent it has gravity behind it and the brakes take longer. What the
   * surface does need is a rule, and it is the grip table of `vehicle.ts`, read
   * per wheel at the ground each wheel stands on and scaled by the tyres the
   * vehicle is on.
   *
   * A player on foot is stepped instead of the vehicle (spec section 11.5).
   * The ground follows whoever is moving, so the tiles stand under the player
   * and not under the car they left behind. A player working at a lock (spec
   * section 11.4) is stepped the same way and simply holds still, which is what
   * keeps the world running around them while they work.
   *
   * What the vehicle was doing before the step is kept, because the speed it
   * loses over the step is what says whether it has hit anything (spec section
   * 11.3). Nothing a driver does reaches that: the brakes, the springs and
   * gravity all move the vehicle by a fraction of the impact floor in a tick,
   * so only a wall or another body can.
   */
  step(state: SimState, input: InputFrame): void {
    this.transfer(state, input);
    const v = state.vehicle;
    const chassis = this.chassis;
    const wasX = v.vx;
    const wasY = v.vy;
    const wasZ = v.vz;
    if (chassis === undefined) {
      this.cover(state.player.x, state.player.y);
      // A player bent over a lock stands at the door (spec section 11.4): they
      // are stepped with nothing held down, so only gravity moves them.
      this.walk(state, state.theft === null ? input : EMPTY_INPUT);
    } else {
      this.cover(v.x, v.z);
      // Rapier keeps a force until it is told to forget it, so a tick that adds
      // one has to clear the last tick's first. Without this the buoyancy of a
      // hull and the rider of a motorcycle both grow without bound.
      chassis.resetForces(false);
      chassis.resetTorques(false);
      if (this.wheels === undefined) {
        this.sail(v, input);
      } else {
        this.drive(v, input);
        this.hold(v);
        this.wheels.updateVehicle(this.world.timestep);
      }
    }
    this.world.step();
    this.read(state);
    if (chassis !== undefined) this.crash(state, wasX, wasY, wasZ);
    this.burn(state);
  }

  /** Release the Rapier world and everything in it. */
  dispose(): void {
    this.wheels?.free();
    this.walker?.controller.free();
    this.world.free();
    this.tiles.length = 0;
  }

  /** How many tiles of ground carry a collider, which the budget test measures. */
  get groundTiles(): number {
    return this.tiles.length;
  }

  /** The row of the roster being driven, so the HUD and the picker can name it. */
  get vehicle(): VehicleSpec {
    return this.spec;
  }

  /**
   * The damage of spec section 11.3: what the vehicle hit over the step it has
   * just taken.
   *
   * The speed it lost is what its structure absorbed, and the direction it was
   * pushed in says which panel took it. The direction is read in the vehicle's
   * own frame, so a shunt from behind dents the boot whichever way the car
   * happens to be pointing. Whoever is driving takes their share of it.
   */
  private crash(state: SimState, wasX: number, wasY: number, wasZ: number): void {
    const v = state.vehicle;
    unrotate(this.point, v, v.vx - wasX, v.vy - wasY, v.vz - wasZ);
    const severity = hitVehicle(
      v.damage,
      this.spec,
      this.point.x,
      this.point.y,
      this.point.z,
      state.seed,
      state.tick,
    );
    if (severity > 0 && state.player.driving) hurt(state.player, severity * CRASH_DAMAGE);
  }

  /**
   * Run the vehicle's fire for a tick (spec section 11.3). A fire that reaches
   * the end of its fuse throws the vehicle up and hurts whoever is near enough
   * to feel it. Fire between vehicles is `spreadFire` in `damage.ts`; there is
   * one vehicle here until the traffic of spec section 13.1 lands.
   */
  private burn(state: SimState): void {
    const v = state.vehicle;
    if (!tickFire(v.damage, state.tick)) return;
    const p = state.player;
    hurt(p, blastDamageAt(p.driving ? 0 : Math.hypot(p.x - v.x, p.y - v.z)));
    const chassis = this.chassis;
    if (chassis === undefined) return;
    this.force.x = 0;
    this.force.y = (BLAST_LIFT * this.spec.mass) / 1000;
    this.force.z = 0;
    chassis.applyImpulse(this.force, true);
    // An impulse moves the body at once, so the record is read again: the
    // record and the body have to agree, or the next tick reads the blast as
    // another crash.
    const linear = chassis.linvel();
    v.vx = linear.x;
    v.vy = linear.y;
    v.vz = linear.z;
  }

  /** Apply the input to the wheels: steering, engine, brakes and the grip of the ground. */
  private drive(v: VehicleState, input: InputFrame): void {
    const controller = this.wheels as RAPIER.DynamicRayCastVehicleController;
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
      const grip = gripOf(this.surfaceUnder(v, wheel), this.wetness, spec.tyres);

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
  private hold(v: VehicleState): void {
    const chassis = this.chassis as RAPIER.RigidBody;
    const stiffness = this.spec.balance;
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
  private sail(v: VehicleState, input: InputFrame): void {
    const chassis = this.chassis as RAPIER.RigidBody;
    const spec = this.spec;
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

  /**
   * Read the stepped world back into the state. Nothing else writes the vehicle
   * or the player.
   *
   * A vehicle nobody is in is not stepped, so there is nothing to read off it:
   * the record already says where it stands. A player on foot is read off their
   * capsule instead.
   */
  private read(state: SimState): void {
    const walker = this.walker;
    if (walker !== undefined) {
      const t = walker.body.translation();
      const p = state.player;
      p.x = t.x;
      p.y = t.z;
      p.height = t.y - walker.rise;
      return;
    }
    this.readVehicle(state);
    this.follow(state);
  }

  /** Where the player sits while they are driving: in the vehicle, facing its way. */
  private follow(state: SimState): void {
    const v = state.vehicle;
    const p = state.player;
    p.x = v.x;
    p.y = v.z;
    // The floor of the body, which is about where the driver's feet are.
    p.height = v.y - this.spec.halfHeight;
    p.heading = headingOf(v);
    p.speed = v.speed;
    p.vy = 0;
    p.grounded = true;
  }

  /** Read the vehicle's body and wheels back into its record. */
  private readVehicle(state: SimState): void {
    const chassis = this.chassis as RAPIER.RigidBody;
    const v = state.vehicle;
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
    if (this.wheels === undefined) {
      // A boat has no wheel to read a speed off, so the speed is what the hull
      // is making along its own length.
      rotate(this.point, v, 1, 0, 0);
      v.speed = v.vx * this.point.x + v.vy * this.point.y + v.vz * this.point.z;
    } else {
      v.speed = this.wheels.currentVehicleSpeed();
      // How fast the body is going across its own axle. A tyre on the ground
      // that is being pushed sideways this hard is sliding, not rolling, and a
      // sliding tyre leaves a mark (spec section 11.3).
      rotate(this.axis, v, 0, 0, 1);
      const across = v.vx * this.axis.x + v.vy * this.axis.y + v.vz * this.axis.z;
      const sliding = Math.abs(across) > SKID_SLIP;
      for (let i = 0; i < v.wheels.length; i++) {
        const wheel = v.wheels[i] as WheelState;
        wheel.rotation = this.wheels.wheelRotation(i) ?? wheel.rotation;
        wheel.steer = this.wheels.wheelSteering(i) ?? 0;
        wheel.suspension = this.wheels.wheelSuspensionLength(i) ?? this.spec.suspensionRest;
        wheel.contact = this.wheels.wheelIsInContact(i);
        wheel.skid = wheel.contact && sliding;
      }
    }
  }

  /** Build the chassis body, its collider and the wheels, from the state. */
  private build(v: VehicleState): Built {
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
        // A hull slides over what it grounds on; a car body digs in.
        .setFriction(spec.hull === undefined ? 0.6 : 0.2),
      chassis,
    );
    if (spec.wheels.length === 0) return { chassis, wheels: undefined };

    const wheels = this.world.createVehicleController(chassis);
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
    return { chassis, wheels };
  }

  /**
   * The parked vehicle of spec section 11.5: the record's pose as a fixed body.
   *
   * Nothing drives it, so nothing has to simulate it, and the player walks
   * round it rather than through it. Entering it builds the moving body again
   * from the same record, so the car is where it was left.
   */
  private buildParked(v: VehicleState): RAPIER.RigidBody {
    const spec = this.spec;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(v.x, v.y, v.z)
        .setRotation({ x: v.qx, y: v.qy, z: v.qz, w: v.qw }),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(spec.halfLength, spec.halfHeight, spec.halfWidth),
      body,
    );
    return body;
  }

  /**
   * The player's capsule and the controller that walks it (spec section 11.2).
   *
   * The capsule is the build they picked, so a broad character is a broader
   * body than a slim one. The controller climbs a kerb, slides along a wall
   * rather than stopping dead at it, and holds the feet on the ground over a
   * slope instead of hopping down it.
   */
  private buildWalker(state: SimState): Walker {
    const capsule = capsuleOf(state.character);
    const p = state.player;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.height + capsule.rise, p.y),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(capsule.halfHeight, capsule.radius),
      body,
    );
    const controller = this.world.createCharacterController(SKIN);
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.setSlideEnabled(true);
    controller.setMaxSlopeClimbAngle(MAX_CLIMB);
    controller.setMinSlopeSlideAngle(MIN_SLIDE);
    controller.enableAutostep(STEP_HEIGHT, STEP_WIDTH, false);
    controller.enableSnapToGround(SNAP_DISTANCE);
    return { body, collider, controller, rise: capsule.rise };
  }

  /**
   * Get in or out of the vehicle on the press of the interact key (spec
   * sections 11.2, 11.4, 11.5).
   *
   * A press acts once: the key is held for as many ticks as the finger is on
   * it, and a door that opened every one of them would leave the player
   * stepping in and out sixty times a second. The door only opens at a crawl,
   * and only from within reach of the body.
   *
   * A vehicle worth stealing does not open on the key at all (spec section
   * 11.4): the press starts an attempt at its lock, and the same key then
   * works that lock until it gives way. This runs before the step rather than
   * after it, so the vehicle a player has just broken into is driven on the
   * tick it opened, exactly as one they simply got into.
   */
  private transfer(state: SimState, input: InputFrame): void {
    const p = state.player;
    const pressed = input.interact && !p.held.interact;
    p.held.interact = input.interact;
    if (state.theft !== null) {
      this.hotwire(state, state.theft, pressed);
      return;
    }
    if (!pressed) return;
    if (p.driving) {
      if (Math.abs(state.vehicle.speed) > EXIT_SPEED) return;
      const place = exitPlace(state.vehicle, this.spec);
      p.x = place.x;
      p.y = place.y;
      p.height = Math.max(this.ground.heightAt(place.x, place.y), state.vehicle.y - this.spec.halfHeight);
      p.heading = place.heading;
      p.speed = 0;
      p.vy = 0;
      p.grounded = false;
      p.driving = false;
    } else {
      if (!reachesVehicle(p, state.vehicle, this.spec)) return;
      if (isLocked(state.vehicle, this.spec)) {
        state.theft = createTheft(this.spec, state.tick);
        return;
      }
      p.driving = true;
    }
    this.adopt(state);
  }

  /**
   * Work at a lock for one tick (spec section 11.4).
   *
   * The rules are in `theft.ts` and the world is not stopped for them: this is
   * called from the same step that drives the traffic and burns the fires, so
   * everything around the player carries on while they work. What it costs
   * them is the heat the alarm raises, which is the hook spec section 14 reads.
   *
   * An attempt at a vehicle that is no longer within reach is dropped: an
   * explosion that throws the car across the street takes its lock with it.
   */
  private hotwire(state: SimState, theft: TheftState, pressed: boolean): void {
    const p = state.player;
    if (!reachesVehicle(p, state.vehicle, this.spec)) {
      state.theft = null;
      return;
    }
    state.heat += stepTheft(theft, state.seed, state.tick, pressed);
    if (!theft.open) return;
    // The lock is beaten once: the record carries it, so getting out again is
    // not a second break-in.
    state.vehicle.hotwired = true;
    state.heat += THEFT_HEAT;
    state.theft = null;
    p.driving = true;
    this.adopt(state);
  }

  /**
   * Walk the player one tick (spec sections 11.2, 11.5).
   *
   * The camera never turns (spec section 10.7), so the forward axis walks up
   * the screen and the steering axis walks across it, whatever the player
   * faces; they then turn to face the way they are walking. Gravity is
   * integrated here rather than by Rapier, because a kinematic body is moved
   * and never pushed: the jump is a speed the ground takes back.
   */
  private walk(state: SimState, input: InputFrame): void {
    const walker = this.walker as Walker;
    const p = state.player;

    const jumped = input.jump && !p.held.jump;
    p.held.jump = input.jump;
    if (jumped && p.grounded) p.vy = JUMP_SPEED;

    let dx = input.steer;
    let dy = -input.throttle;
    const length = Math.hypot(dx, dy);
    if (length > 1) {
      dx /= length;
      dy /= length;
    }
    if (length > 0) p.heading = turnToward(p.heading, Math.atan2(dy, dx), TURN_RATE / TICK_RATE);
    p.vy = Math.max(-TERMINAL_SPEED, p.vy - GRAVITY / TICK_RATE);

    const pace = paceOf(input.sprint) / TICK_RATE;
    this.point.x = dx * pace;
    this.point.y = p.vy / TICK_RATE;
    this.point.z = dy * pace;
    walker.controller.computeColliderMovement(walker.collider, this.point);
    const moved = walker.controller.computedMovement(this.force);
    p.grounded = walker.controller.computedGrounded();
    // Standing on the ground takes the fall back, so a step off a kerb does not
    // build up a speed the next drop starts from.
    if (p.grounded && p.vy < 0) p.vy = 0;
    p.speed = Math.hypot(moved.x, moved.z) * TICK_RATE;

    const t = walker.body.translation();
    this.at.x = t.x + moved.x;
    this.at.y = t.y + moved.y;
    this.at.z = t.z + moved.z;
    walker.body.setNextKinematicTranslation(this.at);
  }

  /** Take every body of the player and their vehicle out of the world, so `adopt` can build them again. */
  private release(): void {
    this.wheels?.free();
    this.wheels = undefined;
    if (this.chassis !== undefined) this.world.removeRigidBody(this.chassis);
    this.chassis = undefined;
    if (this.parked !== undefined) this.world.removeRigidBody(this.parked);
    this.parked = undefined;
    if (this.walker !== undefined) {
      this.world.removeCharacterController(this.walker.controller);
      this.world.removeRigidBody(this.walker.body);
    }
    this.walker = undefined;
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

/** Turn an offset in world axes into the vehicle's own frame: {@link rotate} the other way. */
function unrotate(out: { x: number; y: number; z: number }, v: VehicleState, x: number, y: number, z: number): void {
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
function rotate(out: { x: number; y: number; z: number }, v: VehicleState, x: number, y: number, z: number): void {
  // q * (x, y, z) * q⁻¹, written out so a tick allocates nothing.
  const tx = 2 * (v.qy * z - v.qz * y);
  const ty = 2 * (v.qz * x - v.qx * z);
  const tz = 2 * (v.qx * y - v.qy * x);
  out.x = x + v.qw * tx + v.qy * tz - v.qz * ty;
  out.y = y + v.qw * ty + v.qz * tx - v.qx * tz;
  out.z = z + v.qw * tz + v.qx * ty - v.qy * tx;
}

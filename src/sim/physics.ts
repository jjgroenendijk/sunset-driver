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
 * This file owns the world and the bodies in it. The three halves that need no
 * such ownership are next door: `ground-bodies.ts` is the ground and the decks
 * under the player, `drivetrain.ts` is what the driver's input does to the
 * wheels, the rider and the hull, and `gunfire.ts` is what a shot, a swing and
 * a thrown thing do to the world.
 *
 * The world it stands on comes in as a {@link Ground}: the height of the ground
 * at a place, what that ground is made of, and where the sea stands. The game
 * hands it the carve, the surface index of `src/world` and the world's sea
 * level; a test can hand it a hillside of its own. That is what keeps this file
 * free of world generation.
 *
 * The player on foot is a capsule on Rapier's `KinematicCharacterController`
 * (spec sections 11.2, 11.5). Exactly one of the two is driven at a time: the
 * record says which, and the bodies follow it. A vehicle nobody is in is a
 * fixed body built from the record, so the player walks round their parked car
 * rather than through it and the car is not simulated while it stands still.
 * `on-foot.ts` holds the numbers a person is made of and the rules for getting
 * in and out; this file is the Rapier half of them.
 *
 * Only the player's vehicle and the vehicles they have touched have a moving
 * body. Ambient traffic is kinematic and evaluated from `(seed, tick)` until
 * the player touches it (spec section 5.3); `traffic-bodies.ts` is that half.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { TICK_RATE } from './clock.ts';
import { stepCrowdReactions } from './crowd-reaction.ts';
import { stepFires } from './fire.ts';
import { blastDamageAt, BLAST_LIFT, CRASH_DAMAGE, hitVehicle, tickFire } from './damage.ts';
import { rotate, unrotate } from './frame.ts';
import { Drivetrain } from './drivetrain.ts';
import { GroundBodies, type Ground } from './ground-bodies.ts';
import { Gunfire, type ShotTarget } from './gunfire.ts';
import { buildWalker, GRAVITY, walk, type Walker } from './walker-body.ts';
import { EMPTY_INPUT, type InputFrame } from './input.ts';
import type { MetroPlace } from './metro.ts';
import type { ShopPlace } from './shop.ts';
import type { DealerPlace } from './dealer.ts';
import type { SafehousePlace } from './safehouse.ts';
import type { MissionWorld } from './job.ts';
import type { CrimeGround } from './street-crime.ts';
import type { TerritoryMap } from './territory.ts';
import {
  besidePlayer,
  exitPlace,
  EXIT_SPEED,
  hurt,
  type Place,
  reachesVehicle,
  SKIN,
  vehicleGap,
} from './on-foot.ts';
import type { SimState } from './simulation.ts';
import { TrafficBodies } from './traffic-bodies.ts';
import { UnitBodies } from './unit-bodies.ts';
import { commitCrime, report } from './police.ts';
import { createTheft, isLocked, stepTheft, type TheftState } from './theft.ts';
import {
  createVehicleState,
  headingOf,
  rideHeight,
  specOf,
  type VehicleClass,
  type VehicleSpec,
  type VehicleState,
  type WheelSpec,
  type WheelState,
} from './vehicle.ts';
import { weatherAt } from './weather.ts';

export { PHYSICS_CELL, PHYSICS_RADIUS, PHYSICS_TILE, type Ground } from './ground-bodies.ts';


/** Load Rapier's WebAssembly. Call once before the first {@link SimPhysics}. */
export async function initPhysics(): Promise<void> {
  await RAPIER.init();
}

/** A body and the wheels it drives on, or no wheels at all on a boat. */
interface Built {
  chassis: RAPIER.RigidBody;
  wheels: RAPIER.DynamicRayCastVehicleController | undefined;
}

/**
 * The physics of a session: the ground under the player and the vehicle on it.
 *
 * Build one, step it once per simulation tick, and throw it away with
 * {@link SimPhysics.dispose}. Every step writes what came out of the world
 * into the {@link SimState} it is given.
 */
export class SimPhysics {
  private readonly world: RAPIER.World;
  private readonly ground: Ground;
  /** The tiles of ground and the decks over them, which follow whoever is moving. */
  private readonly bodies: GroundBodies;
  /** The Rapier half of the arsenal: the casts, the swings and the flights. */
  private readonly shots: Gunfire;
  /** What the driver's input does to the wheels, the rider and the hull. */
  private readonly controls: Drivetrain;
  /** The row of the roster the body was built from. `adopt` reads it off the record. */
  private spec: VehicleSpec;
  /** The vehicle's moving body, and undefined while nobody is in it. */
  private chassis: RAPIER.RigidBody | undefined;
  private wheels: RAPIER.DynamicRayCastVehicleController | undefined;
  /** The parked vehicle's fixed body, and undefined while it is being driven. */
  private parked: RAPIER.RigidBody | undefined;
  /**
   * The collider of whichever vehicle body stands in the world, so a shot can
   * say whether it hit the vehicle or the ground (spec section 11.6).
   */
  private body: RAPIER.Collider | undefined;
  /** The player's capsule, and undefined while they are in a vehicle. */
  private walker: Walker | undefined;
  /** The traffic near the player, or undefined on a ground with no roads to drive. */
  readonly traffic: TrafficBodies | undefined;
  /**
   * The police cars and the faction enforcers near the player as bodies (spec
   * sections 14, 17.2), so a roadblock is a wall and a wave can be shot at.
   */
  readonly units: UnitBodies;
  /** Scratch vectors and forces, so a tick allocates nothing. */
  private readonly point = { x: 0, y: 0, z: 0 };
  private readonly axis = { x: 0, y: 0, z: 0 };
  private readonly force = { x: 0, y: 0, z: 0 };
  /** Reused by the crowd reactions of spec section 20.1, for the same reason. */
  private readonly ids: number[] = [];
  /** The one ray every shot and every projectile step is cast with. */
  private readonly from = { x: 0, y: 0, z: 0 };
  private readonly along = { x: 0, y: 0, z: 0 };
  private readonly ray = new RAPIER.Ray(this.from, this.along);

  constructor(ground: Ground, state: SimState) {
    this.ground = ground;
    this.spec = specOf(state.vehicle.cls);
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.bodies = new GroundBodies(this.world, ground);
    this.shots = new Gunfire(this.world);
    this.controls = new Drivetrain(ground);
    this.traffic = ground.traffic === undefined ? undefined : new TrafficBodies(this.world, ground.traffic, ground.tram);
    this.units = new UnitBodies(this.world);
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
    this.bodies.cover(p.driving ? state.vehicle.x : p.x, p.driving ? state.vehicle.z : p.y);
    if (p.driving) {
      const built = this.build(state.vehicle);
      this.chassis = built.chassis;
      this.wheels = built.wheels;
    } else {
      this.parked = this.buildParked(state.vehicle);
      this.walker = buildWalker(this.world, state);
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
      this.bodies.cover(state.player.x, state.player.y);
      // A player bent over a lock stands at the door (spec section 11.4): they
      // are stepped with nothing held down, so only gravity moves them.
      walk(this.walker as Walker, state, state.theft === null ? input : EMPTY_INPUT, this.ground.seaLevel);
    } else {
      this.bodies.cover(v.x, v.z);
      // Rapier keeps a force until it is told to forget it, so a tick that adds
      // one has to clear the last tick's first. Without this the buoyancy of a
      // hull and the rider of a motorcycle both grow without bound.
      chassis.resetForces(false);
      chassis.resetTorques(false);
      if (this.wheels === undefined) {
        this.controls.sail(chassis, v, input, this.spec);
      } else {
        // How wet the road is is the weather of the tick (spec section 13.4),
        // which is a pure function of the seed and the tick like everything
        // else, so a replay drives on the same water the session did.
        this.controls.drive(this.wheels, v, input, this.spec, weatherAt(state.seed, state.tick).wetness);
        this.controls.hold(chassis, v, this.spec);
        this.wheels.updateVehicle(this.world.timestep);
      }
    }
    // The traffic is aimed at the next tick once the player's own move is known.
    if (state.player.driving) this.traffic?.lead(state, v.x, v.z, this.ground.parked);
    else this.traffic?.lead(state, state.player.x, state.player.y, this.ground.parked);
    this.world.step();
    this.read(state);
    this.traffic?.settle(state);
    // The police answer the tick the player has just driven, so they are
    // stepped once the record says where that left them (spec section 14).
    this.ground.police?.step(state);
    // The faction enforcers of spec section 17.2 answer the same tick for the
    // same reason: they walk at where the player has just got to.
    this.ground.enforcers?.step(state);
    this.units.settle(state);
    // The helicopter flies over the ground rather than over the roads, so the
    // record is told how high the ground under it stands (spec section 14).
    for (const unit of state.police.units) {
      if (unit.kind === 'helicopter') unit.height = this.ground.heightAt(unit.x, unit.y);
    }
    const crash = chassis === undefined ? 0 : this.crash(state, wasX, wasY, wasZ);
    // The crowd answers the tick the car has just had (spec section 20.1): the
    // crash it took, or the people it is about to run over. It is read after
    // the step, so the fright is written where the car ended the tick.
    const crowd = this.ground.crowd;
    if (crowd !== undefined) stepCrowdReactions(state, crowd, crash, this.ids);
    // The weapons are run after the step, so a shot leaves the muzzle from where
    // the player ended the tick rather than from where they started it. A player
    // bent over a lock cannot shoot, for the same reason they cannot walk.
    this.shots.step(state, state.theft === null ? input : EMPTY_INPUT, this.target(state));
    this.shots.fly(state, this.target(state));
    this.burn(state);
    // The fires of every vehicle but the player's own, the spread between them
    // and the blazes the wrecks leave (spec section 11.3). It runs after
    // `burn`, so a player's car that went up this tick leaves its own blaze on
    // this tick. The services of spec section 20.3 then answer what is burning
    // and the crash just measured.
    stepFires(state);
    this.ground.emergency?.step(state, crash);
  }

  /** The police stations of the ground (spec section 11.7), which an arrest reads. */
  get stations(): readonly Place[] {
    return this.ground.stations ?? [];
  }

  /** The metro station entrances of the ground (spec section 13.3), which fast travel reads. */
  get metro(): readonly MetroPlace[] {
    return this.ground.metro ?? [];
  }

  /** The shops of the ground (spec section 16.1), which the doors and the counters read. */
  get shops(): readonly ShopPlace[] {
    return this.ground.shops ?? [];
  }

  /** The dealers of the ground (spec section 16.2), whose corners the contraband is traded at. */
  get dealers(): readonly DealerPlace[] {
    return this.ground.dealers ?? [];
  }

  /** The safehouses of the ground (spec section 16.3), which the doors and a respawn read. */
  get safehouses(): readonly SafehousePlace[] {
    return this.ground.safehouses ?? [];
  }

  /** The turf of the ground (spec section 17.2), which a takeover and the map overlay read. */
  get turf(): TerritoryMap | undefined {
    return this.ground.turf;
  }

  /** The corners the street crime of spec section 20.5 happens on, one set to a district. */
  get crimes(): readonly CrimeGround[] {
    return this.ground.crimes ?? [];
  }

  /** The work of the ground (spec section 18): the contacts, and where they send the player. */
  get missions(): MissionWorld | undefined {
    return this.ground.missions;
  }

  /**
   * Stand the vehicle the record now holds at a place, resting on the ground,
   * and rebuild its body there. `spawn` puts down a fresh vehicle; this keeps
   * the one the record carries, which is what a car taken out of a safehouse
   * garage needs (spec section 16.3): its paint, its dents and the station it
   * was left on are exactly what the garage kept.
   */
  settle(state: SimState, x: number, y: number, heading: number): void {
    const was = state.vehicle;
    const spec = specOf(was.cls);
    const ground = this.ground.heightAt(x, y);
    const rest = spec.hull === undefined ? ground : Math.max(ground, this.ground.seaLevel);
    const car = createVehicleState(spec, x, y, rest + rideHeight(spec), heading);
    // A garage keeps what was done to a car and not where it stood, so the
    // dents, the paint, the station it was left on and its beaten lock all come
    // out with it while the pose is fresh.
    car.damage = was.damage;
    car.paint = was.paint;
    car.station = was.station;
    car.hotwired = was.hotwired;
    state.vehicle = car;
    this.adopt(state);
  }

  /**
   * Stand a player the record has just moved on the ground under them, and
   * rebuild the bodies around them. A respawn (spec section 11.7) is what calls
   * it: the record says where they come back, and not how high the ground is.
   */
  stand(state: SimState): void {
    const p = state.player;
    p.height = this.ground.heightAt(p.x, p.y);
    this.adopt(state);
  }

  /** Release the Rapier world and everything in it. */
  dispose(): void {
    this.units.clear();
    this.wheels?.free();
    this.walker?.controller.free();
    this.world.free();
    this.bodies.clear();
  }

  /** How many tiles of ground carry a collider, which the budget test measures. */
  get groundTiles(): number {
    return this.bodies.count;
  }

  /**
   * What a shot fired this tick may hit, and whose body it may not. The
   * shooter is the body they are in, so nobody shoots their own door.
   */
  private target(state: SimState): ShotTarget {
    return {
      spec: this.spec,
      body: this.body,
      shooter: state.player.driving ? this.body : this.walker?.collider,
      police: this.units.police,
      enforcers: this.units.enforcers,
      crowd: this.ground.crowd,
      cars: this.traffic,
    };
  }

  /** The row of the roster being driven, so the HUD and the picker can name it. */
  get vehicle(): VehicleSpec {
    return this.spec;
  }

  /**
   * The damage of spec section 11.3: what the vehicle hit over the step it has
   * just taken, answered as the severity of the crash so the crowd can react
   * to it (spec section 20.1).
   *
   * The speed it lost is what its structure absorbed, and the direction it was
   * pushed in says which panel took it. The direction is read in the vehicle's
   * own frame, so a shunt from behind dents the boot whichever way the car
   * happens to be pointing. Whoever is driving takes their share of it.
   */
  private crash(state: SimState, wasX: number, wasY: number, wasZ: number): number {
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
    return severity;
  }

  /**
   * Run the player's own vehicle's fire for a tick (spec section 11.3). A fire
   * that reaches the end of its fuse throws the vehicle up and hurts whoever is
   * near enough to feel it. Only this one is burned here, because only this one
   * has a body to throw: every other vehicle of the record burns in `fire.ts`,
   * which is also where the fire spreads between them.
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
    this.body = this.world.createCollider(
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
    this.body = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(spec.halfLength, spec.halfHeight, spec.halfWidth),
      body,
    );
    return body;
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
    report(state, stepTheft(theft, state.seed, state.tick, pressed));
    if (!theft.open) return;
    // The lock is beaten once: the record carries it, so getting out again is
    // not a second break-in.
    state.vehicle.hotwired = true;
    commitCrime(state, 'theft');
    state.theft = null;
    p.driving = true;
    this.adopt(state);
  }

  /** Take every body of the player and their vehicle out of the world, so `adopt` can build them again. */
  private release(): void {
    this.wheels?.free();
    this.wheels = undefined;
    // Whichever body carried it is about to go, so the collider goes with it.
    this.body = undefined;
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
}

/**
 * Metres per second the vehicle has to be sliding across its own axle before a
 * tyre counts as skidding (spec section 11.3). It is one rule for every way of
 * getting there: a handbrake turn, a corner taken too fast and a spin all push
 * the vehicle sideways, and a tyre that is being pushed sideways is a tyre
 * leaving a mark. Below this the tyre is scrubbing, not sliding.
 */
const SKID_SLIP = 2.2;

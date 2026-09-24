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
 * This file owns the world and the bodies in it. The halves that need no such
 * ownership are next door: `ground-bodies.ts` is the ground and the decks
 * under the player, `vehicle-bodies.ts` builds the vehicle's bodies and reads
 * them back, `drivetrain.ts` is what the driver's input does to the wheels,
 * the rider and the hull, and `gunfire.ts` is what a shot, a swing and a
 * thrown thing do to the world. The places a ground carries — the stations,
 * the shops, the dealers — are handed over by `ground-places.ts`, which
 * `SimPhysics` extends.
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
import { cos as cosOf, hypot, sin as sinOf } from '../core/libm.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import { TICK_RATE } from './clock.ts';
import { stepCrowdReactions } from './crowd-reaction.ts';
import { stepMakeWay } from './make-way.ts';
import { stepCasualties, type CasualtyGround } from './casualty.ts';
import { strikeCrowd, type CarStrike } from './car-strike.ts';
import { stepFires } from './fire.ts';
import { blastDamageAt, BLAST_LIFT, CRASH_DAMAGE, hitVehicle, tickFire } from './damage.ts';
import { unrotate } from './frame.ts';
import { Drivetrain } from './drivetrain.ts';
import { Flight } from './flight.ts';
import { stepAirside, theftOf } from './airside.ts';
import { GroundBodies, type Ground } from './ground-bodies.ts';
import { GroundPlaces } from './ground-places.ts';
import { deckSurfaceAt } from '../world/decks.ts';
import { Ragdolls } from './ragdoll.ts';
import { SHUNS_RAGDOLL } from './collision-groups.ts';
import { Gunfire, type ShotTarget } from './gunfire.ts';
import { buildWalker, GRAVITY, walk, type Walker } from './walker-body.ts';
import { EMPTY_INPUT, type InputFrame } from './input.ts';
import {
  besidePlayer,
  exitPlace,
  EXIT_SPEED,
  hurt,
  reachesVehicle,
} from './on-foot.ts';
import type { SimState } from './simulation.ts';
import { TrafficBodies } from './traffic-bodies.ts';
import { GiveWay } from './give-way.ts';
import { buildParked, buildVehicle, readVehicle } from './vehicle-bodies.ts';
import { UnitBodies } from './unit-bodies.ts';
import { commitCrime, report } from './police.ts';
import { reachablePromoted, swapInto } from './steal.ts';
import { createTheft, isLocked, stepTheft, type TheftState } from './theft.ts';
import { boardingDone, createBoarding, startBoarding, type BoardingState } from './boarding.ts';
import { promotedOf } from './traffic.ts';
import {
  createVehicleState,
  headingOf,
  rideHeight,
  specOf,
  type VehicleClass,
  type VehicleSpec,
} from './vehicle.ts';
import { weatherAt } from './weather.ts';

export { PHYSICS_CELL, PHYSICS_RADIUS, PHYSICS_TILE, type Ground } from './ground-bodies.ts';


/** Load Rapier's WebAssembly. Call once before the first {@link SimPhysics}. */
export async function initPhysics(): Promise<void> {
  await RAPIER.init();
}

/**
 * The physics of a session: the ground under the player and the vehicle on it.
 *
 * Build one, step it once per simulation tick, and throw it away with
 * {@link SimPhysics.dispose}. Every step writes what came out of the world
 * into the {@link SimState} it is given.
 */
export class SimPhysics extends GroundPlaces {
  private readonly world: RAPIER.World;
  /** The tiles of ground and the decks over them, which follow whoever is moving. */
  private readonly bodies: GroundBodies;
  /** The Rapier half of the arsenal: the casts, the swings and the flights. */
  private readonly shots: Gunfire;
  /** What the driver's input does to the wheels, the rider and the hull. */
  private readonly controls: Drivetrain;
  /** What the engine and the air do to an aircraft (`flight.ts`). */
  private readonly flight: Flight;
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
  /** The traffic and the crowd keeping out of each other near the player (`give-way.ts`). */
  private readonly giveWay: GiveWay | undefined;
  /**
   * The police cars and the faction enforcers near the player as bodies (spec
   * sections 14, 17.2), so a roadblock is a wall and a wave can be shot at.
   */
  readonly units: UnitBodies;
  /** The Rapier ragdolls of the freshest casualties near the player (`ragdoll.ts`). */
  readonly ragdolls: Ragdolls;
  /** Scratch vectors and forces, so a tick allocates nothing. */
  private readonly point = { x: 0, y: 0, z: 0 };
  private readonly force = { x: 0, y: 0, z: 0 };
  /** Reused by the crowd reactions of spec section 20.1, for the same reason. */
  private readonly ids: number[] = [];
  /** The ray a hit person's throw is measured along, to the first wall. */
  private readonly throwRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  /** What a hit on a person reads of the world: the walls that stop a body, and the ground it lands on. */
  private readonly casualtyGround: CasualtyGround = {
    reach: (x, h, y, dir, max) => this.reachAlong(x, h, y, dir, max),
    heightAt: (x, y) => this.ground.heightAt(x, y),
  };

  constructor(ground: Ground, state: SimState) {
    super(ground);
    this.spec = specOf(state.vehicle.cls);
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.bodies = new GroundBodies(this.world, ground);
    this.shots = new Gunfire(this.world);
    this.controls = new Drivetrain(ground);
    this.flight = new Flight(ground);
    this.traffic = ground.traffic === undefined ? undefined : new TrafficBodies(this.world, ground.traffic, ground.tram);
    this.giveWay = ground.traffic === undefined ? undefined : new GiveWay(ground.traffic, ground.crowd);
    this.units = new UnitBodies(this.world);
    this.ragdolls = new Ragdolls(this.world, ground);
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
   * Anything put down on a bridge rests on its deck.
   *
   * A vehicle put down while the player is on foot stands beside them rather
   * than on them, and they stay on foot: the debug picker of spec section 11.3
   * leaves a car at the kerb to walk over to.
   */
  spawn(state: SimState, x: number, y: number, heading = 0, cls: VehicleClass = state.vehicle.cls): void {
    const spec = specOf(cls);
    const place = state.player.driving ? { x, y, heading } : besidePlayer(state.player, spec);
    // A bridge carves no ground, so under a deck the heightfield is the water
    // or the valley floor it spans: the deck is asked first.
    const deck = this.ground.decks === undefined ? undefined : deckSurfaceAt(this.ground.decks, place.x, place.y);
    const ground = deck ?? this.ground.heightAt(place.x, place.y);
    const rest = spec.hull === undefined ? ground : Math.max(ground, this.ground.seaLevel);
    state.vehicle = createVehicleState(spec, place.x, place.y, rest + rideHeight(spec), place.heading);
    // A vehicle put down under a player who is driving is open to them, since
    // they are sitting in it: a session does not start with a break-in. One
    // left at the kerb beside a player on foot is not (spec section 11.4).
    state.vehicle.hotwired = state.player.driving;
    // An attempt at the lock of the vehicle this one replaces means nothing:
    // the new one carries its own lock. A door half open goes with the vehicle.
    state.theft = null;
    state.boarding = null;
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
      const built = buildVehicle(this.world, this.spec, state.vehicle);
      this.chassis = built.chassis;
      this.wheels = built.wheels;
      this.body = built.collider;
    } else {
      const parked = buildParked(this.world, this.spec, state.vehicle);
      this.parked = parked.body;
      this.body = parked.collider;
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
      walk(this.walker as Walker, state, busy(state) ? EMPTY_INPUT : input, this.ground.seaLevel);
    } else {
      this.bodies.cover(v.x, v.z);
      // Rapier keeps a force until it is told to forget it, so a tick that adds
      // one has to clear the last tick's first. Without this the buoyancy of a
      // hull and the rider of a motorcycle both grow without bound.
      chassis.resetForces(false);
      chassis.resetTorques(false);
      if (this.wheels === undefined) {
        const held = state.boarding === null ? input : EMPTY_INPUT;
        if (this.spec.hull !== undefined) this.controls.sail(chassis, v, held, this.spec);
        // A helicopter has neither wheels nor a hull: its rotor is all of it.
        if (this.spec.flight !== undefined) this.flight.fly(chassis, v, held, this.spec);
      } else {
        // How wet the road is is the weather of the tick (spec section 13.4),
        // which is a pure function of the seed and the tick like everything
        // else, so a replay drives on the same water the session did.
        // A driver on the way out of the seat holds the vehicle on its brakes.
        const held = state.boarding === null ? input : BRAKED;
        this.controls.drive(this.wheels, v, held, this.spec, weatherAt(state.seed, state.tick).wetness);
        this.controls.hold(chassis, v, this.spec);
        // A plane rolls and brakes on its wheels, and flies on its engine.
        if (this.spec.flight !== undefined) this.flight.fly(chassis, v, held, this.spec);
        // The wheels roll over a ragdoll rather than standing on it: `car-strike.ts` is the bump.
        this.wheels.updateVehicle(this.world.timestep, undefined, SHUNS_RAGDOLL);
      }
    }
    // The traffic and the crowd give way to each other and to the player
    // before the traffic is aimed at the next tick.
    if (state.player.driving) this.giveWay?.step(state, v.x, v.z, this.casualtyGround);
    else this.giveWay?.step(state, state.player.x, state.player.y, this.casualtyGround);
    // The people round the player on foot step out of their way (`make-way.ts`).
    if (this.ground.crowd !== undefined) stepMakeWay(state, this.ground.crowd, this.ids);
    // The traffic is aimed at the next tick once the player's own move is known.
    if (state.player.driving) this.traffic?.lead(state, v.x, v.z, this.ground.parked);
    else this.traffic?.lead(state, state.player.x, state.player.y, this.ground.parked);
    this.world.step();
    this.read(state);
    this.traffic?.settle(state);
    // The police answer the tick the player has just driven, so they are
    // stepped once the record says where that left them (spec section 14).
    // A player on the airport's airside is reported first, so the police
    // answer it on the same tick (`airside.ts`).
    stepAirside(state, this.ground.airfields);
    this.ground.police?.step(state, this.casualtyGround, this.ground.crimes);
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
    if (crowd !== undefined) {
      // The car strikes the people it is on top of (spec section 13.1), and
      // feels them: it slows, and bumps over a body in the road.
      if (chassis !== undefined) this.feel(state, chassis, strikeCrowd(state, crowd, this.spec, this.casualtyGround, this.ids));
      stepCrowdReactions(state, crowd, crash, this.ids);
      stepCasualties(state, crowd, this.ids);
    }
    // The weapons are run after the step, so a shot leaves the muzzle from where
    // the player ended the tick rather than from where they started it. A player
    // bent over a lock cannot shoot, for the same reason they cannot walk.
    this.shots.step(state, busy(state) ? EMPTY_INPUT : input, this.target(state));
    this.shots.fly(state, this.target(state));
    this.burn(state);
    // The fires of every vehicle but the player's own, the spread between them
    // and the blazes the wrecks leave (spec section 11.3). It runs after
    // `burn`, so a player's car that went up this tick leaves its own blaze on
    // this tick. The services of spec section 20.3 then answer what is burning
    // and the crash just measured.
    stepFires(state);
    this.ground.emergency?.step(state, crash);
    // Last, once every round, blow, blast and car of the tick has landed: the
    // ragdolls read what the step did to them, and the hits of this tick get theirs.
    this.ragdolls.step(state);
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
    this.ragdolls.clear();
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
      officers: this.units.officers,
      crew: this.units.crew,
      crowd: this.ground.crowd,
      ground: this.casualtyGround,
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
    // `unrotate` answers the vehicle's own axes: `x` along it, `y` up and `z`
    // across it. The panel rule reads them along, across, up, so the last two
    // are handed over the other way round.
    const severity = hitVehicle(
      v.damage,
      this.spec,
      this.point.x,
      this.point.z,
      this.point.y,
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
    hurt(p, blastDamageAt(p.driving ? 0 : hypot(p.x - v.x, p.y - v.z)));
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
   * Put what the people it struck took from the car into its body: the speed
   * it gave them, taken off along its travel, and the bump of a body under it.
   * The record is read again, as after a blast, so the next tick does not read
   * the loss as a crash.
   */
  private feel(state: SimState, chassis: RAPIER.RigidBody, strike: CarStrike): void {
    if (strike.loss === 0 && strike.bump === 0) return;
    const v = state.vehicle;
    const speed = hypot(v.vx, v.vz);
    const mass = chassis.mass();
    // Never more than half of what the car carries: a person does not stop a car.
    const loss = speed > 0 ? Math.min(strike.loss, mass * speed * 0.5) : 0;
    this.force.x = speed > 0 ? (-v.vx / speed) * loss : 0;
    this.force.y = strike.bump;
    this.force.z = speed > 0 ? (-v.vz / speed) * loss : 0;
    chassis.applyImpulse(this.force, true);
    const linear = chassis.linvel();
    v.vx = linear.x;
    v.vy = linear.y;
    v.vz = linear.z;
  }

  /**
   * Metres a body pushed from a place along a heading gets before something
   * solid stops it, measured at the height of its middle. The player's own
   * bodies and every sensor are left out, and the body stops a little short of
   * the wall rather than inside it.
   */
  private reachAlong(x: number, h: number, y: number, dir: number, max: number): number {
    const ray = this.throwRay;
    ray.origin = { x, y: h, z: y };
    ray.dir = { x: cosOf(dir), y: 0, z: sinOf(dir) };
    const hit = this.world.castRay(ray, max, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, SHUNS_RAGDOLL, this.body);
    return hit === null ? max : Math.max(0, hit.timeOfImpact - 0.3);
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
    readVehicle(state.vehicle, this.chassis as RAPIER.RigidBody, this.wheels, this.spec);
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
    // An officer who has hold of a driver pulls them out of the seat, whatever
    // they are pressing (spec section 11.7), and does not wait for the door.
    const dragged = p.driving && state.police.cuffs !== null;
    if (dragged) {
      state.boarding = null;
      this.alight(state);
      return;
    }
    if (state.boarding !== null) {
      this.board(state, state.boarding);
      return;
    }
    if (!pressed) return;
    if (p.driving) {
      if (Math.abs(state.vehicle.speed) > EXIT_SPEED) return;
      state.boarding = createBoarding('out', state.tick, -1);
    } else if (reachesVehicle(p, state.vehicle, this.spec)) {
      if (isLocked(state.vehicle, this.spec)) {
        state.theft = createTheft(this.spec, state.tick);
        return;
      }
      this.climbIn(state);
    } else {
      // Out of reach of their own, the player takes a car of the city they
      // have promoted (spec section 5.3), and a locked one is worked at first.
      const record = reachablePromoted(state, p);
      if (record === undefined) return;
      const spec = specOf(record.vehicle.cls);
      if (isLocked(record.vehicle, spec)) state.theft = createTheft(spec, state.tick, record.id);
      else this.take(state, record.id);
    }
  }

  /** Start the move into the player's own vehicle, through the side they stand on (`boarding.ts`). */
  private climbIn(state: SimState): void {
    state.boarding = startBoarding(state.player, state.vehicle, this.spec, state.tick);
  }

  /**
   * One tick of a move into the seat or out of it. It ends in the seat or on
   * the pavement once its time is up. A move in is dropped when the vehicle is
   * no longer within reach — a blast that throws the car across the street
   * takes the door with it — and when the player is being arrested.
   */
  private board(state: SimState, boarding: BoardingState): void {
    const p = state.player;
    if (boarding.way === 'in' && (!reachesVehicle(p, state.vehicle, this.spec) || state.police.cuffs !== null)) {
      state.boarding = null;
      return;
    }
    if (!boardingDone(boarding, this.spec, state.tick)) return;
    state.boarding = null;
    if (boarding.way === 'out') {
      this.alight(state);
      return;
    }
    p.driving = true;
    this.adopt(state);
  }

  /**
   * Step the player out of their vehicle and stand them at its door, on foot.
   * The exit key does this, and so does the start of a session: the player
   * starts beside their car, not in it.
   */
  alight(state: SimState): void {
    this.stepOut(state);
    this.adopt(state);
  }

  /** Stand the driver at the door of their vehicle, on foot. The bodies are left to `adopt`. */
  private stepOut(state: SimState): void {
    const p = state.player;
    const place = exitPlace(state.vehicle, this.spec);
    p.x = place.x;
    p.y = place.y;
    p.height = Math.max(this.ground.heightAt(place.x, place.y), state.vehicle.y - this.spec.halfHeight);
    p.heading = place.heading;
    p.speed = 0;
    p.vy = 0;
    p.grounded = false;
    p.driving = false;
  }

  /**
   * Take the promoted vehicle under `id`, leaving the player's own in its place
   * (`steal.ts`), and start the move into it. The swap is made as the hand
   * reaches the door rather than once the player sits down, so the car being
   * climbed into is the player's own model, with a door that opens.
   */
  private take(state: SimState, id: number): void {
    swapInto(state, id);
    this.traffic?.forget(id);
    commitCrime(state, theftOf(state.vehicle.cls));
    this.adopt(state);
    this.climbIn(state);
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
    const v = theft.target === undefined ? state.vehicle : promotedOf(state.traffic, theft.target)?.vehicle;
    if (v === undefined || !reachesVehicle(p, v, specOf(v.cls))) {
      state.theft = null;
      return;
    }
    report(state, stepTheft(theft, state.seed, state.tick, pressed));
    if (!theft.open) return;
    // The lock is beaten once: the record carries it, so getting out again is
    // not a second break-in.
    v.hotwired = true;
    state.theft = null;
    if (theft.target !== undefined) {
      this.take(state, theft.target);
      return;
    }
    commitCrime(state, theftOf(state.vehicle.cls));
    this.climbIn(state);
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

/** True while the player is busy with a lock or a door, and so is moved with nothing pressed. */
function busy(state: SimState): boolean {
  return state.theft !== null || state.boarding !== null;
}

/** What a driver on the way out of the seat presses: nothing but the handbrake. */
const BRAKED: Readonly<InputFrame> = Object.freeze({ ...EMPTY_INPUT, handbrake: true });

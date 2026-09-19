/**
 * The traffic near the player, as Rapier bodies (spec sections 2.4, 5.3).
 *
 * Inside the box of ground the physics holds, each ambient vehicle is a
 * kinematic body moved along its tour one tick at a time. The player's car
 * hits it as a solid and cannot push it off its line. Outside the box a vehicle
 * has no body and is not stepped. A vehicle that comes into the box is
 * evaluated at the tick it arrives on, and from then on it is stepped.
 *
 * A vehicle the player touches — with their car, parked or driven, with
 * themselves on foot, or with a shot, a swing or a blast — leaves its tour for
 * good. It becomes a dynamic body with
 * its speed, and its record goes into {@link TrafficState}, which is simulation
 * state like the player's own vehicle. A promoted vehicle has nobody driving
 * it, so it is a box that slides to a stop, and the speed it loses in one tick
 * is a crash, measured as the player's own car measures one. Out of the box it
 * keeps the pose it had, the way the player's parked car does.
 *
 * The parked cars of the streets and car parks (`parked-bodies.ts`) stand in
 * the same box as fixed bodies, and a touch promotes one the same way, from
 * standing still. The trams (`tram-bodies.ts`) stand in it as kinematic bodies
 * that no touch takes off their loop.
 */
import { cos, sin } from '../core/libm.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import { capsuleOf } from './on-foot.ts';
import { SHUNS_RAGDOLL } from './collision-groups.ts';
import { ParkedBodies } from './parked-bodies.ts';
import { PARKED_ID, type ParkedCar, type ParkedCars } from './parked.ts';
import { hitVehicle } from './damage.ts';
import { rotate, unrotate } from './frame.ts';
import { TramBodies } from './tram-bodies.ts';
import type { TramLine } from './tram.ts';
import { PHYSICS_RADIUS, PHYSICS_TILE } from './ground-bodies.ts';
import type { SimState } from './simulation.ts';
import {
  addPromoted,
  footprintsTouch,
  promotedOf,
  type AmbientPose,
  type AmbientVehicle,
  type AmbientTraffic,
  type Footprint,
  type PromotedVehicle,
  type TrafficCursor,
} from './traffic.ts';
import { createVehicleState, headingOf, rideHeight, specOf, type VehicleSpec, type VehicleState } from './vehicle.ts';

/** Metres apart two footprints count as touching. A kinematic body stops a car a hair short of its box. */
export const TOUCH_MARGIN = 0.1;

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/** Damping of a promoted vehicle's slide and spin: nobody is steering it, and its brakes are off. */
const PROMOTED_DAMPING = 0.3;
const PROMOTED_SPIN_DAMPING = 0.8;

/** How hard the underside of a promoted vehicle drags on the road. */
const PROMOTED_FRICTION = 0.8;

/** An ambient vehicle standing in the world as a kinematic body. */
interface Moving {
  cursor: TrafficCursor;
  spec: VehicleSpec;
  body: RAPIER.RigidBody;
}

/** A promoted vehicle standing in the world as a dynamic body. */
interface Pushed {
  id: number;
  spec: VehicleSpec;
  body: RAPIER.RigidBody;
}

export class TrafficBodies {
  private readonly world: RAPIER.World;
  private readonly traffic: AmbientTraffic;
  /** Ascending by id. */
  private moving: Moving[] = [];
  /** Ascending by id. */
  private pushed: Pushed[] = [];
  private readonly ids: number[] = [];
  private readonly pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  private readonly spot = { x: 0, y: 0, z: 0 };
  private readonly turn = { x: 0, y: 0, z: 0, w: 1 };
  private readonly axis = { x: 0, y: 0, z: 0 };
  private readonly theirs: Footprint = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };
  private readonly car: Footprint = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };
  private readonly walker: Footprint = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };
  /** The parked cars in the box, once the game has handed them over. */
  private parked: ParkedBodies | undefined;
  /** The cars of the trams in the box, or undefined where no tram runs. */
  readonly trams: TramBodies | undefined;

  constructor(world: RAPIER.World, traffic: AmbientTraffic, tram?: TramLine) {
    this.world = world;
    this.traffic = traffic;
    this.trams = tram === undefined ? undefined : new TramBodies(world, tram);
  }

  /** The cursors of the vehicles being stepped, ascending by id. The sweep compares them with evaluation. */
  get cursors(): readonly TrafficCursor[] {
    return this.moving.map((entry) => entry.cursor);
  }

  /** How many parked cars stand in the world as fixed bodies. */
  get parkedBodies(): number {
    return this.parked?.count ?? 0;
  }

  /**
   * The record of the car of the city a collider belongs to, promoting it
   * first where it still drives its tour or stands in its bay (spec section
   * 5.3). A shot, a swing and a blast all come through here, so whatever meets
   * a car takes it off its trajectory for good. Undefined where the collider is
   * not a car of the city: the ground, a wall, a police car.
   */
  strike(state: SimState, collider: number): PromotedVehicle | undefined {
    const body = this.world.getCollider(collider)?.parent();
    if (body === undefined || body === null) return undefined;
    const handle = body.handle;
    const pushed = this.pushed.find((entry) => entry.body.handle === handle);
    if (pushed !== undefined) return promotedOf(state.traffic, pushed.id);
    const i = this.moving.findIndex((entry) => entry.body.handle === handle);
    let id: number | undefined;
    if (i >= 0) {
      const entry = this.moving[i] as Moving;
      this.moving.splice(i, 1);
      this.promote(state, entry, this.traffic.pose(entry.cursor, this.pose));
      id = entry.cursor.id;
    } else {
      const bay = this.parked?.take(handle, (at, car, spec) => this.handParked(state, at, car, spec));
      if (bay !== undefined) id = PARKED_ID + bay;
    }
    return id === undefined ? undefined : promotedOf(state.traffic, id);
  }

  /** Promote every car of the city with a collider inside a ball, which is the reach of a blast. */
  strikeNear(state: SimState, x: number, h: number, y: number, radius: number): void {
    const colliders: number[] = [];
    this.spot.x = x;
    this.spot.y = h;
    this.spot.z = y;
    this.world.intersectionsWithShape(this.spot, IDENTITY, new RAPIER.Ball(radius), (collider) => {
      colliders.push(collider.handle);
      return true;
    }, undefined, SHUNS_RAGDOLL);
    for (const collider of colliders) this.strike(state, collider);
  }

  /**
   * Take a promoted vehicle's body out of the world, so the next tick builds it
   * again from the record. A theft swaps the record under an id for another
   * vehicle (`steal.ts`), and the body has to follow it.
   */
  forget(id: number): void {
    const i = this.pushed.findIndex((entry) => entry.id === id);
    if (i < 0) return;
    this.world.removeRigidBody((this.pushed[i] as Pushed).body);
    this.pushed.splice(i, 1);
  }

  /** How many promoted vehicles have a body in the world. */
  get promotedBodies(): number {
    return this.pushed.length;
  }

  /**
   * Before the world is stepped from `state.tick`: bring the vehicles that are
   * in the box round `(x, z)` into it, drop the ones that have left, and aim
   * every kinematic body at where its tour puts it on the next tick. The parked
   * cars of the box are stood in their bays.
   */
  lead(state: SimState, x: number, z: number, parked?: ParkedCars): void {
    const cx = Math.floor(x / PHYSICS_TILE);
    const cz = Math.floor(z / PHYSICS_TILE);
    const minX = (cx - PHYSICS_RADIUS) * PHYSICS_TILE;
    const minY = (cz - PHYSICS_RADIUS) * PHYSICS_TILE;
    const maxX = (cx + PHYSICS_RADIUS + 1) * PHYSICS_TILE;
    const maxY = (cz + PHYSICS_RADIUS + 1) * PHYSICS_TILE;
    const inside = (pose: AmbientPose): boolean => pose.x >= minX && pose.x < maxX && pose.y >= minY && pose.y < maxY;

    const traffic = this.traffic;
    const ids = traffic.near(minX, minY, maxX, maxY, this.ids);
    const kept: Moving[] = [];
    let k = 0;
    for (const id of ids) {
      while (k < this.moving.length && (this.moving[k] as Moving).cursor.id < id) this.drop(this.moving[k++] as Moving);
      let entry = this.moving[k]?.cursor.id === id ? (this.moving[k++] as Moving) : undefined;
      if (promotedOf(state.traffic, id) !== undefined) {
        if (entry !== undefined) this.drop(entry);
        continue;
      }
      if (entry === undefined) {
        // Evaluated on demand at the tick it arrives on, then stepped.
        const cursor = traffic.cursorAt(id, state.tick);
        if (!traffic.edgeMeets(traffic.edgeOf(cursor), minX, minY, maxX, maxY)) continue;
        if (!inside(traffic.pose(cursor, this.pose))) continue;
        entry = this.enter(cursor, this.pose);
      }
      traffic.advance(entry.cursor);
      traffic.pose(entry.cursor, this.pose);
      if (!inside(this.pose)) {
        this.drop(entry);
        continue;
      }
      this.place(this.pose, entry.spec);
      entry.body.setNextKinematicTranslation(this.spot);
      entry.body.setNextKinematicRotation(this.turn);
      kept.push(entry);
    }
    while (k < this.moving.length) this.drop(this.moving[k++] as Moving);
    this.moving = kept;
    // The game hands the cars over once, when the chunk workers have laid out the bays.
    this.parked ??= parked === undefined ? undefined : new ParkedBodies(this.world, parked);
    this.parked?.lead(state, minX, minY, maxX, maxY);
    this.standPromoted(state, minX, minY, maxX, maxY);
    this.trams?.lead(state.tick, minX, minY, maxX, maxY);
  }

  /**
   * After the world is stepped: read the promoted bodies back into their
   * records, then promote every vehicle the player now touches.
   */
  settle(state: SimState): void {
    for (const entry of this.pushed) this.read(state, entry, promotedOf(state.traffic, entry.id) as PromotedVehicle);
    const v = state.vehicle;
    const spec = specOf(v.cls);
    setFootprint(this.car, v.x, v.z, headingOf(v), spec.halfLength, spec.halfWidth);
    const onFoot = !state.player.driving;
    if (onFoot) {
      const radius = capsuleOf(state.character).radius;
      setFootprint(this.walker, state.player.x, state.player.y, 0, radius, radius);
    }
    const kept: Moving[] = [];
    for (const entry of this.moving) {
      const pose = this.traffic.pose(entry.cursor, this.pose);
      setFootprint(this.theirs, pose.x, pose.y, pose.heading, entry.spec.halfLength, entry.spec.halfWidth);
      const touched =
        footprintsTouch(this.car, this.theirs, TOUCH_MARGIN) || (onFoot && footprintsTouch(this.walker, this.theirs, TOUCH_MARGIN));
      if (touched) this.promote(state, entry, pose);
      else kept.push(entry);
    }
    this.moving = kept;
    this.parked?.touched(this.car, onFoot ? this.walker : undefined, TOUCH_MARGIN, (bay, car, spec) => this.handParked(state, bay, car, spec));
  }

  /** Hand a parked car taken out of its bay to the physics, standing still where it stood. */
  private handParked(state: SimState, bay: number, car: ParkedCar, spec: VehicleSpec): void {
    const bays = (this.parked as ParkedBodies).cars.bays;
    const at = { x: bays.x[bay] as number, y: bays.y[bay] as number, height: bays.height[bay] as number, heading: bays.heading[bay] as number, speed: 0 };
    this.hand(state, PARKED_ID + bay, car.paint, spec, at);
  }

  /** Take a vehicle off its tour and hand it to the physics, moving as it was. */
  private promote(state: SimState, entry: Moving, pose: AmbientPose): void {
    this.world.removeRigidBody(entry.body);
    const paint = (this.traffic.vehicles[entry.cursor.id] as AmbientVehicle).paint;
    this.hand(state, entry.cursor.id, paint, entry.spec, pose);
  }

  /** Put a vehicle's record into the state and give it a dynamic body, moving as its pose says. */
  private hand(state: SimState, id: number, paint: number, spec: VehicleSpec, pose: AmbientPose): void {
    const vehicle = createVehicleState(spec, pose.x, pose.y, pose.height + rideHeight(spec), pose.heading);
    vehicle.vx = cos(pose.heading) * pose.speed;
    vehicle.vz = sin(pose.heading) * pose.speed;
    vehicle.speed = pose.speed;
    addPromoted(state.traffic, { id, paint, vehicle });
    this.addPushed({ id, spec, body: this.buildPushed(vehicle, spec) });
  }

  /** Give a body to every promoted vehicle in the box, and take it from those that have left. */
  private standPromoted(state: SimState, minX: number, minY: number, maxX: number, maxY: number): void {
    const kept: Pushed[] = [];
    let k = 0;
    for (const record of state.traffic.promoted) {
      while (k < this.pushed.length && (this.pushed[k] as Pushed).id < record.id) this.world.removeRigidBody((this.pushed[k++] as Pushed).body);
      const entry = this.pushed[k]?.id === record.id ? (this.pushed[k++] as Pushed) : undefined;
      const v = record.vehicle;
      const inBox = v.x >= minX && v.x < maxX && v.z >= minY && v.z < maxY;
      if (entry !== undefined && !inBox) this.world.removeRigidBody(entry.body);
      if (entry !== undefined && inBox) kept.push(entry);
      if (entry === undefined && inBox) {
        const spec = specOf(v.cls);
        kept.push({ id: record.id, spec, body: this.buildPushed(v, spec) });
      }
    }
    while (k < this.pushed.length) this.world.removeRigidBody((this.pushed[k++] as Pushed).body);
    this.pushed = kept;
  }

  private addPushed(entry: Pushed): void {
    let i = this.pushed.length;
    while (i > 0 && (this.pushed[i - 1] as Pushed).id > entry.id) i--;
    this.pushed.splice(i, 0, entry);
  }

  private enter(cursor: TrafficCursor, pose: AmbientPose): Moving {
    const spec = specOf((this.traffic.vehicles[cursor.id] as AmbientVehicle).cls);
    this.place(pose, spec);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.spot.x, this.spot.y, this.spot.z).setRotation(this.turn),
    );
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(spec.halfLength, spec.halfHeight, spec.halfWidth), body);
    return { cursor, spec, body };
  }

  private drop(entry: Moving): void {
    this.world.removeRigidBody(entry.body);
  }

  /** The middle of the body and its turn, for a pose on the road. */
  private place(pose: AmbientPose, spec: VehicleSpec): void {
    this.spot.x = pose.x;
    this.spot.y = pose.height + rideHeight(spec);
    this.spot.z = pose.y;
    // A yaw of minus the heading points local +x along the map heading.
    this.turn.x = 0;
    this.turn.y = sin(-pose.heading / 2);
    this.turn.z = 0;
    this.turn.w = cos(-pose.heading / 2);
  }

  /**
   * A promoted vehicle's body: one box from the road to the roof, since it has
   * no wheels to stand on, so it rests at the height it was driving at.
   */
  private buildPushed(v: VehicleState, spec: VehicleSpec): RAPIER.RigidBody {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(v.x, v.y, v.z)
        .setRotation({ x: v.qx, y: v.qy, z: v.qz, w: v.qw })
        .setLinvel(v.vx, v.vy, v.vz)
        .setAngvel({ x: v.ax, y: v.ay, z: v.az })
        .setLinearDamping(PROMOTED_DAMPING)
        .setAngularDamping(PROMOTED_SPIN_DAMPING),
    );
    const ride = rideHeight(spec);
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(spec.halfLength, (ride + spec.halfHeight) / 2, spec.halfWidth)
        .setTranslation(0, (spec.halfHeight - ride) / 2, 0)
        .setMass(spec.mass)
        .setFriction(PROMOTED_FRICTION)
        // A body thrown into a promoted car does not push it.
        .setCollisionGroups(SHUNS_RAGDOLL),
      body,
    );
    return body;
  }

  /**
   * Read a promoted body back into its record. The speed it lost over the step
   * is a crash (spec section 11.3), read in its own frame so the panel facing
   * the blow is the one that takes it, exactly as `physics.ts` measures the
   * player's car. Nobody is in it to be hurt.
   */
  private read(state: SimState, entry: Pushed, record: PromotedVehicle): void {
    const v = record.vehicle;
    const wasX = v.vx;
    const wasY = v.vy;
    const wasZ = v.vz;
    const t = entry.body.translation();
    const r = entry.body.rotation();
    const linear = entry.body.linvel();
    const angular = entry.body.angvel();
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
    rotate(this.axis, v, 1, 0, 0);
    v.speed = v.vx * this.axis.x + v.vy * this.axis.y + v.vz * this.axis.z;
    unrotate(this.axis, v, v.vx - wasX, v.vy - wasY, v.vz - wasZ);
    // `unrotate` answers along, up and across; the damage reads along, across and up.
    hitVehicle(v.damage, entry.spec, this.axis.x, this.axis.z, this.axis.y, state.seed, state.tick, record.id);
  }
}

function setFootprint(out: Footprint, x: number, y: number, heading: number, halfLength: number, halfWidth: number): void {
  out.x = x;
  out.y = y;
  out.heading = heading;
  out.halfLength = halfLength;
  out.halfWidth = halfWidth;
}

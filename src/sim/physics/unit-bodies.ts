/**
 * Everybody but the player and the traffic who stands in the physics world as a
 * body: the police cars and the officers on foot of spec section 14, the
 * faction enforcers of spec section 17.2, and the fire engines and ambulances
 * of spec section 20.3.
 *
 * The two are held together because they are given a body over the same box of
 * ground — the one the tiles of `ground-bodies.ts` cover, centred on whoever
 * the player is moving — and taken out of the world at the same moment. Each
 * half keeps its own file, because a car is a box moved with its heading and a
 * person is an upright capsule: `police-bodies.ts` and `person-bodies.ts`.
 * `emergency-bodies.ts` is the police cars' file with the services' sizes.
 *
 * `physics.ts` owns one of these and hands every part to `gunfire.ts`, which
 * asks each of them which unit a collider belongs to.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS_RADIUS, PHYSICS_TILE } from './ground-bodies.ts';
import { EmergencyBodies } from '../city/emergency-bodies.ts';
import { PersonBodies } from '../police/person-bodies.ts';
import { PoliceBodies } from '../police/police-bodies.ts';
import type { SimState } from '../simulation.ts';

export class UnitBodies {
  /** The police cars near the player as solids (spec section 14), so a roadblock is a wall. */
  readonly police: PoliceBodies;
  /** The faction enforcers near the player as capsules (spec section 17.2), so they can be shot. */
  readonly enforcers: PersonBodies;
  /** The police officers on foot near the player as capsules (spec section 14), for the same reason. */
  readonly officers: PersonBodies;
  /** The fire engines and ambulances near the player as solids (spec section 20.3), so one at a scene is not driven through. */
  readonly emergency: EmergencyBodies;
  /** Their crews on the street as capsules (spec section 20.3), so they can be shot like anybody else. */
  readonly crew: PersonBodies;

  constructor(world: RAPIER.World) {
    this.police = new PoliceBodies(world);
    this.enforcers = new PersonBodies(world, (state) => state.enforcers.units);
    this.officers = new PersonBodies(world, (state) => state.police.officers);
    this.emergency = new EmergencyBodies(world);
    this.crew = new PersonBodies(world, (state) => state.emergency.crew);
  }

  /**
   * Give everybody near the player a body and take it from everybody who has
   * left the box or been put down. Called once the record says where the tick
   * left them, so a body stands where its unit ended it.
   */
  settle(state: SimState): void {
    const p = state.player;
    const x = p.driving ? state.vehicle.x : p.x;
    const y = p.driving ? state.vehicle.z : p.y;
    const cx = Math.floor(x / PHYSICS_TILE);
    const cy = Math.floor(y / PHYSICS_TILE);
    const minX = (cx - PHYSICS_RADIUS) * PHYSICS_TILE;
    const minY = (cy - PHYSICS_RADIUS) * PHYSICS_TILE;
    const maxX = (cx + PHYSICS_RADIUS + 1) * PHYSICS_TILE;
    const maxY = (cy + PHYSICS_RADIUS + 1) * PHYSICS_TILE;
    this.police.settle(state, minX, minY, maxX, maxY);
    this.enforcers.settle(state, minX, minY, maxX, maxY);
    this.officers.settle(state, minX, minY, maxX, maxY);
    this.emergency.settle(state, minX, minY, maxX, maxY);
    this.crew.settle(state, minX, minY, maxX, maxY);
  }

  /** Take every body out of the world. */
  clear(): void {
    this.police.clear();
    this.enforcers.clear();
    this.officers.clear();
    this.emergency.clear();
    this.crew.clear();
  }
}

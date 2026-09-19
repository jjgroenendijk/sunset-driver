/**
 * The trams near the player, as Rapier bodies (spec section 13.2).
 *
 * Each car of a tram inside the box of ground the physics holds is a kinematic
 * box moved along the loop one tick at a time. The player's car hits it as a
 * solid and cannot push it off its track, and nothing the player does takes a
 * tram off its loop. Outside the box a car has no body. The tram is a function
 * of the tick, so a car that comes into the box is simply put where the tick
 * says it is.
 */
import { cos, sin } from '../core/libm.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import type { AmbientPose } from './traffic.ts';
import { CAR_HALF_HEIGHT, CAR_HALF_WIDTH, CAR_LENGTH, TRAM_CARS, type TramLine } from './tram.ts';

export class TramBodies {
  private readonly world: RAPIER.World;
  private readonly line: TramLine;
  /** One entry per car of every tram, in tram order then car order; undefined while out of the box. */
  private readonly bodies: (RAPIER.RigidBody | undefined)[];
  private readonly pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  private readonly spot = { x: 0, y: 0, z: 0 };
  private readonly turn = { x: 0, y: 0, z: 0, w: 1 };

  constructor(world: RAPIER.World, line: TramLine) {
    this.world = world;
    this.line = line;
    this.bodies = new Array<RAPIER.RigidBody | undefined>(line.trams * TRAM_CARS).fill(undefined);
  }

  /** How many cars stand in the world as bodies. */
  get count(): number {
    let count = 0;
    for (const body of this.bodies) if (body !== undefined) count++;
    return count;
  }

  /**
   * Before the world is stepped from `tick`: give a body to each car in the box,
   * take it from each car that has left, and aim every body at the next tick.
   */
  lead(tick: number, minX: number, minY: number, maxX: number, maxY: number): void {
    for (let tram = 0; tram < this.line.trams; tram++) {
      for (let car = 0; car < TRAM_CARS; car++) {
        const index = tram * TRAM_CARS + car;
        let body = this.bodies[index];
        const next = this.line.carPose(tram, car, tick + 1, this.pose);
        if (next.x < minX || next.x >= maxX || next.y < minY || next.y >= maxY) {
          if (body !== undefined) this.world.removeRigidBody(body);
          this.bodies[index] = undefined;
          continue;
        }
        if (body === undefined) {
          this.place(this.line.carPose(tram, car, tick, this.pose));
          body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.spot.x, this.spot.y, this.spot.z).setRotation(this.turn));
          this.world.createCollider(RAPIER.ColliderDesc.cuboid(CAR_LENGTH / 2, CAR_HALF_HEIGHT, CAR_HALF_WIDTH), body);
          this.bodies[index] = body;
          this.line.carPose(tram, car, tick + 1, this.pose);
        }
        this.place(this.pose);
        body.setNextKinematicTranslation(this.spot);
        body.setNextKinematicRotation(this.turn);
      }
    }
  }

  /** The middle of a car's body and its turn, for a pose on the track. */
  private place(pose: AmbientPose): void {
    this.spot.x = pose.x;
    this.spot.y = pose.height + CAR_HALF_HEIGHT;
    this.spot.z = pose.y;
    // A yaw of minus the heading points local +x along the map heading.
    this.turn.x = 0;
    this.turn.y = sin(-pose.heading / 2);
    this.turn.z = 0;
    this.turn.w = cos(-pose.heading / 2);
  }
}

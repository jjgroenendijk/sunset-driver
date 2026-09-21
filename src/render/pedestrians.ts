/**
 * The crowd, drawn (spec sections 9.2, 13.1).
 *
 * Every person in view is one instance of one mesh, so the whole crowd costs
 * one draw, and one more for each shadow pass. The body and its walk cycles
 * are `pedestrian-rig.ts`; the shader that moves the body is
 * `pedestrian-material.ts`. Each frame writes, per person, where they stand,
 * which gait they move in, how far through its cycle, how tall they are and
 * their four colours, and uploads only the instances it wrote.
 *
 * The crowd is evaluated where the frame stands in time, between two ticks,
 * as the traffic is. A person who has left their loop is drawn from their
 * record in `SimState.pedestrians` instead. The people waiting at the tram
 * stops (spec section 13.2) and at the bus stops (20.2) are drawn in the same
 * mesh, standing.
 */
import { DataTexture, FloatType, Group, Mesh, NearestFilter, RGBAFormat } from 'three';
import { GAITS, STRIDE_HEIGHT } from '../sim/pedestrian-look.ts';
import { heldTime } from '../sim/hold.ts';
import { casualtyOf, startledOf, startledPose, walkingPose, type AmbientPedestrians, type PedestrianPose } from '../sim/pedestrians.ts';
import type { SimState } from '../sim/simulation.ts';
import type { WaitingCrowd, WaitingPassenger } from '../sim/stop-queue.ts';
import type { PedestrianLook } from '../sim/pedestrian-look.ts';
import { outInThis } from '../sim/weather.ts';
import { CrowdInstances } from './crowd-instances.ts';
import { createPedestrianMaterial } from './pedestrian-material.ts';
import { bakeWalks, BONES, FRAMES } from './pedestrian-rig.ts';

/** Metres each way of the point the frame is drawn round that people are drawn in. */
export const PEDESTRIAN_VIEW = 110;

/** People drawn at most. A frame with more leaves the rest out. */
export const PEDESTRIAN_CAP = 1024;

/** A person the frame is told to stand somewhere, rather than one of the crowd. */
export interface StandingPerson {
  pose: PedestrianPose;
  look: PedestrianLook;
  /** What uniform they wear (`uniform.ts`), or nothing for anybody but the police. */
  uniform?: number;
}

export class PedestrianView {
  readonly group = new Group();
  /**
   * People somebody else owns, drawn in this mesh with everyone: the dealers of
   * spec section 16.2, standing on their corners. Whoever owns them writes the
   * list, and they cost no draw of their own.
   */
  standing: readonly StandingPerson[] = [];
  /**
   * The share of the crowd that is out (spec section 13.4). 1 on a clear day;
   * a storm keeps the rest of it indoors. The people waiting at a stop and
   * anyone the player has startled are drawn whatever the sky is doing.
   */
  share = 1;
  private readonly crowd: AmbientPedestrians;
  /** The stops whose queues are drawn with the crowd: the tram's and the buses'. */
  private readonly queues: readonly WaitingCrowd[];
  private readonly waiting: WaitingPassenger[] = [];
  private readonly mesh: Mesh;
  private readonly body = new CrowdInstances(PEDESTRIAN_CAP);
  private readonly bones: DataTexture;
  private readonly ids: number[] = [];
  private readonly pose: PedestrianPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' };

  constructor(crowd: AmbientPedestrians, ...queues: (WaitingCrowd | undefined)[]) {
    this.crowd = crowd;
    this.queues = queues.filter((queue): queue is WaitingCrowd => queue !== undefined);
    this.bones = new DataTexture(bakeWalks(), BONES.length * 4, GAITS.length * FRAMES, RGBAFormat, FloatType);
    this.bones.minFilter = NearestFilter;
    this.bones.magFilter = NearestFilter;
    this.bones.generateMipmaps = false;
    this.bones.needsUpdate = true;

    this.mesh = new Mesh(this.body.geometry, createPedestrianMaterial(this.bones));
    // The instances are spread over the view; the body's own bounds say nothing about them.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.group.add(this.mesh);
  }

  /** How many people the last frame drew. */
  get drawn(): number {
    return this.body.geometry.instanceCount;
  }

  /**
   * Draw the crowd round a place as it stands at a moment, which may fall
   * between two ticks. Called once a frame.
   */
  update(state: SimState, time: number, x: number, y: number): void {
    const crowd = this.crowd;
    const minX = x - PEDESTRIAN_VIEW;
    const minY = y - PEDESTRIAN_VIEW;
    const maxX = x + PEDESTRIAN_VIEW;
    const maxY = y + PEDESTRIAN_VIEW;
    const startled = state.pedestrians.startled;
    const hurt = state.pedestrians.casualties;
    let count = 0;
    for (const id of crowd.near(minX, minY, maxX, maxY, this.ids)) {
      if (count >= PEDESTRIAN_CAP) break;
      if (!crowd.edgeMeets(crowd.edgeAt(id, heldTime(state.pedestrians.held, id, time)), minX, minY, maxX, maxY)) continue;
      if (startled.length > 0 && startledOf(state.pedestrians, id) !== undefined) continue;
      // Somebody who has been hit is drawn by `casualties.ts`, lying or limping.
      if (hurt.length > 0 && casualtyOf(state.pedestrians, id) !== undefined) continue;
      if (!outInThis(id, this.share)) continue;
      const pose = walkingPose(crowd, state.pedestrians, id, time, this.pose);
      if (pose.x < minX || pose.x > maxX || pose.y < minY || pose.y > maxY) continue;
      this.write(count++, this.lookOf(id), pose);
    }
    for (const record of startled) {
      if (count >= PEDESTRIAN_CAP) break;
      const pose = startledPose(record, time, this.pose);
      if (pose.x < minX || pose.x > maxX || pose.y < minY || pose.y > maxY) continue;
      this.write(count++, this.lookOf(record.id), pose);
    }
    for (const queue of this.queues) {
      const waiting = queue.passengers(minX, minY, maxX, maxY, time, this.waiting);
      for (let i = 0; i < waiting && count < PEDESTRIAN_CAP; i++) {
        const passenger = this.waiting[i] as WaitingPassenger;
        this.write(count++, passenger.look, passenger.pose);
      }
    }
    for (const person of this.standing) {
      if (count >= PEDESTRIAN_CAP) break;
      const pose = person.pose;
      if (pose.x < minX || pose.x > maxX || pose.y < minY || pose.y > maxY) continue;
      this.write(count++, person.look, pose, person.uniform ?? 0);
    }
    this.body.commit(count);
    this.mesh.visible = count > 0;
  }

  dispose(): void {
    this.body.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
    this.bones.dispose();
    this.group.clear();
  }

  private lookOf(id: number): PedestrianLook {
    return (this.crowd.people[id] as AmbientPedestrians['people'][number]).look;
  }

  /** Write one person into instance `index`. */
  private write(index: number, look: PedestrianLook, pose: PedestrianPose, uniform = 0): void {
    this.body.place.setXYZW(index, pose.x, pose.height, pose.y, pose.heading);
    this.body.motion.setXYZW(index, GAITS.indexOf(pose.gait) * FRAMES, pose.cycle, look.height / STRIDE_HEIGHT, uniform);
    this.body.paint(index, look);
  }
}

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
 *
 * Some of what a person does is decided here, since it changes nothing the
 * simulation measures. The hour thins the crowd of each zone as the weather
 * does (`crowd-hours.ts`). Rain puts up the umbrellas of those who carry one
 * and hunches the rest. Two people walking at each other step aside to pass
 * (`crowd-pass.ts`), and heads turn to a car driven fast past them.
 */
import { DataTexture, FloatType, Group, Mesh, NearestFilter, RGBAFormat } from 'three';
import { crowdAtHour } from '../sim/crowd-hours.ts';
import { GAIT_NEIGHBOUR, GAITS, STRIDE_HEIGHT, type Gait } from '../sim/pedestrian-look.ts';
import { heldTime } from '../sim/hold.ts';
import { casualtyOf, emptyPose, startledOf, startledPose, walkingPose, type AmbientPedestrians, type PedestrianPose } from '../sim/pedestrians.ts';
import type { SimState } from '../sim/simulation.ts';
import type { WaitingCrowd, WaitingPassenger } from '../sim/stop-queue.ts';
import type { PedestrianLook } from '../sim/pedestrian-look.ts';
import { outInThis } from '../sim/weather.ts';
import { CrowdInstances } from './crowd-instances.ts';
import { CrowdPass } from './crowd-pass.ts';
import { createPedestrianMaterial } from './pedestrian-material.ts';
import { bakeWalks, BONES, FRAMES, propOf } from './pedestrian-rig.ts';

/** Metres each way of the point the frame is drawn round that people are drawn in. */
export const PEDESTRIAN_VIEW = 110;

/** People drawn at most. A frame with more leaves the rest out. */
const PEDESTRIAN_CAP = 1024;

/** Metres from a car driven fast that heads turn to it, and the pace in metres per second it takes. */
const WATCH_REACH = 16;
const WATCH_SPEED = 9;

/** Radians the head turns at most from the way the body faces. */
const LOOK_MOST = 1.3;

/** Rain below this falls on nobody's mind; above it, the walkers without an umbrella hunch. */
const RAIN_FELT = 0.08;
const RAIN_HUNCH = 0.25;

/** The gaits rain changes: the ordinary walks. */
const RAIN_WALKS: ReadonlySet<Gait> = new Set<Gait>(['stroll', 'brisk', 'amble']);

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
  /** How hard it is raining, 0 to 1 (spec section 13.4). */
  rain = 0;
  private readonly crowd: AmbientPedestrians;
  /** The stops whose queues are drawn with the crowd: the tram's and the buses'. */
  private readonly queues: readonly WaitingCrowd[];
  private readonly waiting: WaitingPassenger[] = [];
  private readonly mesh: Mesh;
  private readonly body = new CrowdInstances(PEDESTRIAN_CAP);
  private readonly bones: DataTexture;
  private readonly ids: number[] = [];
  private readonly pose: PedestrianPose = emptyPose();
  private readonly pass = new CrowdPass(PEDESTRIAN_CAP);
  /** Where a car driven fast is this frame, which heads turn to; NaN for none. */
  private carX = NaN;
  private carY = NaN;

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
    this.watch(state);
    this.pass.count = 0;
    for (const id of crowd.near(minX, minY, maxX, maxY, this.ids)) {
      if (count >= PEDESTRIAN_CAP) break;
      if (!crowd.edgeMeets(crowd.edgeAt(id, heldTime(state.pedestrians.held, id, time)), minX, minY, maxX, maxY)) continue;
      if (startled.length > 0 && startledOf(state.pedestrians, id) !== undefined) continue;
      // Somebody who has been hit is drawn by `casualties.ts`, lying or limping.
      if (hurt.length > 0 && casualtyOf(state.pedestrians, id) !== undefined) continue;
      const person = crowd.people[id] as AmbientPedestrians['people'][number];
      if (!outInThis(id, this.share * crowdAtHour(person.zone, time))) continue;
      const pose = walkingPose(crowd, state.pedestrians, id, time, this.pose);
      if (pose.hidden === true) continue;
      if (pose.x < minX || pose.x > maxX || pose.y < minY || pose.y > maxY) continue;
      this.turnHead(pose);
      if (pose.speed > 0.3) this.pass.add(pose.x, pose.y, pose.heading, count);
      this.write(count++, person.look, pose);
    }
    this.stepAside();
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

  /** Where a car driven fast is, so heads turn to it; none on foot or at a crawl. */
  private watch(state: SimState): void {
    const v = state.vehicle;
    const fast = state.player.driving && Math.hypot(v.vx, v.vz) >= WATCH_SPEED;
    this.carX = fast ? v.x : NaN;
    this.carY = fast ? v.z : NaN;
  }

  /** Turn a head to a car driven fast nearby, more the nearer it is, and never past the shoulder. */
  private turnHead(pose: PedestrianPose): void {
    if (Number.isNaN(this.carX)) return;
    const dx = this.carX - pose.x;
    const dy = this.carY - pose.y;
    const gap = Math.hypot(dx, dy);
    if (gap >= WATCH_REACH) return;
    let want = Math.atan2(dy, dx) - pose.heading;
    want -= 2 * Math.PI * Math.round(want / (2 * Math.PI));
    want = Math.max(-LOOK_MOST, Math.min(LOOK_MOST, want));
    const pull = Math.min(1, 1.5 * (1 - gap / WATCH_REACH));
    pose.look = (pose.look ?? 0) * (1 - pull) + want * pull;
  }

  /** Move each walker the step aside `crowd-pass.ts` gives them, to their right. */
  private stepAside(): void {
    const pass = this.pass;
    if (pass.count < 2) return;
    pass.solve();
    const place = this.body.place;
    for (let i = 0; i < pass.count; i++) {
      const step = pass.step[i] as number;
      if (step === 0) continue;
      const index = pass.index[i] as number;
      const heading = pass.heading[i] as number;
      place.setX(index, place.getX(index) - Math.sin(heading) * step);
      place.setZ(index, place.getZ(index) + Math.cos(heading) * step);
    }
  }

  /** The gait the weather makes of a walk: an umbrella up, or hunched against the rain. */
  private weathered(gait: Gait, look: PedestrianLook): Gait {
    if (this.rain < RAIN_FELT || !RAIN_WALKS.has(gait)) return gait;
    if (look.umbrella !== undefined && look.umbrella < 1.5 * this.rain) return 'umbrella';
    return this.rain >= RAIN_HUNCH ? 'hunch' : gait;
  }

  /**
   * Write one person into instance `index`: their place, their gait and the
   * one they are leaving, the turn of their head, their stoop and their prop.
   * Somebody not changing gait blends a little towards its neighbour, as
   * their own way of walking it.
   */
  private write(index: number, look: PedestrianLook, pose: PedestrianPose, uniform = 0): void {
    const gait = this.weathered(pose.gait, look);
    let from = this.weathered(pose.from ?? gait, look);
    let fromCycle = pose.fromCycle ?? pose.cycle;
    let weight = pose.blend ?? 0;
    const neighbour = GAIT_NEIGHBOUR[gait];
    if (weight === 0 && neighbour !== undefined && look.blend !== undefined) {
      from = neighbour;
      fromCycle = pose.cycle;
      weight = look.blend;
    }
    this.body.place.setXYZW(index, pose.x, pose.height, pose.y, pose.heading);
    this.body.motion.setXYZW(index, GAITS.indexOf(gait) * FRAMES, pose.cycle, look.height / STRIDE_HEIGHT, uniform);
    this.body.blend.setXYZW(index, GAITS.indexOf(from) * FRAMES, fromCycle, weight, pose.look ?? 0);
    this.body.style.setXYZW(index, look.lean ?? 0, propOf(gait), 0, 0);
    this.body.paint(index, look);
  }
}

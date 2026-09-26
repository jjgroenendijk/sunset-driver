/**
 * What stands on the roof of a vehicle at work (spec section 20.2,
 * `sim/traffic/jobs.ts`): the sign of a taxi, lit while it is free and dark
 * while it carries a fare, and the amber beacon of a garbage truck and a
 * street sweeper, which flashes.
 *
 * Every top is the same unit box, stretched and lifted by its instance matrix
 * onto the roof of the class it stands on, with its colour on the instance. The
 * material is unlit, so a lit sign reads as lit by day and by night, and the
 * whole lot is one draw. The delivery van has nothing on its roof: its hazards
 * are the indicators of `traffic.ts`.
 *
 * A garbage truck is a truck, and a truck of the roster carries an open deck.
 * The bin body that makes it a garbage truck stands on that deck, as a second
 * instanced box in a lit material and the job's livery: one more draw.
 */
import { BoxGeometry, Color, Group, InstancedMesh, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { blinkLit } from '../../sim/traffic/indicator.ts';
import { fareOf, hiredAt, JOB_PAINT, type Job } from '../../sim/traffic/jobs.ts';
import type { AmbientTraffic, TrafficCursor } from '../../sim/traffic/traffic.ts';
import type { VehicleSpec } from '../../sim/vehicles/vehicle.ts';
import { tinted } from '../look/tint.ts';

/** Tops drawn at most. */
const TOP_CAP = 128;

/** The taxi sign, free and hired; the beacon, lit and dark. */
const SIGN_FREE = 0xfff1a8;
const SIGN_HIRED = 0x4a4632;
const BEACON_LIT = 0xffa020;
const BEACON_DARK = 0x5c3a12;

/** The taxi sign's size in metres: along the car, up and across. */
const SIGN = { length: 0.3, height: 0.2, width: 0.8 };

/** The beacon's size in metres. */
const BEACON = 0.28;

/**
 * Where along the vehicle the beacon stands, as a share of its half length:
 * over the cab of a truck, and back from the windscreen of anything else.
 */
const BEACON_AT = { truck: 0.78, other: 0.35 };

/**
 * The bin body on a truck's deck, as shares of the truck: its ends along the
 * half length, its bottom and top up the height from the floor, and its width.
 * The deck runs from -1 to 0.52 and stands 0.38 up (`vehicle-mesh.ts`).
 */
const BIN_BODY = { back: -1, front: 0.52, bottom: 0.38, top: 0.96, width: 0.96 };

/** The fare of each taxi's tour, read once, or null for one with none. */
type Fare = { from: number; to: number } | null;

export class JobTops {
  /** The two meshes below, added to the scene as one. */
  readonly group = new Group();
  readonly mesh: InstancedMesh;
  /** The bin bodies of the garbage trucks. */
  readonly bodies: InstancedMesh;
  private readonly traffic: AmbientTraffic;
  private readonly fares: (Fare | undefined)[];
  private readonly cursor: TrafficCursor = { id: 0, step: 0, into: 0 };
  private readonly local = new Matrix4();
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly size = new Vector3();
  private readonly still = new Quaternion();
  private readonly colour = new Color();

  constructor(traffic: AmbientTraffic) {
    this.traffic = traffic;
    this.fares = new Array<Fare | undefined>(traffic.vehicles.length);
    // Coloured from the start, or the warm-up compiles a program that draws every sign white.
    this.mesh = tinted(new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), TOP_CAP));
    // The instances are spread over hundreds of metres; the box's own bounds say nothing about them.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.bodies = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: JOB_PAINT.garbage, roughness: 0.6 }), TOP_CAP);
    this.bodies.frustumCulled = false;
    this.bodies.castShadow = true;
    this.bodies.receiveShadow = true;
    this.bodies.count = 0;
    this.group.add(this.mesh, this.bodies);
  }

  begin(): void {
    this.mesh.count = 0;
    this.bodies.count = 0;
    this.group.add(this.mesh, this.bodies);
  }

  /**
   * Put the top of vehicle `id` on its roof, where `body` is the matrix its
   * body is drawn with, at a moment `time` of its tour.
   */
  add(id: number, job: Job, spec: VehicleSpec, body: Matrix4, time: number): void {
    if (job !== 'taxi' && job !== 'garbage' && job !== 'sweeper') return;
    const index = this.mesh.count;
    if (index >= TOP_CAP) return;
    if (job === 'taxi') {
      this.at.set(-spec.halfLength * 0.05, spec.halfHeight + SIGN.height / 2, 0);
      this.size.set(SIGN.length, SIGN.height, Math.min(SIGN.width, spec.halfWidth));
      this.colour.set(this.hired(id, time) ? SIGN_HIRED : SIGN_FREE);
    } else {
      if (job === 'garbage') this.addBody(spec, body);
      this.at.set(spec.halfLength * (spec.cls === 'truck' ? BEACON_AT.truck : BEACON_AT.other), spec.halfHeight + BEACON / 2, 0);
      this.size.set(BEACON, BEACON, BEACON);
      this.colour.set(blinkLit(id, time) ? BEACON_LIT : BEACON_DARK);
    }
    this.local.compose(this.at, this.still, this.size);
    this.mesh.setMatrixAt(index, this.matrix.multiplyMatrices(body, this.local));
    this.mesh.setColorAt(index, this.colour);
    this.mesh.count = index + 1;
  }

  finish(): void {
    for (const mesh of [this.mesh, this.bodies]) {
      mesh.visible = mesh.count > 0;
      if (mesh.count === 0) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of [this.mesh, this.bodies]) {
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial | MeshStandardMaterial).dispose();
      mesh.dispose();
    }
  }

  /** Stand the bin body of a garbage truck on its deck. */
  private addBody(spec: VehicleSpec, body: Matrix4): void {
    const index = this.bodies.count;
    if (index >= TOP_CAP) return;
    const height = spec.halfHeight * 2;
    const along = ((BIN_BODY.front - BIN_BODY.back) / 2) * spec.halfLength;
    const up = (BIN_BODY.top - BIN_BODY.bottom) * height;
    this.at.set(((BIN_BODY.front + BIN_BODY.back) / 2) * spec.halfLength, -spec.halfHeight + ((BIN_BODY.top + BIN_BODY.bottom) / 2) * height, 0);
    this.size.set(along * 2, up, spec.halfWidth * 2 * BIN_BODY.width);
    this.local.compose(this.at, this.still, this.size);
    this.bodies.setMatrixAt(index, this.matrix.multiplyMatrices(body, this.local));
    this.bodies.count = index + 1;
  }

  /** True while taxi `id` carries its fare at a moment of its tour. */
  private hired(id: number, time: number): boolean {
    const traffic = this.traffic;
    const tour = (traffic.vehicles[id] as AmbientTraffic['vehicles'][number]).tour;
    let fare = this.fares[id];
    if (fare === undefined) {
      fare = fareOf(tour) ?? null;
      this.fares[id] = fare;
    }
    if (fare === null) return false;
    const cursor = traffic.cursorAt(id, Math.floor(time), this.cursor);
    const along = (tour.startDistance[tour.stepLeg[cursor.step] as number] as number) + traffic.metresOf(cursor);
    return hiredAt(fare, along, traffic.isWait(cursor));
  }
}

/**
 * The parked cars, drawn (spec sections 9.2, 13.1).
 *
 * Like the traffic, every class is two instanced meshes — the paint and the
 * trim — so the parked cars in view cost two draws per class on screen. A
 * parked car stands still for almost all of its stay, so the instances are
 * written again only when something changed: the point the frame is drawn
 * round has moved far enough to bring new bays into view, a stay has turned
 * over, a car has been promoted, or a car in view is pulling in or out of its
 * bay (`sim/traffic/parked-pull.ts`). Between those the frame uploads nothing.
 * A promoted car is drawn by `traffic.ts` from its record.
 */
import { Color, Group, Matrix4, Quaternion, Vector3, type Material } from 'three';
import type { Pool } from '../look/pool.ts';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { EntityFade } from '../camera/fade.ts';
import { PARKED_CLASSES, type ParkedCar, type ParkedCars } from '../../sim/traffic/parked.ts';
import type { ParkedPose } from '../../sim/traffic/parked-pull.ts';
import type { SimState } from '../../sim/simulation.ts';
import { rideHeight, specOf, type VehicleClass } from '../../sim/vehicles/vehicle.ts';
import { glassMaterial, instanced, trafficParts } from './traffic.ts';
import { tinted } from '../look/tint.ts';

/** Metres each way of the point the frame is drawn round that parked cars are drawn in. */
export const PARKED_VIEW = 170;

/** Metres the point the frame is drawn round may move before the view is written again. */
const MOVE = 10;

/**
 * The most ticks between two full writes of the bays, whatever else says. A
 * stay that turns over is written on its own tick already.
 */
const REFRESH = 30;

/** Parked cars of one class drawn at most. A frame with more leaves the rest out. */
const PARKED_CAP = 1024;

interface ClassMeshes {
  cls: VehicleClass;
  lift: number;
  meshes: Pool[];
}

export class ParkedView {
  readonly group = new Group();
  private readonly cars: ParkedCars;
  private readonly classes: ClassMeshes[] = [];
  private readonly materials: Material[] = [];
  private readonly ids: number[] = [];
  private readonly car: ParkedCar = { cls: 'saloon', paint: 0, since: 0 };
  private readonly pose: ParkedPose = { x: 0, y: 0, heading: 0, moving: false };
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);
  private readonly colour = new Color();
  /** Where and when the instances were last written, and how many records were promoted then. */
  private lastX = NaN;
  private lastY = NaN;
  private lastTick = -Infinity;
  private lastPromoted = -1;
  /** The first tick a stay of a bay in view turns over, when the whole view is written again. */
  private nextTurn = Infinity;
  /** The first tick a car in view moves on its way in or out, when only the moving cars are written. */
  private nextMove = Infinity;
  /** The cars in view that pull in or out before their stay ends, and the instance each is. */
  private readonly moving: { bay: number; entry: ClassMeshes; index: number }[] = [];
  /**
   * The dither fade of spec section 9.2, so a parked car thins in at the edge
   * of the view rather than pops. It ends {@link MOVE} short of
   * {@link PARKED_VIEW}: the cars are written round where the view last moved,
   * which may be that far behind, and a car inside the fade must be written.
   */
  private readonly fade = new EntityFade(PARKED_VIEW - MOVE);

  constructor(cars: ParkedCars) {
    this.cars = cars;
    const paint = new MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0.2 });
    const trim = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1 });
    const glass = glassMaterial();
    this.materials.push(paint, trim, glass);
    for (const material of [paint, trim, glass]) this.fade.mask(material);
    for (const cls of PARKED_CLASSES) {
      const spec = specOf(cls);
      const parts = trafficParts(spec);
      const meshes = [
        tinted(instanced(parts.paint, paint, true, PARKED_CAP)),
        instanced(parts.trim, trim, false, PARKED_CAP),
        instanced(parts.glass, glass, false, PARKED_CAP),
      ];
      this.classes.push({ cls, lift: rideHeight(spec), meshes });
      this.group.add(...meshes);
    }
  }

  /** How many parked cars the view holds. */
  get drawn(): number {
    let count = 0;
    for (const entry of this.classes) count += (entry.meshes[0] as Pool).count;
    return count;
  }

  /** Forget what was last written, so the next update writes whatever the place and tick. */
  refresh(): void {
    this.lastTick = -Infinity;
  }

  /** Draw the parked cars round a place at a tick. Called once a frame; writes only when something changed. */
  update(state: SimState, x: number, y: number): void {
    this.fade.focus(x, y);
    const tick = state.tick;
    const moved = !(Math.abs(x - this.lastX) < MOVE && Math.abs(y - this.lastY) < MOVE);
    const stale = tick < this.lastTick || tick >= this.lastTick + REFRESH || tick >= this.nextTurn;
    if (moved || stale || state.traffic.promoted.length !== this.lastPromoted) this.write(state, x, y);
    else if (tick >= this.nextMove) this.steer(tick);
  }

  /** Write every car in view again, and note the ones that pull in or out before their stay ends. */
  private write(state: SimState, x: number, y: number): void {
    const tick = state.tick;
    this.lastX = x;
    this.lastY = y;
    this.lastTick = tick;
    this.lastPromoted = state.traffic.promoted.length;
    this.nextTurn = Infinity;
    this.nextMove = Infinity;
    this.moving.length = 0;
    for (const entry of this.classes) for (const mesh of entry.meshes) mesh.count = 0;
    for (const bay of this.cars.near(x - PARKED_VIEW, y - PARKED_VIEW, x + PARKED_VIEW, y + PARKED_VIEW, this.ids)) {
      const end = this.cars.stayEnd(bay, tick);
      this.nextTurn = Math.min(this.nextTurn, end);
      if (!this.cars.carAt(bay, tick, state.traffic, this.car)) continue;
      const entry = this.classes.find((c) => c.cls === this.car.cls) as ClassMeshes;
      const index = this.place(entry, bay, this.cars.poseAt(bay, tick, this.pose));
      const change = this.cars.changeAt(bay, tick);
      if (index < 0 || change >= end) continue;
      this.moving.push({ bay, entry, index });
      this.nextMove = Math.min(this.nextMove, change);
    }
    for (const entry of this.classes) flagUpload(entry);
  }

  /** Move only the cars pulling in or out: the set of cars in view is the same until a stay turns over. */
  private steer(tick: number): void {
    this.nextMove = Infinity;
    for (const car of this.moving) {
      this.put(car.entry, car.index, car.bay, this.cars.poseAt(car.bay, tick, this.pose));
      car.entry.meshes.forEach((mesh) => (mesh.instanceMatrix.needsUpdate = true));
      this.nextMove = Math.min(this.nextMove, this.cars.changeAt(car.bay, tick));
    }
  }

  /** Add the car now in `this.car` as the next instance of its class, standing in `bay` at `pose`. Answers its index, or -1 past the cap. */
  private place(entry: ClassMeshes, bay: number, pose: ParkedPose): number {
    const paint = entry.meshes[0] as Pool;
    const index = paint.count;
    if (index >= PARKED_CAP) return -1;
    this.put(entry, index, bay, pose);
    for (const mesh of entry.meshes) mesh.count = index + 1;
    paint.setColorAt(index, this.colour.set(this.car.paint));
    return index;
  }

  /** Stand instance `index` of a class at `pose` over `bay`. */
  private put(entry: ClassMeshes, index: number, bay: number, pose: ParkedPose): void {
    this.at.set(pose.x, (this.cars.bays.height[bay] as number) + entry.lift, pose.y);
    this.turn.setFromAxisAngle(this.up, -pose.heading);
    this.matrix.compose(this.at, this.turn, this.one);
    for (const mesh of entry.meshes) mesh.setMatrixAt(index, this.matrix);
  }

  dispose(): void {
    for (const entry of this.classes) {
      for (const mesh of entry.meshes) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
    }
    for (const material of this.materials) material.dispose();
    this.group.clear();
  }
}

/** Show a class only when it holds a car, and upload what was written to it. */
function flagUpload(entry: ClassMeshes): void {
  const count = (entry.meshes[0] as Pool).count;
  for (const mesh of entry.meshes) {
    mesh.visible = count > 0;
    if (count > 0) mesh.instanceMatrix.needsUpdate = true;
  }
  const colours = (entry.meshes[0] as Pool).instanceColor;
  if (count > 0) colours.needsUpdate = true;
}

/**
 * The parked cars, drawn (spec sections 9.2, 13.1).
 *
 * Like the traffic, every class is three instanced meshes — the paint, the
 * trim and the outline — so the parked cars in view cost three draws per class
 * on screen. A parked car does not move, so the instances are written again
 * only when something changed: the point the frame is drawn round has moved
 * far enough to bring new bays into view, a stay has turned over, or a car has
 * been promoted. Between those the frame uploads nothing. A promoted car is
 * drawn by `traffic.ts` from its record.
 */
import { BackSide, Color, Group, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Quaternion, Vector3, type InstancedMesh, type Material } from 'three';
import { PARKED_CLASSES, type ParkedCar, type ParkedCars } from '../sim/parked.ts';
import type { SimState } from '../sim/simulation.ts';
import { rideHeight, specOf, type VehicleClass } from '../sim/vehicle.ts';
import { instanced, trafficParts } from './traffic.ts';
import { OUTLINE } from './vehicle.ts';
import { tinted } from './tint.ts';

/** Metres each way of the point the frame is drawn round that parked cars are drawn in. */
export const PARKED_VIEW = 170;

/** Metres the point the frame is drawn round may move before the view is written again. */
const MOVE = 10;

/**
 * Ticks between two readings of the bays. A stay that turns over shows up
 * within this, which is half a second.
 */
const REFRESH = 30;

/** Parked cars of one class drawn at most. A frame with more leaves the rest out. */
export const PARKED_CAP = 1024;

interface ClassMeshes {
  cls: VehicleClass;
  lift: number;
  meshes: InstancedMesh[];
}

export class ParkedView {
  readonly group = new Group();
  private readonly cars: ParkedCars;
  private readonly classes: ClassMeshes[] = [];
  private readonly materials: Material[] = [];
  private readonly ids: number[] = [];
  private readonly car: ParkedCar = { cls: 'saloon', paint: 0, since: 0 };
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

  constructor(cars: ParkedCars) {
    this.cars = cars;
    const paint = new MeshStandardMaterial({ roughness: 0.45, metalness: 0.2 });
    const trim = new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1 });
    const outline = new MeshBasicMaterial({ color: new Color(OUTLINE), side: BackSide, fog: true });
    this.materials.push(paint, trim, outline);
    for (const cls of PARKED_CLASSES) {
      const spec = specOf(cls);
      const parts = trafficParts(spec);
      const meshes = [
        tinted(instanced(parts.paint, paint, true, PARKED_CAP)),
        instanced(parts.trim, trim, false, PARKED_CAP),
        instanced(parts.rim, outline, false, PARKED_CAP),
      ];
      this.classes.push({ cls, lift: rideHeight(spec), meshes });
      this.group.add(...meshes);
    }
  }

  /** How many parked cars the view holds. */
  get drawn(): number {
    let count = 0;
    for (const entry of this.classes) count += (entry.meshes[0] as InstancedMesh).count;
    return count;
  }

  /** Draw the parked cars round a place at a tick. Called once a frame; writes only when something changed. */
  update(state: SimState, x: number, y: number): void {
    const tick = state.tick;
    const moved = !(Math.abs(x - this.lastX) < MOVE && Math.abs(y - this.lastY) < MOVE);
    const stale = tick < this.lastTick || tick >= this.lastTick + REFRESH;
    if (!moved && !stale && state.traffic.promoted.length === this.lastPromoted) return;
    this.lastX = x;
    this.lastY = y;
    this.lastTick = tick;
    this.lastPromoted = state.traffic.promoted.length;

    for (const entry of this.classes) for (const mesh of entry.meshes) mesh.count = 0;
    const bays = this.cars.bays;
    for (const bay of this.cars.near(x - PARKED_VIEW, y - PARKED_VIEW, x + PARKED_VIEW, y + PARKED_VIEW, this.ids)) {
      if (!this.cars.carAt(bay, tick, state.traffic, this.car)) continue;
      const entry = this.classes.find((c) => c.cls === this.car.cls) as ClassMeshes;
      const paint = entry.meshes[0] as InstancedMesh;
      const index = paint.count;
      if (index >= PARKED_CAP) continue;
      this.at.set(bays.x[bay] as number, (bays.height[bay] as number) + entry.lift, bays.y[bay] as number);
      this.turn.setFromAxisAngle(this.up, -(bays.heading[bay] as number));
      this.matrix.compose(this.at, this.turn, this.one);
      for (const mesh of entry.meshes) {
        mesh.setMatrixAt(index, this.matrix);
        mesh.count = index + 1;
      }
      paint.setColorAt(index, this.colour.set(this.car.paint));
    }
    for (const entry of this.classes) {
      const count = (entry.meshes[0] as InstancedMesh).count;
      for (const mesh of entry.meshes) {
        mesh.visible = count > 0;
        if (count > 0) mesh.instanceMatrix.needsUpdate = true;
      }
      const colours = (entry.meshes[0] as InstancedMesh).instanceColor;
      if (count > 0 && colours !== null) colours.needsUpdate = true;
    }
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

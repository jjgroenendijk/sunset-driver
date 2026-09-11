/**
 * The vehicle, drawn (spec sections 10.1, 11.3).
 *
 * The shape comes from `vehicle-mesh.ts`, one plan per class of the roster.
 * This turns that plan into a model: a mesh per box, a wheel per wheel of the
 * row, and the outline of spec section 10.1 round the masses that make the
 * silhouette.
 *
 * The model reads the vehicle's serialisable state and nothing else, so what is
 * drawn is a function of the simulation record: the class decides the shape,
 * the body takes the chassis pose, and each wheel hangs at the length its
 * suspension came back with and turns by the angle the physics steered it to.
 * A class the record changes to — the debug picker of spec section 11.3, or a
 * loaded save — rebuilds the model on the next frame it is set from.
 */
import {
  BackSide,
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  type BufferGeometry,
  type Material,
} from 'three';
import {
  DEFAULT_CLASS,
  specOf,
  type VehicleClass,
  type VehicleSpec,
  type VehicleState,
  type WheelSpec,
  type WheelState,
} from '../sim/vehicle.ts';
import { TYRE, vehicleBoxes, type VehicleBox } from './vehicle-mesh.ts';

/** The dark of the outline, as the buildings' is (spec section 10.1). */
const OUTLINE = 0x150f12;

/**
 * Metres the outline stands outside the box it rims. A vehicle is two metres
 * across and a building fifty, so this is a tenth of the buildings' width: the
 * same line on screen from the same camera.
 */
export const VEHICLE_OUTLINE_WIDTH = 0.035;

/** A wheel of the model, and the wheel of the record it hangs and turns with. */
interface DrawnWheel {
  object: Object3D;
  index: number;
}

export class VehicleModel {
  readonly group = new Group();
  private spec: VehicleSpec;
  private readonly wheels: DrawnWheel[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];

  constructor(cls: VehicleClass = DEFAULT_CLASS) {
    this.spec = specOf(cls);
    this.build();
  }

  /** The row of the roster the model is currently built for. */
  get vehicle(): VehicleSpec {
    return this.spec;
  }

  /**
   * Put the model where the state says the vehicle is. Called once a frame.
   * A record that names another class is a different vehicle, so the model is
   * built again for it before it is placed.
   */
  set(v: VehicleState): void {
    if (v.cls !== this.spec.cls) {
      this.spec = specOf(v.cls);
      this.clear();
      this.build();
    }
    this.group.position.set(v.x, v.y, v.z);
    this.group.quaternion.set(v.qx, v.qy, v.qz, v.qw);
    for (const drawn of this.wheels) {
      const spec = this.spec.wheels[drawn.index] as WheelSpec;
      const state = v.wheels[drawn.index] as WheelState;
      // The suspension hangs the wheel below its mounting point on the chassis.
      // A vehicle the model draws one wheel per axle for hangs it between the
      // pair the physics stands on, which is the centreline.
      drawn.object.position.set(spec.x, spec.y - state.suspension, this.spec.inline ? 0 : spec.z);
      // Steer about the chassis' up axis, then roll on the axle.
      drawn.object.rotation.set(0, state.steer, state.rotation, 'YXZ');
    }
  }

  dispose(): void {
    this.clear();
  }

  /** Take the current model apart and release everything it holds. */
  private clear(): void {
    this.group.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.wheels.length = 0;
  }

  private build(): void {
    const outline = new MeshBasicMaterial({ color: new Color(OUTLINE), side: BackSide, fog: true });
    this.materials.push(outline);
    for (const part of vehicleBoxes(this.spec)) {
      this.add(part);
      // The outline is the same box grown by the width of the line and drawn
      // back faces only, so it rims the mass instead of hiding it.
      if (part.outlined) this.add(grown(part, VEHICLE_OUTLINE_WIDTH), outline);
    }
    this.buildWheels();
  }

  /**
   * One box of the plan, in its own colour or in a material it is handed.
   *
   * An outline casts no shadow. It is the mass it rims grown by a few
   * centimetres, so its shadow is the body's shadow again, drawn twice and a
   * little too big.
   */
  private add(part: VehicleBox, material?: Material): void {
    const geometry = new BoxGeometry(part.length, part.height, part.width);
    const paint = material ?? new MeshStandardMaterial({ color: part.colour, roughness: 0.45, metalness: 0.2 });
    if (material === undefined) this.materials.push(paint);
    const mesh = new Mesh(geometry, paint);
    mesh.position.set(part.x, part.y, part.z);
    mesh.castShadow = material === undefined;
    this.geometries.push(geometry);
    this.group.add(mesh);
  }

  /** A tyre and a hub per wheel of the row, sharing one geometry and one material. */
  private buildWheels(): void {
    const spec = this.spec;
    if (spec.wheels.length === 0) return;
    const tyre = new CylinderGeometry(spec.wheelRadius, spec.wheelRadius, spec.wheelWidth, 14);
    // The cylinder is built along y; the axle runs across the car, along z.
    tyre.rotateX(Math.PI / 2);
    const rubber = new MeshStandardMaterial({ color: TYRE, roughness: 0.9 });
    const hub = new BoxGeometry(spec.wheelRadius * 0.9, spec.wheelRadius * 0.9, spec.wheelWidth * 1.05);
    const chrome = new MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.7 });
    this.geometries.push(tyre, hub);
    this.materials.push(rubber, chrome);
    for (let i = 0; i < spec.wheels.length; i++) {
      const wheel = spec.wheels[i] as WheelSpec;
      // A vehicle that rides on one wheel per axle is drawn with one: the far
      // half of each pair the physics stands on is not there to be seen.
      if (spec.inline && wheel.z < 0) continue;
      const group = new Group();
      group.position.set(wheel.x, wheel.y - spec.suspensionRest, spec.inline ? 0 : wheel.z);
      for (const mesh of [new Mesh(tyre, rubber), new Mesh(hub, chrome)]) {
        // A spoke box on the hub, so a turning wheel is visibly turning.
        mesh.castShadow = true;
        group.add(mesh);
      }
      this.wheels.push({ object: group, index: i });
      this.group.add(group);
    }
  }
}

/** The same box, `reach` metres larger on every side. */
function grown(part: VehicleBox, reach: number): VehicleBox {
  return {
    ...part,
    length: part.length + 2 * reach,
    height: part.height + 2 * reach,
    width: part.width + 2 * reach,
  };
}

/**
 * The car, drawn (spec sections 10.1, 11.3).
 *
 * Boxes, as the character model is: the camera looks down from 60 m, so what a
 * vehicle needs is a silhouette that reads at a glance and a nose that says
 * which way it is pointing. The handling roster of spec section 11.3 will make
 * this a shape per class; until then it is one saloon.
 *
 * The model reads the vehicle's serialisable state and nothing else, so what is
 * drawn is a function of the simulation record: the body takes the chassis
 * pose, and each wheel hangs at the length its suspension came back with and
 * turns by the angle the physics steered it to.
 */
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  type BufferGeometry,
  type Material,
} from 'three';
import { SALOON, type VehicleSpec, type VehicleState, type WheelSpec, type WheelState } from '../sim/vehicle.ts';

/** Body paint until the roster of spec section 11.3 picks a colour per vehicle. */
const PAINT = 0xb8352c;
const GLASS = 0x243040;
const TYRE = 0x161616;
const LAMP = 0xffe7b0;
const TAIL = 0x6e1210;

export class VehicleModel {
  readonly group = new Group();
  private readonly spec: VehicleSpec;
  private readonly wheels: Object3D[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];

  constructor(spec: VehicleSpec = SALOON) {
    this.spec = spec;
    this.build();
    this.group.traverse((object) => {
      object.castShadow = true;
    });
  }

  /** Put the model where the state says the vehicle is. Called once a frame. */
  set(v: VehicleState): void {
    this.group.position.set(v.x, v.y, v.z);
    this.group.quaternion.set(v.qx, v.qy, v.qz, v.qw);
    for (let i = 0; i < this.wheels.length; i++) {
      const wheel = this.wheels[i] as Object3D;
      const spec = this.spec.wheels[i] as WheelSpec;
      const state = v.wheels[i] as WheelState;
      // The suspension hangs the wheel below its mounting point on the chassis.
      wheel.position.set(spec.x, spec.y - state.suspension, spec.z);
      // Steer about the chassis' up axis, then roll on the axle.
      wheel.rotation.set(0, state.steer, state.rotation, 'YXZ');
    }
  }

  dispose(): void {
    this.group.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.wheels.length = 0;
  }

  private box(w: number, h: number, d: number, colour: number, x: number, y: number, z: number): Mesh {
    const geometry = new BoxGeometry(w, h, d);
    const material = new MeshStandardMaterial({ color: colour, roughness: 0.45, metalness: 0.2 });
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    this.geometries.push(geometry);
    this.materials.push(material);
    this.group.add(mesh);
    return mesh;
  }

  private build(): void {
    const spec = this.spec;
    const length = spec.halfLength * 2;
    const width = spec.halfWidth * 2;
    const height = spec.halfHeight * 2;

    // The lower body, narrower than the track so the wheels show from above.
    const bodyHeight = height * 0.55;
    const bodyY = -spec.halfHeight + bodyHeight / 2;
    this.box(length, bodyHeight, width * 0.9, PAINT, 0, bodyY, 0);

    // The cabin, set back from the nose: a bonnet at one end and a boot at the
    // other is what tells a player which way the car is facing from 60 m up.
    const cabinHeight = height - bodyHeight;
    const cabinY = bodyY + bodyHeight / 2 + cabinHeight / 2;
    const cabinLength = length * 0.44;
    const cabinX = -length * 0.05;
    this.box(cabinLength, cabinHeight, width * 0.8, PAINT, cabinX, cabinY, 0);
    // Glass at each end of the cabin and down both sides, a little proud of it,
    // so the windows read as windows rather than as paint.
    this.box(length * 0.06, cabinHeight * 0.82, width * 0.82, GLASS, cabinX + cabinLength / 2, cabinY, 0);
    this.box(length * 0.05, cabinHeight * 0.82, width * 0.82, GLASS, cabinX - cabinLength / 2, cabinY, 0);
    this.box(cabinLength * 0.7, cabinHeight * 0.5, width * 0.83, GLASS, cabinX, cabinY + cabinHeight * 0.08, 0);

    // Lights at each end, so the nose is the end that is lit.
    for (const side of [1, -1]) {
      this.box(0.1, 0.14, width * 0.22, LAMP, spec.halfLength - 0.04, bodyY + bodyHeight * 0.2, side * width * 0.28);
      this.box(0.09, 0.14, width * 0.22, TAIL, -spec.halfLength + 0.04, bodyY + bodyHeight * 0.2, side * width * 0.28);
    }

    const tyre = new CylinderGeometry(spec.wheelRadius, spec.wheelRadius, spec.wheelWidth, 14);
    // The cylinder is built along y; the axle runs across the car, along z.
    tyre.rotateX(Math.PI / 2);
    const rubber = new MeshStandardMaterial({ color: TYRE, roughness: 0.9 });
    const hub = new BoxGeometry(spec.wheelRadius * 0.9, spec.wheelRadius * 0.9, spec.wheelWidth * 1.05);
    const chrome = new MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.7 });
    this.geometries.push(tyre, hub);
    this.materials.push(rubber, chrome);
    for (const wheel of spec.wheels) {
      const group = new Group();
      group.position.set(wheel.x, wheel.y - spec.suspensionRest, wheel.z);
      group.add(new Mesh(tyre, rubber));
      // A spoke box on the hub, so a turning wheel is visibly turning.
      group.add(new Mesh(hub, chrome));
      this.wheels.push(group);
      this.group.add(group);
    }
  }
}

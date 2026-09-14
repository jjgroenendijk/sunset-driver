/**
 * The traffic, drawn (spec sections 9.2, 13.1).
 *
 * Every class of the traffic is three instanced meshes: the painted boxes, the
 * glass, lamps and tyres, and the outline of spec section 10.1 round the
 * masses. Each vehicle is one instance of each, so the whole traffic in view
 * costs three draws per class that is on screen, however many cars there are.
 * The paint is the instance's colour, which is how two saloons in one mesh
 * come in two colours.
 *
 * The traffic is evaluated where the frame stands in time, between two ticks,
 * the way `smooth.ts` draws the player. A vehicle the player has touched is
 * drawn from its record instead, since it no longer drives its tour.
 */
import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SimState } from '../sim/simulation.ts';
import { AMBIENT_CLASSES, promotedOf, type AmbientPose, type AmbientTraffic } from '../sim/traffic.ts';
import { rideHeight, specOf, type VehicleClass, type VehicleSpec } from '../sim/vehicle.ts';
import { OUTLINE, VEHICLE_OUTLINE_WIDTH } from './vehicle.ts';
import { TYRE, vehicleBoxes, type VehicleBox } from './vehicle-mesh.ts';

/** Metres each way of the point the frame is drawn round that traffic is drawn in. */
export const TRAFFIC_VIEW = 180;

/** Vehicles of one class drawn at most. A frame with more leaves the rest out. */
export const CLASS_CAP = 256;

/** The three meshes one class is drawn with. */
interface ClassMeshes {
  cls: VehicleClass;
  spec: VehicleSpec;
  paint: InstancedMesh;
  trim: InstancedMesh;
  rim: InstancedMesh;
}

/** The geometry of one class, split by how each part is coloured. */
export interface TrafficParts {
  /** The boxes in the row's paint, which the instance colour replaces. */
  paint: BufferGeometry;
  /** Everything in a colour of its own, carried per vertex. */
  trim: BufferGeometry;
  /** The masses, grown by the width of the outline. */
  rim: BufferGeometry;
}

/** Build the geometry one class of the traffic is drawn with. Headless: no renderer is needed. */
export function trafficParts(spec: VehicleSpec): TrafficParts {
  const paint: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  const rim: BufferGeometry[] = [];
  for (const part of vehicleBoxes(spec)) {
    if (part.colour === spec.paint) paint.push(boxOf(part, 0));
    else trim.push(coloured(boxOf(part, 0), part.colour));
    if (part.outlined) rim.push(boxOf(part, VEHICLE_OUTLINE_WIDTH));
  }
  for (const wheel of spec.wheels) {
    if (spec.inline && wheel.z < 0) continue;
    const tyre = new CylinderGeometry(spec.wheelRadius, spec.wheelRadius, spec.wheelWidth, 10);
    tyre.rotateX(Math.PI / 2);
    tyre.translate(wheel.x, wheel.y - spec.suspensionRest, spec.inline ? 0 : wheel.z);
    trim.push(coloured(tyre.toNonIndexed(), TYRE));
    tyre.dispose();
  }
  return { paint: merged(paint), trim: merged(trim), rim: merged(rim) };
}

export class TrafficView {
  readonly group = new Group();
  private readonly traffic: AmbientTraffic;
  private readonly classes: ClassMeshes[] = [];
  private readonly materials: Material[] = [];
  private readonly ids: number[] = [];
  private readonly pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);
  private readonly colour = new Color();

  constructor(traffic: AmbientTraffic) {
    this.traffic = traffic;
    const paint = new MeshStandardMaterial({ roughness: 0.45, metalness: 0.2 });
    const trim = new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1 });
    const outline = new MeshBasicMaterial({ color: new Color(OUTLINE), side: BackSide, fog: true });
    this.materials.push(paint, trim, outline);
    for (const cls of AMBIENT_CLASSES) {
      const spec = specOf(cls);
      const parts = trafficParts(spec);
      const meshes: ClassMeshes = {
        cls,
        spec,
        paint: instanced(parts.paint, paint, true),
        trim: instanced(parts.trim, trim, false),
        rim: instanced(parts.rim, outline, false),
      };
      this.classes.push(meshes);
      this.group.add(meshes.paint, meshes.trim, meshes.rim);
    }
  }

  /** How many vehicles the last frame drew, promoted ones included. */
  get drawn(): number {
    let count = 0;
    for (const meshes of this.classes) count += meshes.paint.count;
    return count;
  }

  /**
   * Draw the traffic round a place as it stands at a moment, which may fall
   * between two ticks. Called once a frame.
   */
  update(state: SimState, time: number, x: number, y: number): void {
    for (const meshes of this.classes) meshes.paint.count = 0;
    const traffic = this.traffic;
    const minX = x - TRAFFIC_VIEW;
    const minY = y - TRAFFIC_VIEW;
    const maxX = x + TRAFFIC_VIEW;
    const maxY = y + TRAFFIC_VIEW;
    for (const id of traffic.near(minX, minY, maxX, maxY, this.ids)) {
      if (promotedOf(state.traffic, id) !== undefined) continue;
      const pose = traffic.poseAt(id, time, this.pose);
      if (pose.x < minX || pose.x > maxX || pose.y < minY || pose.y > maxY) continue;
      const vehicle = traffic.vehicles[id] as AmbientTraffic['vehicles'][number];
      const meshes = this.meshesOf(vehicle.cls);
      this.at.set(pose.x, pose.height + rideHeight(meshes.spec), pose.y);
      this.turn.setFromAxisAngle(this.up, -pose.heading);
      this.add(meshes, vehicle.paint);
    }
    for (const record of state.traffic.promoted) {
      const v = record.vehicle;
      if (v.x < minX || v.x > maxX || v.z < minY || v.z > maxY) continue;
      const meshes = this.meshesOf(v.cls);
      this.at.set(v.x, v.y, v.z);
      this.turn.set(v.qx, v.qy, v.qz, v.qw);
      this.add(meshes, (traffic.vehicles[record.id] as AmbientTraffic['vehicles'][number]).paint);
    }
    for (const meshes of this.classes) {
      const count = meshes.paint.count;
      meshes.trim.count = count;
      meshes.rim.count = count;
      for (const mesh of [meshes.paint, meshes.trim, meshes.rim]) {
        mesh.visible = count > 0;
        if (count === 0) continue;
        mesh.instanceMatrix.needsUpdate = true;
      }
      if (count > 0 && meshes.paint.instanceColor !== null) meshes.paint.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const meshes of this.classes) {
      for (const mesh of [meshes.paint, meshes.trim, meshes.rim]) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
    }
    for (const material of this.materials) material.dispose();
    this.group.clear();
  }

  private meshesOf(cls: VehicleClass): ClassMeshes {
    return this.classes.find((meshes) => meshes.cls === cls) as ClassMeshes;
  }

  /** Write one vehicle, standing at `at` and turned by `turn`, into its class's meshes. */
  private add(meshes: ClassMeshes, paint: number): void {
    const index = meshes.paint.count;
    if (index >= CLASS_CAP) return;
    this.matrix.compose(this.at, this.turn, this.one);
    meshes.paint.setMatrixAt(index, this.matrix);
    meshes.trim.setMatrixAt(index, this.matrix);
    meshes.rim.setMatrixAt(index, this.matrix);
    meshes.paint.setColorAt(index, this.colour.set(paint));
    meshes.paint.count = index + 1;
  }
}

function instanced(geometry: BufferGeometry, material: Material, shadow: boolean): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, CLASS_CAP);
  // The instances are spread over hundreds of metres; the geometry's own bounds say nothing about them.
  mesh.frustumCulled = false;
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  mesh.count = 0;
  return mesh;
}

/** One box of the plan as a geometry already standing in the vehicle's frame, grown by `reach`. */
function boxOf(part: VehicleBox, reach: number): BufferGeometry {
  const geometry = new BoxGeometry(part.length + 2 * reach, part.height + 2 * reach, part.width + 2 * reach).toNonIndexed();
  geometry.translate(part.x, part.y, part.z);
  return geometry;
}

/** A geometry with one colour on every vertex, so it can be merged with parts of other colours. */
function coloured(geometry: BufferGeometry, colour: number): BufferGeometry {
  const c = new Color(colour);
  const count = geometry.getAttribute('position').count;
  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colours.set([c.r, c.g, c.b], i * 3);
  geometry.setAttribute('color', new BufferAttribute(colours, 3));
  return geometry;
}

function merged(parts: BufferGeometry[]): BufferGeometry {
  if (parts.length === 0) return new BoxGeometry(0, 0, 0).toNonIndexed();
  const geometry = mergeGeometries(parts) as BufferGeometry;
  for (const part of parts) part.dispose();
  return geometry;
}

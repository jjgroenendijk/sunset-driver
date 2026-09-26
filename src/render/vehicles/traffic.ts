/**
 * The traffic, drawn (spec sections 9.2, 13.1).
 *
 * Every class of the traffic is four instanced meshes: the painted parts; the
 * lamps and trim; the tinted glass the driver shows through; and the tyres.
 * Each vehicle is one instance of each, so the whole traffic in view costs
 * four draws per class that is on screen, however many cars there are. The
 * tyres are a mesh of their own because the body moves on its springs
 * (`suspension.ts`) and they do not.
 * The paint is the instance's colour, which is how two saloons in one mesh
 * come in two colours.
 *
 * Every class carries a fourth: the figure of `bike-rider.ts` on a bike, and
 * the driver of `occupant.ts` behind the glass of a car, so every vehicle
 * driving its tour has somebody in it. Only the vehicles on their tours are
 * written into it, since one the player has touched is one nobody is driving
 * any more.
 *
 * The traffic is evaluated where the frame stands in time, between two ticks,
 * the way `smooth.ts` draws the player. A vehicle the player has touched is
 * drawn from its record instead, since it no longer drives its tour. The
 * traffic lights the vehicles stop at are drawn with them (`signals.ts`).
 */
import {
  BoxGeometry,
  BufferAttribute,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { heldPose } from '../../sim/traffic/hold.ts';
import type { SimState } from '../../sim/simulation.ts';
import { AMBIENT_CLASSES, promotedOf, type AmbientPose, type AmbientTraffic } from '../../sim/traffic/traffic.ts';
import { rideHeight, specOf, type VehicleClass, type VehicleSpec } from '../../sim/vehicles/vehicle.ts';
import { outInThis } from '../../sim/city/weather.ts';
import { riderStruts, type RiderStrut } from './bike-rider.ts';
import { SignalView } from '../roads/signals.ts';
import { Suspension, type Lean } from './suspension.ts';
import { driverOf } from './occupant.ts';
import { partGeometry } from './vehicle-geometry.ts';
import { createVehicleTrim, glowOf, type VehicleTrim } from './vehicle-glow.ts';
import { GLASS, TYRE, vehicleBoxes, type VehicleBox } from './vehicle-mesh.ts';
import { GLASS_OPACITY } from './vehicle-parts.ts';
import { tinted } from '../look/tint.ts';

/** Metres each way of the point the frame is drawn round that traffic is drawn in. */
export const TRAFFIC_VIEW = 180;

/** Vehicles of one class drawn at most. A frame with more leaves the rest out. */
const CLASS_CAP = 256;

/** The tinted glass of every vehicle drawn instanced: one colour, seen through. */
export function glassMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: GLASS, roughness: 0.1, metalness: 0.2, transparent: true, opacity: GLASS_OPACITY });
}

/** The meshes one class is drawn with: four, and a fifth for whoever is in it. */
interface ClassMeshes {
  cls: VehicleClass;
  spec: VehicleSpec;
  paint: InstancedMesh;
  trim: InstancedMesh;
  glass: InstancedMesh;
  tyres: InstancedMesh;
  /**
   * The rider of `bike-rider.ts` on a class that is sat astride, the driver
   * of `occupant.ts` on a car, and undefined on anything else. It is a mesh of
   * its own rather than part of the trim because only some of the vehicles
   * drawn carry one: one the player has touched has nobody in it, and a
   * parked one has nobody in it either.
   */
  rider: InstancedMesh | undefined;
}

/** The geometry of one class, split by how each part is coloured. */
export interface TrafficParts {
  /** The boxes in the row's paint, which the instance colour replaces. */
  paint: BufferGeometry;
  /** Everything in a colour of its own, carried per vertex. */
  trim: BufferGeometry;
  /** The glass, which is drawn seen through. */
  glass: BufferGeometry;
  /** The tyres, in the trim's colours, when they were asked for apart; otherwise in the trim. */
  tyres: BufferGeometry | undefined;
}

/**
 * Build the geometry one class of the traffic is drawn with. Headless: no
 * renderer is needed. The parts of the leaves named in `apart` are left out,
 * for a view that swings those leaves on meshes of their own. With `tyresApart`
 * the tyres come as a geometry of their own, for a body that moves on its
 * springs above them.
 */
export function trafficParts(spec: VehicleSpec, apart: readonly number[] = [], tyresApart = false): TrafficParts {
  const paint: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const tyres: BufferGeometry[] = tyresApart ? [] : trim;
  for (const part of vehicleBoxes(spec)) {
    if (part.hinge !== undefined && apart.includes(part.hinge.leaf)) continue;
    if (part.glass === true) glass.push(boxOf(part));
    else if (part.colour === spec.paint) paint.push(boxOf(part));
    else trim.push(coloured(boxOf(part), part.colour));
  }
  pushTyres(spec, tyres);
  return { paint: merged(paint), trim: merged(trim), glass: merged(glass), tyres: tyresApart ? merged(tyres) : undefined };
}

/** Add the tyres of a class. A class with its wheels in line takes one of each pair, on the centre line. */
function pushTyres(spec: VehicleSpec, tyres: BufferGeometry[]): void {
  for (const wheel of spec.wheels) {
    if (spec.inline && wheel.z < 0) continue;
    const tyre = new CylinderGeometry(spec.wheelRadius, spec.wheelRadius, spec.wheelWidth, 10);
    tyre.rotateX(Math.PI / 2);
    tyre.translate(wheel.x, wheel.y - spec.suspensionRest, spec.inline ? 0 : wheel.z);
    tyres.push(coloured(tyre.toNonIndexed(), TYRE));
    tyre.dispose();
  }
}

export class TrafficView {
  readonly group = new Group();
  /** The traffic lights, or undefined where the roads came without them. */
  readonly signals: SignalView | undefined;
  /**
   * The share of the ambient traffic that is out (spec section 13.4). 1 on a
   * clear day; a storm keeps the rest of it at home. `outInThis` decides who,
   * so the same storm hides the same cars on every machine.
   */
  share = 1;
  private readonly traffic: AmbientTraffic;
  private readonly classes: ClassMeshes[] = [];
  private readonly trim: VehicleTrim;
  private readonly materials: Material[] = [];
  private readonly ids: number[] = [];
  private readonly pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  /** The turn of the body on its springs, on top of {@link turn}. */
  private readonly body = new Quaternion();
  private readonly tilt = new Quaternion();
  private readonly tiltAngles = new Euler();
  private readonly springs = new Suspension();
  private readonly lean: Lean = { pitch: 0, roll: 0 };
  private readonly wheels = new Matrix4();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);
  private readonly colour = new Color();

  constructor(traffic: AmbientTraffic) {
    this.traffic = traffic;
    const paint = new MeshStandardMaterial({ roughness: 0.45, metalness: 0.2 });
    const glass = glassMaterial();
    this.trim = createVehicleTrim();
    const trim = this.trim.material;
    this.materials.push(paint, glass);
    for (const cls of AMBIENT_CLASSES) {
      const spec = specOf(cls);
      const parts = trafficParts(spec, [], true);
      const struts = riderStruts(spec);
      const driver = driverOf(spec);
      const figure = struts.length > 0 ? struts.map(strutOf) : driver.map((part) => coloured(boxOf(part), part.colour));
      const meshes: ClassMeshes = {
        cls,
        spec,
        paint: tinted(instanced(parts.paint, paint, true, CLASS_CAP)),
        trim: instanced(parts.trim, trim, false, CLASS_CAP),
        glass: instanced(parts.glass, glass, false, CLASS_CAP),
        tyres: instanced(parts.tyres as BufferGeometry, trim, false, CLASS_CAP),
        rider: figure.length === 0 ? undefined : instanced(merged(figure), trim, true, CLASS_CAP),
      };
      this.classes.push(meshes);
      this.group.add(meshes.paint, meshes.trim, meshes.glass, meshes.tyres);
      if (meshes.rider !== undefined) this.group.add(meshes.rider);
    }
    this.signals = traffic.signals === undefined ? undefined : new SignalView(traffic.signals);
    if (this.signals !== undefined) this.group.add(this.signals.group);
  }

  /**
   * How far on the headlamps and tail lights of the traffic are, 0 by day and
   * 1 after dark. It is the number the street lamps run off (`daylight.ts`), so
   * the traffic lights up with the street it is on.
   */
  set lamps(amount: number) {
    this.trim.lamps.value = amount;
  }

  get lamps(): number {
    return this.trim.lamps.value;
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
    for (const meshes of this.classes) {
      meshes.paint.count = 0;
      if (meshes.rider !== undefined) meshes.rider.count = 0;
    }
    this.springs.begin();
    const minX = x - TRAFFIC_VIEW;
    const minY = y - TRAFFIC_VIEW;
    const maxX = x + TRAFFIC_VIEW;
    const maxY = y + TRAFFIC_VIEW;
    this.addAmbient(state, time, minX, minY, maxX, maxY);
    this.addPromoted(state, minX, minY, maxX, maxY);
    this.springs.end();
    for (const meshes of this.classes) finish(meshes);
    this.signals?.update(time, x, y);
  }

  /** Write the ambient vehicles in a box that are out and not promoted. */
  private addAmbient(state: SimState, time: number, minX: number, minY: number, maxX: number, maxY: number): void {
    const traffic = this.traffic;
    for (const id of traffic.near(minX, minY, maxX, maxY, this.ids)) {
      if (promotedOf(state.traffic, id) !== undefined) continue;
      if (!outInThis(id, this.share)) continue;
      const pose = heldPose(traffic, state.traffic.held, id, time, this.pose);
      if (pose.x < minX || pose.x > maxX || pose.y < minY || pose.y > maxY) continue;
      const vehicle = traffic.vehicles[id] as AmbientTraffic['vehicles'][number];
      const meshes = this.meshesOf(vehicle.cls);
      this.at.set(pose.x, pose.height + rideHeight(meshes.spec), pose.y);
      this.turn.setFromAxisAngle(this.up, -pose.heading);
      const lean = this.springs.lean(id, time, pose.x, pose.y, pose.heading, pose.speed, meshes.spec.inline, this.lean);
      this.tilt.setFromEuler(this.tiltAngles.set(lean.roll, 0, lean.pitch, 'XZY'));
      this.body.copy(this.turn).multiply(this.tilt);
      this.add(meshes, vehicle.paint, true);
    }
  }

  /** Write the promoted vehicles in a box, which the physics moves. */
  private addPromoted(state: SimState, minX: number, minY: number, maxX: number, maxY: number): void {
    for (const record of state.traffic.promoted) {
      const v = record.vehicle;
      if (v.x < minX || v.x > maxX || v.z < minY || v.z > maxY) continue;
      const meshes = this.meshesOf(v.cls);
      this.at.set(v.x, v.y, v.z);
      this.turn.set(v.qx, v.qy, v.qz, v.qw);
      // The physics already moves a promoted body on its own springs.
      this.body.copy(this.turn);
      // Nobody drives a promoted vehicle, so a bike the player has touched
      // rolls on with an empty saddle.
      this.add(meshes, record.paint, false);
    }
  }

  dispose(): void {
    for (const meshes of this.classes) {
      for (const mesh of [meshes.paint, meshes.trim, meshes.glass, meshes.tyres, meshes.rider]) {
        if (mesh === undefined) continue;
        mesh.geometry.dispose();
        mesh.dispose();
      }
    }
    for (const material of this.materials) material.dispose();
    this.trim.dispose();
    this.signals?.dispose();
    this.group.clear();
  }

  private meshesOf(cls: VehicleClass): ClassMeshes {
    return this.classes.find((meshes) => meshes.cls === cls) as ClassMeshes;
  }

  /**
   * Write one vehicle, standing at `at` and turned by `turn`, into its class's
   * meshes, its body turned by `body` on its springs. `ridden` says whether
   * anybody is in it, which only a class that carries a figure can answer yes
   * to.
   */
  private add(meshes: ClassMeshes, paint: number, ridden: boolean): void {
    const index = meshes.paint.count;
    if (index >= CLASS_CAP) return;
    this.matrix.compose(this.at, this.body, this.one);
    // A bike's wheels lean with it; a car's stay square on the road.
    this.wheels.compose(this.at, meshes.spec.inline ? this.body : this.turn, this.one);
    meshes.paint.setMatrixAt(index, this.matrix);
    meshes.trim.setMatrixAt(index, this.matrix);
    meshes.glass.setMatrixAt(index, this.matrix);
    meshes.tyres.setMatrixAt(index, this.wheels);
    meshes.paint.setColorAt(index, this.colour.set(paint));
    meshes.paint.count = index + 1;
    const rider = meshes.rider;
    if (!ridden || rider === undefined) return;
    rider.setMatrixAt(rider.count, this.matrix);
    rider.count += 1;
  }
}

/** Match a class's other meshes to the vehicles written into its paint, and upload them. */
function finish(meshes: ClassMeshes): void {
  const count = meshes.paint.count;
  meshes.trim.count = count;
  meshes.glass.count = count;
  meshes.tyres.count = count;
  for (const mesh of [meshes.paint, meshes.trim, meshes.glass, meshes.tyres]) {
    mesh.visible = count > 0;
    if (count === 0) continue;
    mesh.instanceMatrix.needsUpdate = true;
  }
  if (count > 0 && meshes.paint.instanceColor !== null) meshes.paint.instanceColor.needsUpdate = true;
  const rider = meshes.rider;
  if (rider === undefined) return;
  rider.visible = rider.count > 0;
  if (rider.count > 0) rider.instanceMatrix.needsUpdate = true;
}

/** An instanced mesh of up to `cap` vehicles, drawing none until it is filled. */
export function instanced(geometry: BufferGeometry, material: Material, shadow: boolean, cap: number): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, cap);
  // The instances are spread over hundreds of metres; the geometry's own bounds say nothing about them.
  mesh.frustumCulled = false;
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  mesh.count = 0;
  return mesh;
}

/** One part of the plan, box or lofted, as a geometry already standing in the vehicle's frame. */
export function boxOf(part: Omit<VehicleBox, 'panel'>): BufferGeometry {
  const built = partGeometry(part);
  const geometry = built.index === null ? built : built.toNonIndexed();
  if (geometry !== built) built.dispose();
  geometry.translate(part.x, part.y, part.z);
  return geometry;
}

/**
 * One strut of a rider (`bike-rider.ts`) as a geometry standing in the
 * vehicle's frame: a box as long as the strut, pitched up to it and then
 * turned across to it, with its colour on its vertices.
 */
export function strutOf(strut: RiderStrut): BufferGeometry {
  const dx = strut.to[0] - strut.from[0];
  const dy = strut.to[1] - strut.from[1];
  const dz = strut.to[2] - strut.from[2];
  const flat = Math.hypot(dx, dz);
  const geometry = new BoxGeometry(Math.hypot(flat, dy), strut.thickness, strut.width).toNonIndexed();
  geometry.rotateZ(Math.atan2(dy, flat));
  geometry.rotateY(Math.atan2(-dz, dx));
  geometry.translate((strut.from[0] + strut.to[0]) / 2, (strut.from[1] + strut.to[1]) / 2, (strut.from[2] + strut.to[2]) / 2);
  return coloured(geometry, strut.colour);
}

/**
 * A geometry with one colour on every vertex, so it can be merged with parts of
 * other colours. Each vertex also carries how hard it burns after dark
 * (`vehicle-glow.ts`), which is what makes a headlamp a headlamp once the parts
 * are merged and the colour alone can no longer be asked.
 */
export function coloured(geometry: BufferGeometry, colour: number): BufferGeometry {
  const c = new Color(colour);
  const count = geometry.getAttribute('position').count;
  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colours.set([c.r, c.g, c.b], i * 3);
  geometry.setAttribute('color', new BufferAttribute(colours, 3));
  geometry.setAttribute('glow', new BufferAttribute(new Float32Array(count).fill(glowOf(colour)), 1));
  return geometry;
}

export function merged(parts: BufferGeometry[]): BufferGeometry {
  if (parts.length === 0) return new BoxGeometry(0, 0, 0).toNonIndexed();
  const geometry = mergeGeometries(parts) as BufferGeometry;
  for (const part of parts) part.dispose();
  return geometry;
}

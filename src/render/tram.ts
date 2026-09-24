/**
 * The trams, drawn (spec sections 9.2, 13.2).
 *
 * A tram is drawn module by module: each car of each tram is one instance of
 * the geometry its design and its place in the tram call for (`tram-mesh.ts`).
 * The rear module of a modern tram is the front one turned about, so the two
 * share a geometry and a draw.
 *
 * Three geometries cover both fleets — a modern end module, a modern middle
 * module and a heritage car — and each is one mesh, so a frame costs at most
 * three draws for the bodies and pays for none of a fleet that is not in view:
 * a mesh with nothing in it is hidden.
 *
 * The colours are on the vertices and the lamps and destination boards burn off
 * the shared `glow` attribute (`vehicle-glow.ts`), so {@link TramView.lamps}
 * lights the whole fleet after dark the way the traffic's does.
 *
 * The trams are evaluated where the frame stands in time, between two ticks, as
 * the traffic is. The people waiting at the stops are drawn with the crowd
 * (`pedestrians.ts`).
 */
import { Group, Matrix4, Quaternion, Vector3, type BufferGeometry, type InstancedMesh } from 'three';
import type { AmbientPose } from '../sim/traffic.ts';
import { TRAM_CARS, type TramDesign, type TramLine } from '../sim/tram.ts';
import { createVehicleTrim, type VehicleTrim } from './vehicle-glow.ts';
import { instanced, merged, TRAFFIC_VIEW } from './traffic.ts';
import {
  doorLeafBoxes,
  DOOR_LONG,
  sparkBoxes,
  sparkPlace,
  tramBoxes,
  tramBoxGeometry,
  tramCarPlan,
  tramDoors,
  type TramModule,
} from './tram-mesh.ts';
import { hashInts } from '../core/hash.ts';
import { coloured } from './traffic.ts';

export { MODERN_PAINT as TRAM_PAINT } from './tram-mesh.ts';
export { tramBoxes, type TramBox } from './tram-mesh.ts';

/** The modules a frame may have to draw: both of the modern design, and the heritage car. */
const MODULES: { design: TramDesign; module: TramModule }[] = [
  { design: 'modern', module: 'end' },
  { design: 'modern', module: 'middle' },
  { design: 'heritage', module: 'middle' },
];

/** The geometry of one module: its boxes in their colours. */
export function tramParts(design: TramDesign = 'modern', module: TramModule = 'end'): BufferGeometry {
  return merged(tramBoxes(design, module).map((part) => coloured(tramBoxGeometry(part), part.colour)));
}

/** The geometry of one door leaf, which every module of both fleets shares. */
function doorParts(): BufferGeometry {
  return merged(doorLeafBoxes().map((part) => coloured(tramBoxGeometry(part), part.colour)));
}

/** The geometry of the arc at a collector. */
function sparkParts(): BufferGeometry {
  return merged(sparkBoxes().map((part) => coloured(tramBoxGeometry(part), part.colour)));
}

/**
 * Frames of one flash of the arc, and one flash in this many. A collector
 * sparks where the wire is worn or a joint passes under it, which is often
 * enough to see from a street and rare enough not to strobe.
 */
const SPARK_FRAMES = 9;
const SPARK_ONE_IN = 11;
/** Metres per second below which a tram is too slow to strike an arc. */
const SPARK_SPEED = 2;

/** One module's mesh and how many instances of it the frame has written. */
interface ModuleMeshes {
  design: TramDesign;
  module: TramModule;
  body: InstancedMesh;
  count: number;
}

export class TramView {
  readonly group = new Group();
  private readonly line: TramLine;
  private readonly meshes: ModuleMeshes[] = [];
  /** The door leaves of every car in view, which slide back while a tram stands at a stop. */
  private readonly doors: InstancedMesh;
  private doorCount = 0;
  private readonly slide = new Matrix4();
  /** The arc at the collector of each tram, on the frames it strikes one. */
  private readonly sparks: InstancedMesh;
  private sparkCount = 0;
  private readonly trim: VehicleTrim;
  private readonly pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);

  constructor(line: TramLine) {
    this.line = line;
    this.trim = createVehicleTrim();
    const cap = Math.max(1, line.trams * TRAM_CARS);
    for (const { design, module } of MODULES) {
      const meshes: ModuleMeshes = {
        design,
        module,
        body: instanced(tramParts(design, module), this.trim.material, true, cap),
        count: 0,
      };
      this.meshes.push(meshes);
      this.group.add(meshes.body);
    }
    this.doors = instanced(doorParts(), this.trim.material, true, Math.max(1, cap * 2));
    this.sparks = instanced(sparkParts(), this.trim.material, false, Math.max(1, line.trams));
    this.group.add(this.doors, this.sparks);
  }

  /** How many cars the last frame drew. */
  get drawn(): number {
    return this.meshes.reduce((sum, meshes) => sum + meshes.body.count, 0);
  }

  /**
   * How far on the lamps and destination boards of the fleet are, 0 by day and
   * 1 after dark. It is the number the traffic and the street lamps run off.
   */
  set lamps(amount: number) {
    this.trim.lamps.value = amount;
  }

  get lamps(): number {
    return this.trim.lamps.value;
  }

  /** Draw the trams round a place as they stand at a moment, which may fall between two ticks. */
  update(time: number, x: number, y: number): void {
    for (const meshes of this.meshes) meshes.count = 0;
    this.doorCount = 0;
    this.sparkCount = 0;
    for (let tram = 0; tram < this.line.trams; tram++) {
      const design = this.line.design(tram);
      const open = this.line.doorsAt(tram, time);
      for (let car = 0; car < TRAM_CARS; car++) {
        const pose = this.line.carPose(tram, car, time, this.pose);
        if (Math.abs(pose.x - x) > TRAFFIC_VIEW || Math.abs(pose.y - y) > TRAFFIC_VIEW) continue;
        const plan = tramCarPlan(design, car, TRAM_CARS);
        const meshes = this.meshes.find((m) => m.design === design && m.module === plan.module);
        if (meshes === undefined || meshes.count >= meshes.body.instanceMatrix.count) continue;
        this.at.set(pose.x, pose.height, pose.y);
        this.turn.setFromAxisAngle(this.up, -pose.heading + (plan.reversed ? Math.PI : 0));
        this.matrix.compose(this.at, this.turn, this.one);
        meshes.body.setMatrixAt(meshes.count, this.matrix);
        meshes.count++;
        this.writeDoors(design, plan.module, open);
        this.writeSpark(design, tram, car, time, pose.speed);
      }
    }
    for (const meshes of this.meshes) {
      const mesh = meshes.body;
      mesh.count = meshes.count;
      mesh.visible = meshes.count > 0;
      if (meshes.count > 0) mesh.instanceMatrix.needsUpdate = true;
    }
    for (const mesh of [this.doors, this.sparks]) {
      const count = mesh === this.doors ? this.doorCount : this.sparkCount;
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * The arc at a tram's collector, if this is the car that carries it, the
   * lamps are on and it is moving. Which frames it strikes on is a hash of the
   * tram and the moment, so every viewer of one tram sees the same sparks.
   */
  private writeSpark(design: TramDesign, tram: number, car: number, time: number, speed: number): void {
    const place = sparkPlace(design);
    if (car !== place.car || speed < SPARK_SPEED || this.lamps < 0.5) return;
    if (this.sparkCount >= this.sparks.instanceMatrix.count) return;
    if (hashInts(tram, Math.floor(time / SPARK_FRAMES)) % SPARK_ONE_IN !== 0) return;
    this.slide.makeTranslation(place.x, place.y, 0);
    this.slide.premultiply(this.matrix);
    this.sparks.setMatrixAt(this.sparkCount++, this.slide);
  }

  /**
   * The leaves of one car, standing in the car's frame the last matrix put
   * down. A leaf slides back along the car by its own length, so a door wide
   * open leaves the whole doorway clear.
   */
  private writeDoors(design: TramDesign, module: TramModule, open: number): void {
    for (const at of tramDoors(design, module)) {
      if (this.doorCount >= this.doors.instanceMatrix.count) return;
      this.slide.makeTranslation(at - open * DOOR_LONG, 0, 0);
      this.slide.premultiply(this.matrix);
      this.doors.setMatrixAt(this.doorCount++, this.slide);
    }
  }

  dispose(): void {
    for (const mesh of [this.doors, this.sparks]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (const meshes of this.meshes) {
      meshes.body.geometry.dispose();
      meshes.body.dispose();
    }
    this.trim.dispose();
    this.group.clear();
  }
}

/**
 * The trams, drawn (spec sections 9.2, 13.2).
 *
 * A tram is drawn module by module: each car of each tram is one instance of
 * the geometry its design and its place in the tram call for (`tram-mesh.ts`),
 * with the outline of spec section 10.1 round its masses. The rear module of a
 * modern tram is the front one turned about, so the two share a geometry and a
 * draw.
 *
 * Three geometries cover both fleets — a modern end module, a modern middle
 * module and a heritage car — and each is one mesh with its outline, so a
 * frame costs at most six draws and pays for none of a fleet that is not in
 * view: a mesh with nothing in it is hidden.
 *
 * The colours are on the vertices and the lamps and destination boards burn off
 * the shared `glow` attribute (`vehicle-glow.ts`), so {@link TramView.lamps}
 * lights the whole fleet after dark the way the traffic's does.
 *
 * The trams are evaluated where the frame stands in time, between two ticks, as
 * the traffic is. The people waiting at the stops are drawn with the crowd
 * (`pedestrians.ts`).
 */
import { BackSide, Color, Group, Matrix4, MeshBasicMaterial, Quaternion, Vector3, type BufferGeometry, type InstancedMesh } from 'three';
import type { AmbientPose } from '../sim/traffic.ts';
import { TRAM_CARS, type TramDesign, type TramLine } from '../sim/tram.ts';
import { createVehicleTrim, type VehicleTrim } from './vehicle-glow.ts';
import { instanced, merged, TRAFFIC_VIEW } from './traffic.ts';
import { tramBoxes, tramBoxGeometry, tramCarPlan, type TramBox, type TramModule } from './tram-mesh.ts';
import { OUTLINE, VEHICLE_OUTLINE_WIDTH } from './vehicle.ts';
import { coloured } from './traffic.ts';

export { MODERN_PAINT as TRAM_PAINT } from './tram-mesh.ts';
export { tramBoxes, type TramBox } from './tram-mesh.ts';

/** The modules a frame may have to draw: both of the modern design, and the heritage car. */
const MODULES: { design: TramDesign; module: TramModule }[] = [
  { design: 'modern', module: 'end' },
  { design: 'modern', module: 'middle' },
  { design: 'heritage', module: 'middle' },
];

/** The geometry of one module: its boxes in their colours, and the outline round the masses. */
export function tramParts(design: TramDesign = 'modern', module: TramModule = 'end'): { body: BufferGeometry; rim: BufferGeometry } {
  const body: BufferGeometry[] = [];
  const rim: BufferGeometry[] = [];
  for (const part of tramBoxes(design, module) as TramBox[]) {
    body.push(coloured(tramBoxGeometry(part, 0), part.colour));
    if (part.outlined) rim.push(tramBoxGeometry(part, VEHICLE_OUTLINE_WIDTH));
  }
  return { body: merged(body), rim: merged(rim) };
}

/** One module's two meshes and how many instances of it the frame has written. */
interface ModuleMeshes {
  design: TramDesign;
  module: TramModule;
  body: InstancedMesh;
  rim: InstancedMesh;
  count: number;
}

export class TramView {
  readonly group = new Group();
  private readonly line: TramLine;
  private readonly meshes: ModuleMeshes[] = [];
  private readonly trim: VehicleTrim;
  private readonly outline: MeshBasicMaterial;
  private readonly pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);

  constructor(line: TramLine) {
    this.line = line;
    this.trim = createVehicleTrim();
    this.outline = new MeshBasicMaterial({ color: new Color(OUTLINE), side: BackSide, fog: true });
    const cap = Math.max(1, line.trams * TRAM_CARS);
    for (const { design, module } of MODULES) {
      const parts = tramParts(design, module);
      const meshes: ModuleMeshes = {
        design,
        module,
        body: instanced(parts.body, this.trim.material, true, cap),
        rim: instanced(parts.rim, this.outline, false, cap),
        count: 0,
      };
      this.meshes.push(meshes);
      this.group.add(meshes.body, meshes.rim);
    }
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
    for (let tram = 0; tram < this.line.trams; tram++) {
      const design = this.line.design(tram);
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
        meshes.rim.setMatrixAt(meshes.count, this.matrix);
        meshes.count++;
      }
    }
    for (const meshes of this.meshes) {
      for (const mesh of [meshes.body, meshes.rim]) {
        mesh.count = meshes.count;
        mesh.visible = meshes.count > 0;
        if (meshes.count > 0) mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    for (const meshes of this.meshes) {
      for (const mesh of [meshes.body, meshes.rim]) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
    }
    this.trim.dispose();
    this.outline.dispose();
    this.group.clear();
  }
}

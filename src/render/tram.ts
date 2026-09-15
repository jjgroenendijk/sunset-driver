/**
 * The trams, drawn (spec sections 9.2, 13.2).
 *
 * Every car of every tram is one instance of two meshes: the car itself, its
 * colours carried per vertex, and the outline of spec section 10.1 round its
 * masses. The whole line costs two draws, however many cars are in view. The
 * trams are evaluated where the frame stands in time, between two ticks, as
 * the traffic is. The people waiting at the stops are drawn with the crowd
 * (`pedestrians.ts`).
 */
import { BackSide, Color, Group, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Quaternion, Vector3, type BufferGeometry, type InstancedMesh, type Material } from 'three';
import type { AmbientPose } from '../sim/traffic.ts';
import { BOGIE, CAR_HALF_HEIGHT, CAR_HALF_WIDTH, CAR_LENGTH, TRAM_CARS, type TramLine } from '../sim/tram.ts';
import { boxOf, coloured, instanced, merged, TRAFFIC_VIEW } from './traffic.ts';
import { OUTLINE, VEHICLE_OUTLINE_WIDTH } from './vehicle.ts';
import { GLASS, LAMP, METAL, TYRE } from './vehicle-mesh.ts';

/** The livery of the line. */
export const TRAM_PAINT = 0xe2a52b;
/** The band under the windows. */
const TRAM_STRIPE = 0xf3efe4;

/** Metres of clearance under the body, between the rails and the floor. */
const FLOOR = 0.35;

/** One box of a car, in the car's own frame: forward along `+x`, up `+y` from the rail. */
export interface TramBox {
  length: number;
  height: number;
  width: number;
  x: number;
  y: number;
  z: number;
  colour: number;
  outlined: boolean;
}

/** The boxes one car is drawn as. The body fills the box the physics gives a car. */
export function tramBoxes(): TramBox[] {
  const top = 2 * CAR_HALF_HEIGHT;
  const body = top - FLOOR - 0.3;
  const width = 2 * CAR_HALF_WIDTH;
  const box = (length: number, height: number, w: number, x: number, y: number, colour: number, outlined = false): TramBox => ({
    length,
    height,
    width: w,
    x,
    y,
    z: 0,
    colour,
    outlined,
  });
  return [
    box(CAR_LENGTH, body, width, 0, FLOOR + body / 2, TRAM_PAINT, true),
    box(CAR_LENGTH - 0.6, 0.95, width + 0.04, 0, FLOOR + body - 0.75, GLASS),
    box(CAR_LENGTH + 0.02, 0.18, width + 0.02, 0, FLOOR + 0.55, TRAM_STRIPE),
    box(CAR_LENGTH - 1.2, 0.3, width - 0.5, 0, top - 0.15, METAL, true),
    box(1.4, 0.5, 0.5, 0, top + 0.25, METAL),
    box(2.2, FLOOR, width - 0.4, -BOGIE, FLOOR / 2, TYRE),
    box(2.2, FLOOR, width - 0.4, BOGIE, FLOOR / 2, TYRE),
    box(0.06, 0.25, 0.4, CAR_LENGTH / 2 + 0.02, FLOOR + 0.9, LAMP),
    box(0.06, 0.25, 0.4, -CAR_LENGTH / 2 - 0.02, FLOOR + 0.9, LAMP),
  ];
}

/** The geometry of one car: its boxes in their colours, and the outline round the masses. */
export function tramParts(): { body: BufferGeometry; rim: BufferGeometry } {
  const body: BufferGeometry[] = [];
  const rim: BufferGeometry[] = [];
  for (const part of tramBoxes()) {
    body.push(coloured(boxOf(part, 0), part.colour));
    if (part.outlined) rim.push(boxOf(part, VEHICLE_OUTLINE_WIDTH));
  }
  return { body: merged(body), rim: merged(rim) };
}

export class TramView {
  readonly group = new Group();
  private readonly line: TramLine;
  private readonly body: InstancedMesh;
  private readonly rim: InstancedMesh;
  private readonly materials: Material[];
  private readonly pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);

  constructor(line: TramLine) {
    this.line = line;
    const parts = tramParts();
    const body = new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15 });
    const outline = new MeshBasicMaterial({ color: new Color(OUTLINE), side: BackSide, fog: true });
    this.materials = [body, outline];
    const cap = Math.max(1, line.trams * TRAM_CARS);
    this.body = instanced(parts.body, body, true, cap);
    this.rim = instanced(parts.rim, outline, false, cap);
    this.group.add(this.body, this.rim);
  }

  /** How many cars the last frame drew. */
  get drawn(): number {
    return this.body.count;
  }

  /** Draw the trams round a place as they stand at a moment, which may fall between two ticks. */
  update(time: number, x: number, y: number): void {
    let count = 0;
    for (let tram = 0; tram < this.line.trams; tram++) {
      for (let car = 0; car < TRAM_CARS; car++) {
        const pose = this.line.carPose(tram, car, time, this.pose);
        if (Math.abs(pose.x - x) > TRAFFIC_VIEW || Math.abs(pose.y - y) > TRAFFIC_VIEW) continue;
        this.at.set(pose.x, pose.height, pose.y);
        this.turn.setFromAxisAngle(this.up, -pose.heading);
        this.matrix.compose(this.at, this.turn, this.one);
        this.body.setMatrixAt(count, this.matrix);
        this.rim.setMatrixAt(count, this.matrix);
        count++;
      }
    }
    for (const mesh of [this.body, this.rim]) {
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of [this.body, this.rim]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (const material of this.materials) material.dispose();
    this.group.clear();
  }
}

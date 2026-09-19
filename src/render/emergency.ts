/**
 * The fire engines and the ambulances, drawn (spec sections 9.2, 20.3).
 *
 * `src/render/police.ts` draws the police the same way, and this is its
 * sibling: the painted boxes of a row of the roster, the parts with colours of
 * their own, the outline of spec section 10.1, and a light bar on the roof
 * whose instance colour flips on a beat of the tick.
 *
 * Neither service has a row of its own, so each borrows the nearest one and is
 * repainted: an engine is a truck in red, an ambulance a van in white. Both
 * carry a bar wide enough to read from above, since the camera of spec section
 * 10.7 sees the roof and nothing else.
 *
 * The units are drawn where the record put them. They are stepped every tick
 * like the police, so nothing is evaluated between two ticks here.
 */
import {
  BackSide,
  BoxGeometry,
  Color,
  Group,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type InstancedMesh,
  type Material,
} from 'three';
import type { EmergencyKind, EmergencyUnit } from '../sim/emergency.ts';
import type { SimState } from '../sim/simulation.ts';
import { rideHeight, specOf, type VehicleClass } from '../sim/vehicle.ts';
import { instanced, trafficParts, TRAFFIC_VIEW } from './traffic.ts';
import { OUTLINE } from './vehicle.ts';
import { createVehicleTrim, type VehicleTrim } from './vehicle-glow.ts';
import { tinted } from './tint.ts';

/** Units of each mesh drawn at most, which is more than the service ever has out. */
const UNIT_CAP = 8;

/** The row of the roster each service borrows, and the paint it is given. */
const BORROWED: Record<EmergencyKind, { cls: VehicleClass; paint: number }> = {
  engine: { cls: 'truck', paint: 0xb3251d },
  ambulance: { cls: 'van', paint: 0xf1f3f4 },
};

/** The two colours of a light bar, and the ticks it holds each one for. */
const LIGHT_RED = 0xd8302a;
const LIGHT_BLUE = 0x2f6ad8;

/**
 * How hard the bar burns, as a multiple of its colour. At 1 it stayed under
 * the bloom threshold of `post.ts` once exposed, and a siren did not glow.
 */
const BAR_GLOW = 4;
const FLASH_TICKS = 10;

/** The bar across the roof: its size, and how far over the roof it sits. */
const BAR = { length: 0.3, height: 0.14, width: 1.4 };

/** One service's three body meshes and the bar over them. */
interface KindMeshes {
  kind: EmergencyKind;
  paint: InstancedMesh;
  trim: InstancedMesh;
  rim: InstancedMesh;
  bar: InstancedMesh;
  colour: Color;
  /** Metres from the ground to the middle of the body, and from there to the bar. */
  ride: number;
  roof: number;
  drawn: number;
}

export class EmergencyView {
  readonly group = new Group();
  private readonly kinds: KindMeshes[] = [];
  private readonly materials: Material[];
  private readonly trimMaterial: VehicleTrim;
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);
  private readonly tint = new Color();

  constructor() {
    const paint = new MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 });
    this.trimMaterial = createVehicleTrim();
    const lamp = new MeshBasicMaterial({ toneMapped: false });
    const outline = new MeshBasicMaterial({ color: new Color(OUTLINE), side: BackSide, fog: true });
    this.materials = [paint, lamp, outline];
    for (const kind of ['engine', 'ambulance'] as const) {
      const borrowed = BORROWED[kind];
      const spec = specOf(borrowed.cls);
      const parts = trafficParts(spec);
      const meshes: KindMeshes = {
        kind,
        paint: tinted(instanced(parts.paint, paint, true, UNIT_CAP)),
        trim: instanced(parts.trim, this.trimMaterial.material, false, UNIT_CAP),
        rim: instanced(parts.rim, outline, false, UNIT_CAP),
        bar: tinted(instanced(new BoxGeometry(BAR.length, BAR.height, BAR.width), lamp, false, UNIT_CAP)),
        colour: new Color(borrowed.paint),
        ride: rideHeight(spec),
        roof: spec.halfHeight * 2 + BAR.height / 2,
        drawn: 0,
      };
      this.kinds.push(meshes);
      this.group.add(meshes.paint, meshes.trim, meshes.rim, meshes.bar);
    }
  }

  /** How far on the headlamps and tail lights are, 0 by day and 1 after dark. */
  set lamps(amount: number) {
    this.trimMaterial.lamps.value = amount;
  }

  get lamps(): number {
    return this.trimMaterial.lamps.value;
  }

  /** How many units the last frame drew. */
  get drawn(): number {
    let total = 0;
    for (const kind of this.kinds) total += kind.drawn;
    return total;
  }

  /** Draw the units round a place as the record left them on the last tick. */
  update(state: SimState, x: number, y: number): void {
    for (const kind of this.kinds) kind.drawn = 0;
    for (const unit of state.emergency.units as readonly EmergencyUnit[]) {
      if (Math.abs(unit.x - x) > TRAFFIC_VIEW || Math.abs(unit.y - y) > TRAFFIC_VIEW) continue;
      const meshes = this.kinds.find((held) => held.kind === unit.kind);
      if (meshes === undefined || meshes.drawn >= UNIT_CAP) continue;
      const at = meshes.drawn;
      this.turn.setFromAxisAngle(this.up, -unit.heading);
      this.at.set(unit.x, unit.height + meshes.ride, unit.y);
      this.matrix.compose(this.at, this.turn, this.one);
      meshes.paint.setMatrixAt(at, this.matrix);
      meshes.trim.setMatrixAt(at, this.matrix);
      meshes.rim.setMatrixAt(at, this.matrix);
      meshes.paint.setColorAt(at, meshes.colour);
      this.at.set(unit.x, unit.height + meshes.ride + meshes.roof, unit.y);
      this.matrix.compose(this.at, this.turn, this.one);
      meshes.bar.setMatrixAt(at, this.matrix);
      // Every other unit is on the other beat, so a pair of them flashes
      // against each other rather than in step.
      const beat = Math.floor(state.tick / FLASH_TICKS) + unit.id;
      meshes.bar.setColorAt(at, this.tint.set(beat % 2 === 0 ? LIGHT_RED : LIGHT_BLUE).multiplyScalar(BAR_GLOW));
      meshes.drawn = at + 1;
    }
    this.fill();
  }

  dispose(): void {
    for (const kind of this.kinds) {
      for (const mesh of [kind.paint, kind.trim, kind.rim, kind.bar]) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
    }
    for (const material of this.materials) material.dispose();
    this.trimMaterial.dispose();
    this.group.clear();
  }

  /** Show what was written this frame and hide the meshes that took nothing. */
  private fill(): void {
    for (const kind of this.kinds) {
      const count = kind.drawn;
      for (const mesh of [kind.paint, kind.trim, kind.rim, kind.bar]) {
        mesh.count = count;
        mesh.visible = count > 0;
        if (count > 0) mesh.instanceMatrix.needsUpdate = true;
      }
      if (count === 0) continue;
      if (kind.paint.instanceColor !== null) kind.paint.instanceColor.needsUpdate = true;
      if (kind.bar.instanceColor !== null) kind.bar.instanceColor.needsUpdate = true;
    }
  }
}

/**
 * The fire engines and the ambulances, drawn (spec sections 9.2, 20.3).
 *
 * Each kind has a shape of its own (`emergency-mesh.ts`): an engine is a long
 * red body with a ladder along the roof, and an ambulance a white box with a
 * red cross on it. A kind is three instanced meshes — the body with its colours
 * on the vertices, the outline of spec section 10.1, and one per phase of its
 * beacons (`beacons.ts`) — so every unit of a kind in view costs those draws
 * and no more.
 *
 * A unit on a call flashes its beacons and throws their light on the road
 * round it; one driving home after the job has them dark. Its doors are drawn
 * apart from the body, one instanced mesh each, so they swing open on the
 * record's own `doors` while the crew climb down through them. The crew of an
 * engine at work run hoses from it and play water over the scene from the
 * nozzles in their hands (`emergency-crew.ts`, `hose.ts`); their bodies are
 * the crowd's (`ui/emergency-crews.ts`).
 *
 * The units are drawn where the record put them. They are stepped every tick
 * like the police, so nothing is evaluated between two ticks here.
 */
import {
  BackSide,
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type InstancedMesh,
  type Material,
} from 'three';
import { onCall, UNIT_BODY, type EmergencyKind, type EmergencyUnit } from '../sim/emergency.ts';
import type { SimState } from '../sim/simulation.ts';
import { BeaconGlow, BeaconPhase, beaconMaterial, flashLit } from './beacons.ts';
import { unitShape, type UnitDoor, type UnitShape } from './emergency-mesh.ts';
import { crewOf, CREW_SIZE, type CrewMember } from '../sim/emergency-crew.ts';
import { emptyHose, hoseOf, type Hose } from './emergency-crew.ts';
import { HoseLines, HoseSpray } from './hose.ts';
import { boxOf, coloured, instanced, merged, TRAFFIC_VIEW } from './traffic.ts';
import { OUTLINE, VEHICLE_OUTLINE_WIDTH } from './vehicle.ts';
import { createVehicleTrim, type VehicleTrim } from './vehicle-glow.ts';
import { TYRE } from './vehicle-mesh.ts';

/** Units of each kind drawn at most, which is more than the service ever has out. */
const UNIT_CAP = 8;

/** Stretches in one firefighter's hose, with room to spare. */
const HOSE_STRETCHES = 16;

/** One kind's meshes, and what is needed to stand a unit in them. */
interface KindMeshes {
  kind: EmergencyKind;
  shape: UnitShape;
  body: InstancedMesh;
  rim: InstancedMesh;
  phases: [BeaconPhase, BeaconPhase];
  /** One mesh per door of the shape, since each door turns on its own hinge. */
  doors: InstancedMesh[];
  /** Metres from the road to the middle of the body. */
  ride: number;
  drawn: number;
}

/** The body of a unit, with its wheels, as one geometry with its colours on the vertices. */
export function unitBody(shape: UnitShape): BufferGeometry {
  const parts = shape.boxes.map((part) => coloured(boxOf(part, 0), part.colour));
  for (const wheel of shape.wheels) {
    const tyre = new CylinderGeometry(wheel.radius, wheel.radius, wheel.width, 12);
    tyre.rotateX(Math.PI / 2);
    tyre.translate(wheel.x, wheel.y, wheel.z);
    parts.push(coloured(tyre.toNonIndexed(), TYRE));
    tyre.dispose();
  }
  return merged(parts);
}

/** One door of a unit, built about its hinge so the instance matrix can turn it. */
function doorPanel(door: UnitDoor): BufferGeometry {
  const panel = { ...door.box, x: door.box.x - door.hinge.x, y: door.box.y - door.hinge.y, z: door.box.z - door.hinge.z };
  return coloured(boxOf(panel, 0), panel.colour);
}

/** The masses of a unit grown by the outline's width, which is the outline drawn behind it. */
function unitRim(shape: UnitShape): BufferGeometry {
  return merged(shape.boxes.filter((part) => part.outlined).map((part) => boxOf(part, VEHICLE_OUTLINE_WIDTH)));
}

export class EmergencyView {
  readonly group = new Group();
  private readonly kinds: KindMeshes[] = [];
  private readonly materials: Material[];
  private readonly trimMaterial: VehicleTrim;
  private readonly glow = new BeaconGlow(UNIT_CAP * 2);
  private readonly hose = new HoseSpray(UNIT_CAP * CREW_SIZE.engine);
  private readonly lines = new HoseLines(UNIT_CAP * CREW_SIZE.engine * HOSE_STRETCHES);
  private readonly water: Hose = emptyHose();
  private readonly hinge = new Matrix4();
  private readonly swing = new Matrix4();
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly nozzle = new Vector3();
  private readonly turn = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);

  constructor() {
    this.trimMaterial = createVehicleTrim();
    const lamp = beaconMaterial();
    const outline = new MeshBasicMaterial({ color: new Color(OUTLINE), side: BackSide, fog: true });
    this.materials = [lamp, outline];
    for (const kind of ['engine', 'ambulance'] as const) {
      const shape = unitShape(kind);
      const meshes: KindMeshes = {
        kind,
        shape,
        body: instanced(unitBody(shape), this.trimMaterial.material, true, UNIT_CAP),
        rim: instanced(unitRim(shape), outline, false, UNIT_CAP),
        phases: [new BeaconPhase(shape.beacons, 0, lamp, UNIT_CAP), new BeaconPhase(shape.beacons, 1, lamp, UNIT_CAP)],
        doors: shape.doors.map((door) => instanced(doorPanel(door), this.trimMaterial.material, true, UNIT_CAP)),
        ride: UNIT_BODY[kind].ride,
        drawn: 0,
      };
      this.kinds.push(meshes);
      this.group.add(meshes.body, meshes.rim, meshes.phases[0].mesh, meshes.phases[1].mesh, ...meshes.doors);
    }
    this.group.add(this.glow.mesh, this.hose.mesh, this.lines.mesh);
  }

  /**
   * How far on the headlamps and tail lights are, 0 by day and 1 after dark.
   * It also says how hard the beacons' light shows on the road.
   */
  set lamps(amount: number) {
    this.trimMaterial.lamps.value = amount;
    this.glow.night = amount;
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
    this.glow.begin();
    this.hose.begin();
    this.lines.begin();
    for (const unit of state.emergency.units as readonly EmergencyUnit[]) {
      if (Math.abs(unit.x - x) > TRAFFIC_VIEW || Math.abs(unit.y - y) > TRAFFIC_VIEW) continue;
      const meshes = this.kinds.find((held) => held.kind === unit.kind);
      if (meshes === undefined || meshes.drawn >= UNIT_CAP) continue;
      this.stand(state, unit, meshes);
    }
    for (const kind of this.kinds) this.fill(kind);
    this.glow.commit();
    this.hose.commit();
    this.lines.commit();
  }

  dispose(): void {
    for (const kind of this.kinds) {
      for (const mesh of this.meshesOf(kind)) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
    }
    for (const material of this.materials) material.dispose();
    this.trimMaterial.dispose();
    this.glow.dispose();
    this.hose.dispose();
    this.lines.dispose();
    this.group.clear();
  }

  /** Stand one unit: its body, its doors, its beacons, their light, and an engine's hoses. */
  private stand(state: SimState, unit: EmergencyUnit, meshes: KindMeshes): void {
    const tick = state.tick;
    const at = meshes.drawn;
    this.turn.setFromAxisAngle(this.up, -unit.heading);
    this.at.set(unit.x, unit.height + meshes.ride, unit.y);
    this.matrix.compose(this.at, this.turn, this.one);
    meshes.body.setMatrixAt(at, this.matrix);
    meshes.rim.setMatrixAt(at, this.matrix);
    const calling = onCall(unit);
    let lit = -1;
    for (const phase of [0, 1] as const) {
      const on = calling && flashLit(tick, unit.id, phase);
      meshes.phases[phase].set(at, this.matrix, on);
      if (on) lit = phase;
    }
    if (lit >= 0) this.glow.add(unit.x, unit.height, unit.y, (meshes.phases[lit] as BeaconPhase).colour);
    this.hang(at, unit, meshes);
    this.spray(state, unit);
    meshes.drawn = at + 1;
  }

  /**
   * Turn each of a unit's doors on its hinge, as far as the record has them
   * open. The unit's own matrix is already in `this.matrix`.
   */
  private hang(at: number, unit: EmergencyUnit, meshes: KindMeshes): void {
    for (let i = 0; i < meshes.doors.length; i++) {
      const door = meshes.shape.doors[i] as UnitDoor;
      this.at.set(door.hinge.x, door.hinge.y, door.hinge.z);
      this.turn.setFromAxisAngle(this.up, door.swing * unit.doors);
      this.hinge.compose(this.at, this.turn, this.one);
      this.swing.multiplyMatrices(this.matrix, this.hinge);
      (meshes.doors[i] as InstancedMesh).setMatrixAt(at, this.swing);
    }
  }

  /** Lay the hose of each of an engine's crew, and play water from the nozzles with it on. */
  private spray(state: SimState, unit: EmergencyUnit): void {
    if (unit.kind !== 'engine') return;
    for (const member of crewOf(state, unit.id) as CrewMember[]) {
      const water = hoseOf(state, unit, member, this.water);
      this.lines.add(water.points);
      if (!water.spraying) continue;
      this.nozzle.set(water.nozzleX, water.nozzleHeight, water.nozzleY);
      this.hose.add(member.id, state.tick, this.nozzle, unit.goalX, unit.goalY, unit.height);
    }
  }

  private meshesOf(kind: KindMeshes): InstancedMesh[] {
    return [kind.body, kind.rim, kind.phases[0].mesh, kind.phases[1].mesh, ...kind.doors];
  }

  /** Show what was written this frame and hide the meshes that took nothing. */
  private fill(kind: KindMeshes): void {
    const count = kind.drawn;
    for (const mesh of [kind.body, kind.rim, ...kind.doors]) {
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) mesh.instanceMatrix.needsUpdate = true;
    }
    for (const phase of kind.phases) phase.commit(count);
  }
}

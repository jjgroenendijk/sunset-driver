/**
 * The police, drawn (spec sections 9.2, 14).
 *
 * A police car is the patrol row of the roster, drawn the way the traffic is:
 * the painted parts, the parts with colours of their own and the glass. Its
 * front doors swing on meshes of their own (`police-doors.ts`) as the crew get
 * out and back in, and the driver shows through the glass while the crew is
 * aboard. The two halves
 * of the light bar on its roof flash against each other (`beacons.ts`), red
 * then blue, and throw their light on the road round the car: that is what a
 * player sees in the mirror before they see the car.
 *
 * The helicopter is drawn over the roofs, {@link HELICOPTER_HEIGHT} above the
 * ground the record says is under it, with a rotor that turns with the tick.
 *
 * The units are drawn where the record put them. They are stepped every tick
 * like the player, so nothing is evaluated between two ticks here.
 */
import { Color, Group, Matrix4, MeshStandardMaterial, Quaternion, Vector3, type InstancedMesh, type Material } from 'three';
import { HELICOPTER_HEIGHT } from '../../sim/police/police.ts';
import type { SimState } from '../../sim/simulation.ts';
import { rideHeight, specOf } from '../../sim/vehicles/vehicle.ts';
import { driverOf } from '../vehicles/occupant.ts';
import { PATROL_LEAVES, PatrolDoors } from './police-doors.ts';
import { boxOf, coloured, glassMaterial, instanced, merged, trafficParts, TRAFFIC_VIEW } from '../vehicles/traffic.ts';
import { createVehicleTrim, type VehicleTrim } from '../vehicles/vehicle-glow.ts';
import { GLASS, METAL, patrolBeacons, TYRE } from '../vehicles/vehicle-mesh.ts';
import { BeaconGlow, BeaconPhase, beaconMaterial, flashLit } from './beacons.ts';
import { tinted } from '../look/tint.ts';

/** Units of each mesh drawn at most, which is more than the force ever has out. */
const UNIT_CAP = 16;

/** Metres a lit half of the bar is grown by over the unlit one `vehicle-mesh.ts` draws, so the two never z-fight. */
const LENS_GROW = 0.012;

/** The body of the helicopter, its tail and the rotor over it, in metres. */
const HELI = { length: 5.5, height: 1.6, width: 1.6, tail: 4.2, rotor: 7 };

export class PoliceView {
  readonly group = new Group();
  private readonly paint: InstancedMesh;
  private readonly trim: InstancedMesh;
  private readonly glass: InstancedMesh;
  private readonly driver: InstancedMesh;
  private readonly doors: PatrolDoors;
  private readonly phases: [BeaconPhase, BeaconPhase];
  private readonly glow: BeaconGlow;
  private readonly heli: InstancedMesh;
  private readonly rotor: InstancedMesh;
  private readonly materials: Material[];
  private readonly trimMaterial: VehicleTrim;
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);
  private readonly colour = new Color();
  private readonly ride: number;

  constructor() {
    const spec = specOf('emergency');
    this.ride = rideHeight(spec);
    const parts = trafficParts(spec, PATROL_LEAVES);
    const paint = new MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 });
    const glass = glassMaterial();
    this.trimMaterial = createVehicleTrim();
    const trim = this.trimMaterial.material;
    const lamp = beaconMaterial();
    this.materials = [paint, lamp, glass];
    this.paint = tinted(instanced(parts.paint, paint, true, UNIT_CAP));
    this.trim = instanced(parts.trim, trim, false, UNIT_CAP);
    this.glass = instanced(parts.glass, glass, false, UNIT_CAP);
    this.driver = instanced(merged(driverOf(spec).map((part) => coloured(boxOf(part), part.colour))), trim, true, UNIT_CAP);
    this.doors = new PatrolDoors(spec, trim, glass, UNIT_CAP);
    const lenses = patrolBeacons(spec).map((beacon) => ({
      ...beacon,
      box: { ...beacon.box, length: beacon.box.length + LENS_GROW, height: beacon.box.height + LENS_GROW, width: beacon.box.width + LENS_GROW },
    }));
    this.phases = [new BeaconPhase(lenses, 0, lamp, UNIT_CAP), new BeaconPhase(lenses, 1, lamp, UNIT_CAP)];
    this.glow = new BeaconGlow(UNIT_CAP);
    this.heli = instanced(heliBody(), trim, true, UNIT_CAP);
    this.rotor = instanced(rotorBlades(), trim, false, UNIT_CAP);
    this.group.add(this.paint, this.trim, this.phases[0].mesh, this.phases[1].mesh, this.heli, this.rotor, this.glow.mesh);
    this.group.add(this.glass, this.driver, ...this.doors.meshes);
  }

  /**
   * How far on the headlamps and tail lights of the patrol cars are, 0 by day
   * and 1 after dark. The light bar flashes whenever a unit is out, day or
   * night; this only says how strongly its light shows on the road.
   */
  set lamps(amount: number) {
    this.trimMaterial.lamps.value = amount;
    this.glow.night = amount;
  }

  get lamps(): number {
    return this.trimMaterial.lamps.value;
  }

  /** How many units the last frame drew, the helicopter among them. */
  get drawn(): number {
    return this.paint.count + this.heli.count;
  }

  /** Draw the units round a place as the record left them on the last tick. */
  update(state: SimState, x: number, y: number): void {
    let cars = 0;
    let flying = 0;
    let crewed = 0;
    this.glow.begin();
    for (const unit of state.police.units) {
      if (Math.abs(unit.x - x) > TRAFFIC_VIEW || Math.abs(unit.y - y) > TRAFFIC_VIEW) continue;
      this.turn.setFromAxisAngle(this.up, -unit.heading);
      if (unit.kind === 'helicopter') {
        if (flying < UNIT_CAP) this.placeHeli(unit, flying++, state.tick);
        continue;
      }
      if (cars >= UNIT_CAP) continue;
      crewed = this.placeCar(unit, cars++, crewed, state.tick);
    }
    this.fill(cars, flying);
    this.driver.count = crewed;
    this.driver.visible = crewed > 0;
    if (crewed > 0) this.driver.instanceMatrix.needsUpdate = true;
  }

  /** Write the helicopter `unit` into instance `index`, and its rotor turned by the tick. `this.turn` holds its heading. */
  private placeHeli(unit: PoliceUnit, index: number, tick: number): void {
    this.at.set(unit.x, unit.height + HELICOPTER_HEIGHT, unit.y);
    this.matrix.compose(this.at, this.turn, this.one);
    this.heli.setMatrixAt(index, this.matrix);
    // The rotor turns a sixth of a revolution a tick, which reads as a blur.
    this.turn.setFromAxisAngle(this.up, tick / 6);
    this.at.set(unit.x, unit.height + HELICOPTER_HEIGHT + HELI.height / 2, unit.y);
    this.matrix.compose(this.at, this.turn, this.one);
    this.rotor.setMatrixAt(index, this.matrix);
  }

  /**
   * Write the patrol car `unit` into instance `index`, its driver into
   * instance `crewed` when it has one, and light its bar. `this.turn` holds
   * its heading. Returns how many drivers are written after it.
   */
  private placeCar(unit: PoliceUnit, index: number, crewed: number, tick: number): number {
    this.at.set(unit.x, unit.height + this.ride, unit.y);
    this.matrix.compose(this.at, this.turn, this.one);
    this.paint.setMatrixAt(index, this.matrix);
    this.trim.setMatrixAt(index, this.matrix);
    this.glass.setMatrixAt(index, this.matrix);
    this.doors.set(index, this.matrix, unit.doors);
    let drivers = crewed;
    if (unit.crew > 0) this.driver.setMatrixAt(drivers++, this.matrix);
    this.paint.setColorAt(index, this.colour.set(specOf('emergency').paint));
    // A car driving off once its call is over has its siren off, and its bar dark.
    const calling = unit.task !== 'leave';
    for (const phase of [0, 1] as const) {
      const lit = calling && flashLit(tick, unit.id, phase);
      this.phases[phase].set(index, this.matrix, lit);
      if (lit) this.glow.add(unit.x, unit.height, unit.y, this.phases[phase].colour);
    }
    return drivers;
  }

  dispose(): void {
    for (const mesh of [this.paint, this.trim, this.glass, this.driver, this.phases[0].mesh, this.phases[1].mesh, this.heli, this.rotor]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.doors.dispose();
    this.glow.dispose();
    for (const material of this.materials) material.dispose();
    this.trimMaterial.dispose();
    this.group.clear();
  }

  /** Show what was written this frame and hide the meshes that took nothing. */
  private fill(cars: number, flying: number): void {
    for (const phase of this.phases) phase.commit(cars);
    this.glow.commit();
    this.doors.commit(cars);
    for (const mesh of [this.paint, this.trim, this.glass]) {
      mesh.count = cars;
      mesh.visible = cars > 0;
      if (cars > 0) mesh.instanceMatrix.needsUpdate = true;
    }
    for (const mesh of [this.heli, this.rotor]) {
      mesh.count = flying;
      mesh.visible = flying > 0;
      if (flying > 0) mesh.instanceMatrix.needsUpdate = true;
    }
    if (cars > 0 && this.paint.instanceColor !== null) this.paint.instanceColor.needsUpdate = true;
  }
}

/** One police unit as the record holds it. */
type PoliceUnit = SimState['police']['units'][number];

/** The helicopter's hull: the cabin, the tail and the boom that carries it. */
function heliBody(): ReturnType<typeof merged> {
  const box = (length: number, height: number, width: number, x: number, y: number, colour: number) =>
    coloured(boxOf({ length, height, width, x, y, z: 0, colour }), colour);
  return merged([
    box(HELI.length, HELI.height, HELI.width, 0, 0, METAL),
    box(HELI.length * 0.45, HELI.height * 0.5, HELI.width * 0.95, HELI.length * 0.3, HELI.height * 0.1, GLASS),
    box(HELI.tail, 0.35, 0.35, -HELI.length / 2 - HELI.tail / 2, HELI.height * 0.2, METAL),
    box(0.4, 1.3, 0.2, -HELI.length / 2 - HELI.tail, HELI.height * 0.2 + 0.4, METAL),
    box(0.3, 0.7, 0.25, 0, -HELI.height / 2 - 0.35, TYRE),
  ]);
}

/** The rotor: two blades crossed, turned about the mast by the tick. */
function rotorBlades(): ReturnType<typeof merged> {
  const blade = (length: number, width: number) =>
    coloured(boxOf({ length, height: 0.08, width, x: 0, y: 0, z: 0, colour: TYRE }), TYRE);
  const across = blade(0.4, HELI.rotor);
  return merged([blade(HELI.rotor, 0.4), across]);
}

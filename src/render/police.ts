/**
 * The police, drawn (spec sections 9.2, 14).
 *
 * A police car is the patrol row of the roster, drawn the way the traffic is:
 * the painted boxes, the parts with colours of their own, and the outline of
 * spec section 10.1. On top of each one sits a light bar, one instance of a
 * fourth mesh, whose instance colour flips between red and blue on a beat of
 * the tick: that is what a player sees in the mirror before they see the car.
 *
 * The helicopter is drawn over the roofs, {@link HELICOPTER_HEIGHT} above the
 * ground the record says is under it, with a rotor that turns with the tick.
 *
 * The units are drawn where the record put them. They are stepped every tick
 * like the player, so nothing is evaluated between two ticks here.
 */
import { BackSide, BoxGeometry, Color, Group, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Quaternion, Vector3, type InstancedMesh, type Material } from 'three';
import { HELICOPTER_HEIGHT, type PoliceUnit } from '../sim/police.ts';
import type { SimState } from '../sim/simulation.ts';
import { rideHeight, specOf } from '../sim/vehicle.ts';
import { boxOf, coloured, instanced, merged, trafficParts, TRAFFIC_VIEW } from './traffic.ts';
import { OUTLINE, VEHICLE_OUTLINE_WIDTH } from './vehicle.ts';
import { createVehicleTrim, type VehicleTrim } from './vehicle-glow.ts';
import { GLASS, METAL, TYRE } from './vehicle-mesh.ts';
import { tinted } from './tint.ts';

/** Units of each mesh drawn at most, which is more than the force ever has out. */
const UNIT_CAP = 16;

/** The two colours of a light bar, and the ticks it holds each one for. */
const LIGHT_RED = 0xd8302a;
const LIGHT_BLUE = 0x2f6ad8;
const FLASH_TICKS = 12;

/** The bar across the roof: its size, and how far over the roof it sits. */
const BAR = { length: 0.3, height: 0.12, width: 1.1 };

/** The body of the helicopter, its tail and the rotor over it, in metres. */
const HELI = { length: 5.5, height: 1.6, width: 1.6, tail: 4.2, rotor: 7 };

export class PoliceView {
  readonly group = new Group();
  private readonly paint: InstancedMesh;
  private readonly trim: InstancedMesh;
  private readonly rim: InstancedMesh;
  private readonly bar: InstancedMesh;
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
  private readonly roof: number;

  constructor() {
    const spec = specOf('emergency');
    this.ride = rideHeight(spec);
    this.roof = spec.halfHeight * 2 + BAR.height / 2;
    const parts = trafficParts(spec);
    const paint = new MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 });
    this.trimMaterial = createVehicleTrim();
    const trim = this.trimMaterial.material;
    const lamp = new MeshBasicMaterial({ toneMapped: false });
    const outline = new MeshBasicMaterial({ color: new Color(OUTLINE), side: BackSide, fog: true });
    this.materials = [paint, lamp, outline];
    this.paint = tinted(instanced(parts.paint, paint, true, UNIT_CAP));
    this.trim = instanced(parts.trim, trim, false, UNIT_CAP);
    this.rim = instanced(parts.rim, outline, false, UNIT_CAP);
    this.bar = tinted(instanced(new BoxGeometry(BAR.length, BAR.height, BAR.width), lamp, false, UNIT_CAP));
    this.heli = instanced(heliBody(), trim, true, UNIT_CAP);
    this.rotor = instanced(rotorBlades(), trim, false, UNIT_CAP);
    this.group.add(this.paint, this.trim, this.rim, this.bar, this.heli, this.rotor);
  }

  /**
   * How far on the headlamps and tail lights of the patrol cars are, 0 by day
   * and 1 after dark. The light bar is not on this switch: it flashes whenever
   * a unit is out, day or night.
   */
  set lamps(amount: number) {
    this.trimMaterial.lamps.value = amount;
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
    for (const unit of state.police.units) {
      if (Math.abs(unit.x - x) > TRAFFIC_VIEW || Math.abs(unit.y - y) > TRAFFIC_VIEW) continue;
      this.turn.setFromAxisAngle(this.up, -unit.heading);
      if (unit.kind === 'helicopter') {
        if (flying >= UNIT_CAP) continue;
        this.at.set(unit.x, unit.height + HELICOPTER_HEIGHT, unit.y);
        this.matrix.compose(this.at, this.turn, this.one);
        this.heli.setMatrixAt(flying, this.matrix);
        // The rotor turns a sixth of a revolution a tick, which reads as a blur.
        this.turn.setFromAxisAngle(this.up, state.tick / 6);
        this.at.set(unit.x, unit.height + HELICOPTER_HEIGHT + HELI.height / 2, unit.y);
        this.matrix.compose(this.at, this.turn, this.one);
        this.rotor.setMatrixAt(flying, this.matrix);
        flying++;
        continue;
      }
      if (cars >= UNIT_CAP) continue;
      this.at.set(unit.x, unit.height + this.ride, unit.y);
      this.matrix.compose(this.at, this.turn, this.one);
      this.paint.setMatrixAt(cars, this.matrix);
      this.trim.setMatrixAt(cars, this.matrix);
      this.rim.setMatrixAt(cars, this.matrix);
      this.paint.setColorAt(cars, this.colour.set(specOf('emergency').paint));
      this.at.set(unit.x, unit.height + this.ride + this.roof, unit.y);
      this.matrix.compose(this.at, this.turn, this.one);
      this.bar.setMatrixAt(cars, this.matrix);
      // Every other unit is on the other beat, so a pair of cars flashes
      // against each other rather than in step.
      const beat = Math.floor(state.tick / FLASH_TICKS) + unit.id;
      this.bar.setColorAt(cars, this.colour.set(beat % 2 === 0 ? LIGHT_RED : LIGHT_BLUE));
      cars++;
    }
    this.fill(cars, flying);
  }

  dispose(): void {
    for (const mesh of [this.paint, this.trim, this.rim, this.bar, this.heli, this.rotor]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (const material of this.materials) material.dispose();
    this.trimMaterial.dispose();
    this.group.clear();
  }

  /** Show what was written this frame and hide the meshes that took nothing. */
  private fill(cars: number, flying: number): void {
    for (const mesh of [this.paint, this.trim, this.rim, this.bar]) {
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
    if (cars > 0 && this.bar.instanceColor !== null) this.bar.instanceColor.needsUpdate = true;
  }
}

/** The helicopter's hull: the cabin, the tail and the boom that carries it. */
export function heliBody(): ReturnType<typeof merged> {
  const box = (length: number, height: number, width: number, x: number, y: number, colour: number) =>
    coloured(boxOf({ length, height, width, x, y, z: 0, colour }, 0), colour);
  return merged([
    box(HELI.length, HELI.height, HELI.width, 0, 0, METAL),
    box(HELI.length * 0.45, HELI.height * 0.5, HELI.width * 0.95, HELI.length * 0.3, HELI.height * 0.1, GLASS),
    box(HELI.tail, 0.35, 0.35, -HELI.length / 2 - HELI.tail / 2, HELI.height * 0.2, METAL),
    box(0.4, 1.3, 0.2, -HELI.length / 2 - HELI.tail, HELI.height * 0.2 + 0.4, METAL),
    box(0.3, 0.7, 0.25, 0, -HELI.height / 2 - 0.35, TYRE),
  ]);
}

/** The rotor: two blades crossed, turned about the mast by the tick. */
export function rotorBlades(): ReturnType<typeof merged> {
  const blade = (length: number, width: number) =>
    coloured(boxOf({ length, height: 0.08, width, x: 0, y: 0, z: 0, colour: TYRE }, 0), TYRE);
  const across = blade(0.4, HELI.rotor);
  return merged([blade(HELI.rotor, 0.4), across]);
}

export { HELICOPTER_HEIGHT };

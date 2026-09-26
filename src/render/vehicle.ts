/**
 * The vehicle, drawn (spec sections 10.1, 11.3).
 *
 * The shape comes from `vehicle-mesh.ts`, one plan per class of the roster.
 * This turns that plan into a model: a mesh per box and a wheel per wheel of
 * the row. The ink line round it comes from the edge pass (`edges.ts`).
 *
 * The model reads the vehicle's serialisable state and nothing else, so what is
 * drawn is a function of the simulation record: the class decides the shape,
 * the body takes the chassis pose, and each wheel hangs at the length its
 * suspension came back with and turns by the angle the physics steered it to.
 * A class the record changes to — the debug picker of spec section 11.3, or a
 * loaded save — rebuilds the model on the next frame it is set from.
 *
 * The damage of spec section 11.3 is drawn the same way, off the same record:
 * a dented panel pushes the vertices of its boxes in, a panel torn off takes
 * its boxes out of the model, and a vehicle that has burned is repainted in
 * scorch. The vertices are moved rather than the geometry rebuilt, which is
 * what the spec means by per-instance offsets: a car is a couple of hundred
 * vertices and the offsets are recomputed only when the record's damage
 * actually changes.
 */
import {
  BoxGeometry,
  type BufferAttribute,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  type BufferGeometry,
  type Material,
} from 'three';
import { hashInts } from '../core/hash.ts';
import { PANELS, type DamageState, type Panel } from '../sim/damage.ts';
import {
  DEFAULT_CLASS,
  specOf,
  type VehicleClass,
  type VehicleSpec,
  type VehicleState,
  type WheelSpec,
  type WheelState,
} from '../sim/vehicle.ts';
import { partGeometry } from './vehicle-geometry.ts';
import { GLASS_OPACITY } from './vehicle-parts.ts';
import { glowOf } from './vehicle-glow.ts';
import { BONNET, TYRE, vehicleBoxes, type Hinge, type VehicleBox } from './vehicle-mesh.ts';

/** What a burnt-out shell is painted in (spec section 11.3). */
const SCORCH = 0x231f1e;

/**
 * Which way a panel is pushed when it is dented, in the vehicle's own frame.
 * A dent moves the struck face inward, so this is the direction of the blow.
 */
const PANEL_PUSH: Readonly<Record<Panel, [number, number, number]>> = {
  front: [-1, 0, 0],
  rear: [1, 0, 0],
  left: [0, 0, -1],
  right: [0, 0, 1],
  roof: [0, -1, 0],
};

/**
 * How deep a panel pushed all the way in goes, as a fraction of the smaller of
 * the vehicle's half width and half height. A dent any deeper than this reaches
 * through the body and out the far side.
 */
const DENT_DEPTH = 0.55;

/** One box of the model: the mesh and its pristine vertices. */
interface DrawnBox {
  part: VehicleBox;
  mesh: Mesh;
  /** The vertices it was built with, so every dent is measured from the same shape. */
  base: Float32Array;
  /** The paint it was built in, so a scorched model can be painted back. */
  colour: number;
  material: MeshStandardMaterial;
}

/** A wheel of the model, and the wheel of the record it hangs and turns with. */
interface DrawnWheel {
  object: Object3D;
  index: number;
}

/** Radians a second a rotor or a propeller turns at: fast enough to blur, slow enough not to strobe. */
const SPIN_RATE = 23;

/** Radians a door stands open at when it is all the way open; the boarding move opens it this far too. */
const DOOR_SWING = 1.15;
/** Radians the bonnet lifts at when it is all the way up. */
const BONNET_LIFT = 0.95;
/** How much of its own length a sliding door runs back, and how far it stands out as it goes. */
const SLIDE_BACK = 0.85;
const SLIDE_OUT = 0.08;

/** A part of a leaf, hung from its hinge, and how long it is for a door that slides. */
interface DrawnLeaf {
  hinge: Hinge;
  object: Group;
  length: number;
}

export class VehicleModel {
  readonly group = new Group();
  private spec: VehicleSpec;
  private readonly wheels: DrawnWheel[] = [];
  /** Every part of a door or of the bonnet, hung from its hinge. */
  private readonly hinges: DrawnLeaf[] = [];
  /** How far open the record says each leaf is, 0 shut and 1 open (`sim/doors.ts`). */
  private readonly open: number[] = [0, 0, 0, 0, 0];
  /** The door the boarding move holds open, and by how many radians. */
  private boarding = { leaf: -1, angle: 0 };
  /** The rotor and propeller blades, each hung from its own middle, and the axis it turns about. */
  private readonly spinners: { axis: 'rotor' | 'prop'; object: Group }[] = [];
  private readonly boxes: DrawnBox[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];
  /** The damage the model currently shows, so it is redrawn only when it changes. */
  private shown = '';
  /** How far on the vehicle's own headlamps and tail lights are (spec section 13.4). */
  private lit = 0;
  /** Whether the shell has burned, in which case nothing on it burns any more. */
  private scorched = false;

  constructor(cls: VehicleClass = DEFAULT_CLASS) {
    this.spec = specOf(cls);
    this.build();
  }

  /**
   * How far on the vehicle's headlamps and tail lights are, 0 by day and 1
   * after dark. It is the number the street lamps run off (`daylight.ts`), so
   * the car lights up with the street it stands in. The beams it throws on the
   * road are separate: those are the projector cones of `headlights.ts`.
   */
  set lamps(amount: number) {
    if (amount === this.lit) return;
    this.lit = amount;
    this.applyLamps();
  }

  get lamps(): number {
    return this.lit;
  }

  /** The row of the roster the model is currently built for. */
  get vehicle(): VehicleSpec {
    return this.spec;
  }

  /**
   * Put the model where the state says the vehicle is. Called once a frame.
   * A record that names another class is a different vehicle, so the model is
   * built again for it before it is placed.
   */
  set(v: VehicleState): void {
    if (v.cls !== this.spec.cls) {
      this.spec = specOf(v.cls);
      this.clear();
      this.build();
    }
    this.damage(v.damage, v.paint);
    for (let i = 0; i < this.open.length; i++) this.open[i] = v.leaves.open[i] ?? 0;
    this.swing();
    this.group.position.set(v.x, v.y, v.z);
    this.group.quaternion.set(v.qx, v.qy, v.qz, v.qw);
    for (const drawn of this.wheels) {
      const spec = this.spec.wheels[drawn.index] as WheelSpec;
      const state = v.wheels[drawn.index] as WheelState;
      // The suspension hangs the wheel below its mounting point on the chassis.
      // A vehicle the model draws one wheel per axle for hangs it between the
      // pair the physics stands on, which is the centreline.
      drawn.object.position.set(spec.x, spec.y - state.suspension, this.spec.inline ? 0 : spec.z);
      // Steer about the chassis' up axis, then roll on the axle.
      drawn.object.rotation.set(0, state.steer, state.rotation, 'YXZ');
    }
  }

  /**
   * Swing the front door on `side` — -1 the driver's, +1 the other — open by
   * `angle` radians, and shut the one across from it. The player getting in or
   * out is the one thing that opens a door (`boarding.ts`); 0 shuts both.
   */
  openDoor(side: number, angle: number): void {
    let leaf = -1;
    if (angle !== 0) leaf = side < 0 ? 0 : 1;
    this.boarding = { leaf, angle };
    this.swing();
  }

  /**
   * Turn every leaf to how far open it is: the record's amount, or the
   * boarding move's angle where that is further.
   */
  private swing(): void {
    for (const drawn of this.hinges) {
      const { hinge, object } = drawn;
      const open = this.open[hinge.leaf] ?? 0;
      if (hinge.axis === 'slide') {
        // A sliding door stands out from the flank and runs back along it.
        const side = Math.sign(hinge.z);
        object.position.set(hinge.x - open * drawn.length * SLIDE_BACK, hinge.y, hinge.z + side * SLIDE_OUT * Math.min(1, open * 4));
      } else if (hinge.leaf === BONNET) {
        // A turn about the axle axis lifts the bonnet's front edge.
        object.rotation.z = open * BONNET_LIFT;
      } else {
        // A turn about up carries the rear edge of the door out to its own side.
        const boarding = this.boarding.leaf === hinge.leaf ? this.boarding.angle : 0;
        object.rotation.y = Math.sign(hinge.z) * Math.max(open * DOOR_SWING, boarding);
      }
    }
  }

  /**
   * Turn the rotors and the propellers of an aircraft on by `dt` seconds. The
   * scene calls it with the frame's time while the player is at the controls,
   * and with 0 while they are not, so a parked aircraft's blades stand still.
   */
  spin(dt: number): void {
    const turn = dt * SPIN_RATE;
    for (const spinner of this.spinners) {
      if (spinner.axis === 'rotor') spinner.object.rotation.y += turn;
      else spinner.object.rotation.x += turn;
    }
  }

  dispose(): void {
    this.clear();
  }

  /** Take the current model apart and release everything it holds. */
  private clear(): void {
    this.group.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.wheels.length = 0;
    this.hinges.length = 0;
    this.spinners.length = 0;
    this.boxes.length = 0;
    this.shown = '';
  }

  private build(): void {
    for (const part of vehicleBoxes(this.spec)) {
      const material = new MeshStandardMaterial({ color: part.colour, roughness: 0.45, metalness: 0.2 });
      if (part.glass === true) {
        material.transparent = true;
        material.opacity = GLASS_OPACITY;
        material.roughness = 0.1;
      }
      this.materials.push(material);
      const mesh = this.add(part, material);
      if (part.hinge !== undefined) this.hang(part, part.hinge, mesh);
      if (part.spin !== undefined) this.pivot(part, part.spin, mesh);
      this.boxes.push({ part, mesh, base: pristine(mesh), colour: part.colour, material });
    }
    this.buildWheels();
    this.applyLamps();
  }

  /**
   * Burn the lamps of the model at the amount last set. The intensity is a
   * uniform of the material, so a lamp coming on at dusk compiles nothing; a
   * burnt-out shell burns nothing at all.
   */
  private applyLamps(): void {
    for (const drawn of this.boxes) {
      const glow = glowOf(drawn.colour);
      if (glow === 0) continue;
      drawn.material.emissive.set(drawn.colour);
      drawn.material.emissiveIntensity = this.scorched ? 0 : glow * this.lit;
    }
  }

  /**
   * Draw the damage the record carries (spec section 11.3): the dents, the
   * panels that have gone, the scorch of a vehicle that has burned, and the
   * colour its body is painted (spec section 16.1).
   *
   * It is redrawn only when the record's damage changes, because a car that is
   * merely being driven has nothing to redraw and a frame should not pay for
   * one.
   */
  private damage(damage: DamageState, paint: number): void {
    const key = `${damage.stage}|${damage.dents.map((dent) => dent.toFixed(3)).join(',')}|${damage.lost.join(',')}|${paint}`;
    if (key === this.shown) return;
    this.shown = key;
    const depth = Math.min(this.spec.halfWidth, this.spec.halfHeight) * DENT_DEPTH;
    const scorched = damage.stage === 'burnt';
    this.scorched = scorched;
    this.applyLamps();
    for (let i = 0; i < this.boxes.length; i++) {
      const drawn = this.boxes[i] as DrawnBox;
      const panel = drawn.part.panel;
      const index = panel === undefined ? -1 : PANELS.indexOf(panel);
      const gone = index >= 0 && (damage.lost[index] as boolean);
      drawn.mesh.visible = !gone;
      // A respray (spec section 16.1) changes the body and nothing else, so it
      // reaches the boxes the roster painted in the class's own colour.
      const colour = drawn.colour === this.spec.paint ? paint : drawn.colour;
      drawn.material.color.set(scorched ? SCORCH : colour);
      if (gone) continue;
      crumple(drawn.mesh, drawn.base, damage.dents, depth, i);
    }
  }

  /** One box of the plan, in the material it is handed. It casts a shadow. */
  private add(part: VehicleBox, material: Material): Mesh {
    const geometry = partGeometry(part);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(part.x, part.y, part.z);
    mesh.castShadow = part.glass !== true;
    this.geometries.push(geometry);
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Hang a part of a door or of the bonnet from a group at its hinge, so
   * turning the group swings the leaf. The part's own vertices are untouched,
   * so a dent lands on it the same open or shut.
   */
  private hang(part: VehicleBox, hinge: Hinge, mesh: Mesh): void {
    const object = new Group();
    object.name = 'door';
    object.position.set(hinge.x, hinge.y, hinge.z);
    object.add(mesh);
    mesh.position.set(part.x - hinge.x, part.y - hinge.y, part.z - hinge.z);
    this.group.add(object);
    this.hinges.push({ hinge, object, length: part.length });
  }

  /** Hang a blade from a group at its own middle, so turning the group spins it in place. */
  private pivot(part: VehicleBox, axis: 'rotor' | 'prop', mesh: Mesh): void {
    const pivot = new Group();
    pivot.position.set(part.x, part.y, part.z);
    pivot.add(mesh);
    mesh.position.set(0, 0, 0);
    this.group.add(pivot);
    this.spinners.push({ axis, object: pivot });
  }

  /** A tyre and a hub per wheel of the row, sharing one geometry and one material. */
  private buildWheels(): void {
    const spec = this.spec;
    if (spec.wheels.length === 0) return;
    const tyre = new CylinderGeometry(spec.wheelRadius, spec.wheelRadius, spec.wheelWidth, 14);
    // The cylinder is built along y; the axle runs across the car, along z.
    tyre.rotateX(Math.PI / 2);
    const rubber = new MeshStandardMaterial({ color: TYRE, roughness: 0.9 });
    const hub = new BoxGeometry(spec.wheelRadius * 0.9, spec.wheelRadius * 0.9, spec.wheelWidth * 1.05);
    const chrome = new MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.7 });
    this.geometries.push(tyre, hub);
    this.materials.push(rubber, chrome);
    for (let i = 0; i < spec.wheels.length; i++) {
      const wheel = spec.wheels[i] as WheelSpec;
      // A vehicle that rides on one wheel per axle is drawn with one: the far
      // half of each pair the physics stands on is not there to be seen.
      if (spec.inline && wheel.z < 0) continue;
      const group = new Group();
      group.position.set(wheel.x, wheel.y - spec.suspensionRest, spec.inline ? 0 : wheel.z);
      for (const mesh of [new Mesh(tyre, rubber), new Mesh(hub, chrome)]) {
        // A spoke box on the hub, so a turning wheel is visibly turning.
        mesh.castShadow = true;
        group.add(mesh);
      }
      this.wheels.push({ object: group, index: i });
      this.group.add(group);
    }
  }
}

/** The vertices a mesh was built with, kept so every dent is measured from the same shape. */
function pristine(mesh: Mesh): Float32Array {
  return Float32Array.from((mesh.geometry.getAttribute('position') as BufferAttribute).array);
}

/**
 * Push the dented faces of a box in (spec section 11.3).
 *
 * A dent moves only the vertices on the face the blow landed on, so the box
 * crumples rather than shrinking, and every box of the vehicle takes it: the
 * nose of the shell is pushed back by the same blow that pushes in the bonnet
 * standing on it. Each vertex moves by its own fraction of the depth, taken
 * from a hash of where it is in the model, so the panel comes out torn rather
 * than pressed flat; the same hash always gives the same crumple, so a saved
 * car reloads with the dents it had.
 */
function crumple(mesh: Mesh, base: Float32Array, dents: readonly number[], depth: number, index: number): void {
  const position = mesh.geometry.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < base.length; i += 3) {
    const x = base[i] as number;
    const y = base[i + 1] as number;
    const z = base[i + 2] as number;
    let ox = 0;
    let oy = 0;
    let oz = 0;
    for (let p = 0; p < PANELS.length; p++) {
      const dent = dents[p] as number;
      if (dent <= 0) continue;
      const [px, py, pz] = PANEL_PUSH[PANELS[p] as Panel];
      // The struck face is the one the blow points away from. Everything behind
      // it holds its place, which is what keeps the box a box.
      if (x * -px + y * -py + z * -pz <= 0) continue;
      const bite = dent * depth * (0.45 + 0.55 * (hashInts(index, i, p) / 0x1_0000_0000));
      ox += px * bite;
      oy += py * bite;
      oz += pz * bite;
    }
    position.setXYZ(i / 3, x + ox, y + oy, z + oz);
  }
  position.needsUpdate = true;
  // A box has a vertex per corner per face, so this is the flat shading the
  // undented box already had, taken off the faces the dent has moved.
  mesh.geometry.computeVertexNormals();
}

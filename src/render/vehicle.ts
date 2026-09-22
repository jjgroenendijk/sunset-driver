/**
 * The vehicle, drawn (spec sections 10.1, 11.3).
 *
 * The shape comes from `vehicle-mesh.ts`, one plan per class of the roster.
 * This turns that plan into a model: a mesh per box, a wheel per wheel of the
 * row, and the outline of spec section 10.1 round the masses that make the
 * silhouette.
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
  BackSide,
  BoxGeometry,
  type BufferAttribute,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
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
import { glowOf } from './vehicle-glow.ts';
import { TYRE, vehicleBoxes, type VehicleBox } from './vehicle-mesh.ts';

/** The dark of the outline, as the buildings' is (spec section 10.1). */
export const OUTLINE = 0x150f12;

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

/** One box of the model: the mesh, the outline round it, and its pristine vertices. */
interface DrawnBox {
  part: VehicleBox;
  mesh: Mesh;
  /** The shell that rims it, on the masses that carry an outline. */
  rim: Mesh | undefined;
  /** The vertices it was built with, so every dent is measured from the same shape. */
  base: Float32Array;
  rimBase: Float32Array | undefined;
  /** The paint it was built in, so a scorched model can be painted back. */
  colour: number;
  material: MeshStandardMaterial;
}

/**
 * Metres the outline stands outside the box it rims. A vehicle is two metres
 * across and a building fifty, so this is a tenth of the buildings' width: the
 * same line on screen from the same camera.
 */
export const VEHICLE_OUTLINE_WIDTH = 0.035;

/** A wheel of the model, and the wheel of the record it hangs and turns with. */
interface DrawnWheel {
  object: Object3D;
  index: number;
}

export class VehicleModel {
  readonly group = new Group();
  private spec: VehicleSpec;
  private readonly wheels: DrawnWheel[] = [];
  /** The front door on each side that swings, hung from its front edge, by the side it is on. */
  private readonly hinges: { side: number; object: Group }[] = [];
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
    for (const hinge of this.hinges) {
      // A turn about up carries the rear edge of the door out to its own side.
      hinge.object.rotation.y = hinge.side === Math.sign(side) ? hinge.side * angle : 0;
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
    this.boxes.length = 0;
    this.shown = '';
  }

  private build(): void {
    const outline = new MeshBasicMaterial({ color: new Color(OUTLINE), side: BackSide, fog: true });
    this.materials.push(outline);
    for (const part of vehicleBoxes(this.spec)) {
      const material = new MeshStandardMaterial({ color: part.colour, roughness: 0.45, metalness: 0.2 });
      this.materials.push(material);
      const mesh = this.add(part, material);
      mesh.castShadow = true;
      // The outline is the same box grown by the width of the line and drawn
      // back faces only, so it rims the mass instead of hiding it.
      const rim = part.outlined ? this.add(grown(part, VEHICLE_OUTLINE_WIDTH), outline) : undefined;
      if (part.hinged === true) this.hang(part, mesh, rim);
      this.boxes.push({
        part,
        mesh,
        rim,
        base: pristine(mesh),
        rimBase: rim === undefined ? undefined : pristine(rim),
        colour: part.colour,
        material,
      });
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
      if (drawn.rim !== undefined) drawn.rim.visible = !gone;
      // A respray (spec section 16.1) changes the body and nothing else, so it
      // reaches the boxes the roster painted in the class's own colour.
      const colour = drawn.colour === this.spec.paint ? paint : drawn.colour;
      drawn.material.color.set(scorched ? SCORCH : colour);
      if (gone) continue;
      crumple(drawn.mesh, drawn.base, damage.dents, depth, i);
      if (drawn.rim !== undefined && drawn.rimBase !== undefined) {
        crumple(drawn.rim, drawn.rimBase, damage.dents, depth, i);
      }
    }
  }

  /**
   * One box of the plan, in the material it is handed.
   *
   * An outline casts no shadow. It is the mass it rims grown by a few
   * centimetres, so its shadow is the body's shadow again, drawn twice and a
   * little too big.
   */
  private add(part: VehicleBox, material: Material): Mesh {
    const geometry = new BoxGeometry(part.length, part.height, part.width);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(part.x, part.y, part.z);
    mesh.castShadow = false;
    this.geometries.push(geometry);
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Hang a door from a group at its front edge, so turning the group swings
   * the door. The door's own vertices are untouched, so a dent lands on it
   * the same open or shut.
   */
  private hang(part: VehicleBox, mesh: Mesh, rim: Mesh | undefined): void {
    const hinge = new Group();
    hinge.name = 'door';
    hinge.position.set(part.x + part.length / 2, part.y, part.z);
    for (const piece of rim === undefined ? [mesh] : [mesh, rim]) {
      hinge.add(piece);
      piece.position.set(-part.length / 2, 0, 0);
    }
    this.group.add(hinge);
    this.hinges.push({ side: Math.sign(part.z), object: hinge });
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

/** The same box, `reach` metres larger on every side. */
function grown(part: VehicleBox, reach: number): VehicleBox {
  return {
    ...part,
    length: part.length + 2 * reach,
    height: part.height + 2 * reach,
    width: part.width + 2 * reach,
  };
}

/**
 * The parts a shop's room is built from, merged into a few meshes.
 *
 * A furnished café is several hundred boxes and cylinders: floorboards,
 * bricks, chair legs, bottles. One mesh each would be several hundred draw
 * calls for one room, so the kit collects the parts by material and merges
 * each material's parts into one geometry when the room is done. A room is
 * built once, when the player walks in, so the merge costs nothing a frame.
 *
 * Every surface gives off a little of its own colour, tinted by the room's
 * light. A room stands in the shadow of its own building, and a real light in
 * it would be the first point light of the scene: the clustered lighting would
 * then rebuild the shader of every lit thing in the city on the first step
 * through a door. A lamp is therefore a surface that glows hard, which the
 * bloom of the post chain turns into light.
 *
 * Everything is placed in the room's own frame: `x` across the front, `y` up
 * from the floor and `z` out towards the door.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** How a part is shaded: a plain surface, a lamp that glows, or a pane of glass. */
export type Finish = 'matte' | 'lamp' | 'glass';

/** How much of its own colour a lamp gives off, well past what bloom picks up. */
const LAMP_GLOW = 2.4;

/** How much of the room shows through a pane of glass. */
const GLASS_OPACITY = 0.16;

/** A rotation about the vertical axis, and about the other two, for a part that is turned. */
export interface Turn {
  x?: number;
  y?: number;
  z?: number;
}

const scratchMatrix = new Matrix4();
const scratchQuaternion = new Quaternion();
const scratchEuler = new Euler();
const scratchScale = new Vector3(1, 1, 1);
const scratchPosition = new Vector3();

/** The parts of one room, by material, until {@link RoomKit.build} merges them. */
export class RoomKit {
  /** How much of its own colour a matte surface gives off. */
  glow: number;
  /** The colour of the room's light, which tints what every surface gives off. */
  readonly light: Color;
  private readonly parts = new Map<string, { finish: Finish; colour: number; geometries: BufferGeometry[] }>();

  constructor(glow: number, light: number) {
    this.glow = glow;
    this.light = new Color(light);
  }

  /** A box `w` across, `h` high and `d` deep, its middle at `(x, y, z)`. */
  box(w: number, h: number, d: number, x: number, y: number, z: number, colour: number, finish: Finish = 'matte', turn?: Turn): void {
    this.put(new BoxGeometry(w, h, d), x, y, z, colour, finish, turn);
  }

  /** A box standing on the floor or a shelf: its bottom at `y` rather than its middle. */
  block(w: number, h: number, d: number, x: number, y: number, z: number, colour: number, finish: Finish = 'matte', turn?: Turn): void {
    this.box(w, h, d, x, y + h / 2, z, colour, finish, turn);
  }

  /** An upright cylinder, its bottom at `y`. */
  cylinder(top: number, bottom: number, h: number, x: number, y: number, z: number, colour: number, finish: Finish = 'matte', sides = 12): void {
    this.put(new CylinderGeometry(top, bottom, h, sides), x, y + h / 2, z, colour, finish);
  }

  /** A cylinder turned any way, its middle at `(x, y, z)`. */
  rod(radius: number, h: number, x: number, y: number, z: number, colour: number, turn: Turn, finish: Finish = 'matte'): void {
    this.put(new CylinderGeometry(radius, radius, h, 8), x, y, z, colour, finish, turn);
  }

  /** A ball, its middle at `(x, y, z)`, squashed on its vertical axis by `squash`. */
  ball(radius: number, x: number, y: number, z: number, colour: number, finish: Finish = 'matte', squash = 1): void {
    // A lamp is smooth: the outline pass draws the crease between two facets.
    const geometry = finish === 'lamp' ? new SphereGeometry(radius, 24, 16) : new SphereGeometry(radius, 12, 8);
    if (squash !== 1) geometry.scale(1, squash, 1);
    this.put(geometry, x, y, z, colour, finish);
  }

  /** A ring, lying in the plane the turn gives it. */
  ring(radius: number, tube: number, x: number, y: number, z: number, colour: number, turn: Turn, finish: Finish = 'matte'): void {
    this.put(new TorusGeometry(radius, tube, 6, 20), x, y, z, colour, finish, turn);
  }

  /** Merge the parts into one mesh a material, and hand them over with what they are made of. */
  build(): { group: Group; geometries: BufferGeometry[]; materials: Material[] } {
    const group = new Group();
    const geometries: BufferGeometry[] = [];
    const materials: Material[] = [];
    for (const part of this.parts.values()) {
      const merged = mergeParts(part.geometries);
      if (merged === null) continue;
      const material = this.material(part.finish, part.colour);
      const mesh = new Mesh(merged, material);
      mesh.renderOrder = part.finish === 'glass' ? 1 : 0;
      group.add(mesh);
      geometries.push(merged);
      materials.push(material);
    }
    this.parts.clear();
    return { group, geometries, materials };
  }

  private put(geometry: BufferGeometry, x: number, y: number, z: number, colour: number, finish: Finish, turn?: Turn): void {
    // Every part has to carry the same attributes to merge, and a torus and a
    // box both have position, normal and uv, and an index.
    scratchEuler.set(turn?.x ?? 0, turn?.y ?? 0, turn?.z ?? 0, 'YXZ');
    scratchQuaternion.setFromEuler(scratchEuler);
    scratchMatrix.compose(scratchPosition.set(x, y, z), scratchQuaternion, scratchScale);
    geometry.applyMatrix4(scratchMatrix);
    const key = `${finish}|${colour}`;
    let part = this.parts.get(key);
    if (part === undefined) {
      part = { finish, colour, geometries: [] };
      this.parts.set(key, part);
    }
    part.geometries.push(geometry);
  }

  private material(finish: Finish, colour: number): MeshStandardMaterial {
    const base = new Color(colour);
    if (finish === 'lamp') {
      return new MeshStandardMaterial({ color: base, emissive: base, emissiveIntensity: LAMP_GLOW, roughness: 0.5 });
    }
    if (finish === 'glass') {
      return new MeshStandardMaterial({
        color: base,
        roughness: 0.05,
        metalness: 0.1,
        transparent: true,
        opacity: GLASS_OPACITY,
        depthWrite: false,
      });
    }
    return new MeshStandardMaterial({
      color: base,
      roughness: 0.8,
      emissive: base.clone().multiply(this.light),
      emissiveIntensity: this.glow,
    });
  }
}

/** The parts of one material as one geometry, letting the parts go once they are merged. */
function mergeParts(parts: BufferGeometry[]): BufferGeometry | null {
  if (parts.length === 1) return parts[0] ?? null;
  const merged = mergeGeometries(parts);
  for (const geometry of parts) geometry.dispose();
  return merged;
}

/**
 * The parts a shop's room is built from, merged into a few meshes.
 *
 * A furnished café is several hundred boxes and cylinders: floorboards,
 * bricks, chair legs, bottles. One mesh each would be several hundred draw
 * calls for one room, so the kit collects the parts by finish, writes each
 * part's colour into its vertices, and merges each finish into one geometry
 * when the room is done: a room is three draws or so, however it is fitted
 * out. A room is built once, when the player comes near it, so the merge
 * costs nothing a frame.
 *
 * The parts of the lid — the ceiling and what hangs from it — are merged
 * apart from the rest, so the lid can be lifted off for a camera that looks
 * down into the room (`interior.ts`).
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
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, vec3 } from '../tsl.ts';

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
const scratchColour = new Color();

/** Which part of the room a part belongs to: the room itself, or its lid. */
export type Layer = 'room' | 'lid';

/** What {@link RoomKit.build} hands over: the room, its lid, and what they are made of. */
export interface BuiltRoom {
  group: Group;
  lid: Group;
  geometries: BufferGeometry[];
  materials: Material[];
}

/** The parts of one room, by finish, until {@link RoomKit.build} merges them. */
export class RoomKit {
  /** How much of its own colour a matte surface gives off. */
  glow: number;
  /** The colour of the room's light, which tints what every surface gives off. */
  readonly light: Color;
  /** The layer the parts laid now go into. `room-shell.ts` lays the lid under `lid`. */
  layer: Layer = 'room';
  /** What every opaque material is given once it is made: the cut of `cutaway.ts`. */
  private readonly dress: ((material: MeshStandardNodeMaterial) => void) | undefined;
  private readonly parts = new Map<string, { finish: Finish; layer: Layer; geometries: BufferGeometry[] }>();

  constructor(glow: number, light: number, dress?: (material: MeshStandardNodeMaterial) => void) {
    this.glow = glow;
    this.light = new Color(light);
    this.dress = dress;
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

  /**
   * Merge the parts into one mesh a finish and a layer, and hand them over
   * with what they are made of. The lid is a child of the room's group.
   */
  build(): BuiltRoom {
    const group = new Group();
    const lid = new Group();
    group.add(lid);
    const geometries: BufferGeometry[] = [];
    const materials = new Map<Finish, MeshStandardNodeMaterial>();
    for (const part of this.parts.values()) {
      const merged = mergeParts(part.geometries);
      if (merged === null) continue;
      let material = materials.get(part.finish);
      if (material === undefined) {
        material = this.material(part.finish);
        materials.set(part.finish, material);
      }
      const mesh = new Mesh(merged, material);
      mesh.renderOrder = part.finish === 'glass' ? 1 : 0;
      (part.layer === 'lid' ? lid : group).add(mesh);
      geometries.push(merged);
    }
    this.parts.clear();
    return { group, lid, geometries, materials: [...materials.values()] };
  }

  private put(geometry: BufferGeometry, x: number, y: number, z: number, colour: number, finish: Finish, turn?: Turn): void {
    // Every part has to carry the same attributes to merge, and a torus and a
    // box both have position, normal and uv, and an index.
    scratchEuler.set(turn?.x ?? 0, turn?.y ?? 0, turn?.z ?? 0, 'YXZ');
    scratchQuaternion.setFromEuler(scratchEuler);
    scratchMatrix.compose(scratchPosition.set(x, y, z), scratchQuaternion, scratchScale);
    geometry.applyMatrix4(scratchMatrix);
    // The colour rides in the vertices, so every part of one finish shares a
    // material and merges into one draw.
    scratchColour.set(colour);
    const count = geometry.getAttribute('position').count;
    const colours = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) scratchColour.toArray(colours, i * 3);
    geometry.setAttribute('color', new BufferAttribute(colours, 3));
    const key = `${this.layer}|${finish}`;
    let part = this.parts.get(key);
    if (part === undefined) {
      part = { finish, layer: this.layer, geometries: [] };
      this.parts.set(key, part);
    }
    part.geometries.push(geometry);
  }

  private material(finish: Finish): MeshStandardNodeMaterial {
    const colour = attribute('color', 'vec3');
    if (finish === 'glass') {
      const glass = new MeshStandardNodeMaterial({
        roughness: 0.05,
        metalness: 0.1,
        transparent: true,
        opacity: GLASS_OPACITY,
        depthWrite: false,
      });
      glass.vertexColors = true;
      return glass;
    }
    const material = new MeshStandardNodeMaterial({ roughness: finish === 'lamp' ? 0.5 : 0.8 });
    material.vertexColors = true;
    // A lamp gives off its own colour hard; every other surface a little of
    // it, tinted by the room's light.
    const light = vec3(this.light.r, this.light.g, this.light.b);
    material.emissiveNode = finish === 'lamp' ? colour.mul(LAMP_GLOW) : colour.mul(light).mul(this.glow);
    this.dress?.(material);
    return material;
  }
}

/** The parts of one material as one geometry, letting the parts go once they are merged. */
function mergeParts(parts: BufferGeometry[]): BufferGeometry | null {
  if (parts.length === 1) return parts[0] ?? null;
  const merged = mergeGeometries(parts);
  for (const geometry of parts) geometry.dispose();
  return merged;
}

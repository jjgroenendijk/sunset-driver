/**
 * The things standing on the occupied corners of spec section 20.1, drawn: a
 * busker's amp, a food cart under its umbrella, a market stall under its
 * awning, and a dog on its lead.
 *
 * The people of a corner are drawn with the crowd (`pedestrians.ts`); these
 * are the props round them. Each is grown from boxes, as the bus stops are
 * (`bus-stops.ts`), and drawn as instances of one geometry each, so every
 * corner in view costs four draws however many there are. A prop's frame has
 * `+x` at the road and `+y` up from the pavement.
 */
import { Group, Matrix4, MeshStandardMaterial, Quaternion, Vector3, type BufferGeometry, type InstancedMesh } from 'three';
import type { CornerProp, PlacedProp, StreetCorners } from '../sim/corners.ts';
import { boxOf, coloured, instanced, merged, TRAFFIC_VIEW } from './traffic.ts';
import { METAL } from './vehicle-mesh.ts';

/** Metres each way of the point the frame is drawn round that props are drawn in. */
export const CORNER_VIEW = TRAFFIC_VIEW;

/** Props of one kind drawn at most. */
export const CORNER_DRAW_CAP = 64;

/** One box of a prop: its size along, up and across, and its middle. */
type Box = readonly [length: number, height: number, width: number, x: number, y: number, z: number, colour: number];

const WOOD = 0x6b4a2f;
const CANVAS = 0xc9412f;
const STRIPE = 0xf1ece0;
const STEEL = 0xb8bcc2;
const DARK = 0x1d1e22;

/** The boxes of each prop. */
export const PROP_BOXES: Record<CornerProp, readonly Box[]> = {
  // A small practice amp on the pavement, its grille to the road.
  amp: [
    [0.26, 0.34, 0.42, 0, 0.17, 0, DARK],
    [0.02, 0.22, 0.34, 0.135, 0.18, 0, 0x3a3a3a],
  ],
  // A steel cart on two wheels, with a striped umbrella over it.
  cart: [
    [0.8, 0.85, 1.7, 0, 0.55, 0, STEEL],
    [0.84, 0.05, 1.74, 0, 0.99, 0, METAL],
    [0.1, 0.3, 0.3, 0, 0.15, 0.7, DARK],
    [0.1, 0.3, 0.3, 0, 0.15, -0.7, DARK],
    [0.04, 1.2, 0.04, 0, 1.6, 0, METAL],
    [1.9, 0.08, 1.9, 0, 2.2, 0, CANVAS],
    [1.4, 0.1, 1.4, 0, 2.18, 0, STRIPE],
  ],
  // A trestle table under an awning, with goods on it.
  stall: [
    [0.9, 0.06, 2, 0, 0.8, 0, WOOD],
    [0.06, 0.8, 0.06, 0.4, 0.4, 0.95, WOOD],
    [0.06, 0.8, 0.06, -0.4, 0.4, 0.95, WOOD],
    [0.06, 0.8, 0.06, 0.4, 0.4, -0.95, WOOD],
    [0.06, 0.8, 0.06, -0.4, 0.4, -0.95, WOOD],
    [0.5, 0.18, 0.5, 0, 0.92, 0.55, 0x7e9b3a],
    [0.5, 0.14, 0.6, 0, 0.9, -0.5, 0xd9a13a],
    [0.05, 2.1, 0.05, -0.45, 1.05, 1, METAL],
    [0.05, 2.1, 0.05, -0.45, 1.05, -1, METAL],
    [1.3, 0.05, 2.2, 0.15, 2.1, 0, STRIPE],
  ],
  // A mid-sized dog, standing, facing the way the prop faces.
  dog: [
    [0.55, 0.22, 0.2, 0, 0.42, 0, 0x8a6a45],
    [0.2, 0.18, 0.16, 0.34, 0.56, 0, 0x8a6a45],
    [0.1, 0.07, 0.1, 0.47, 0.52, 0, 0x2a2018],
    [0.06, 0.32, 0.06, 0.2, 0.16, 0.06, 0x7a5a38],
    [0.06, 0.32, 0.06, 0.2, 0.16, -0.06, 0x7a5a38],
    [0.06, 0.32, 0.06, -0.2, 0.16, 0.06, 0x7a5a38],
    [0.06, 0.32, 0.06, -0.2, 0.16, -0.06, 0x7a5a38],
    [0.18, 0.04, 0.04, -0.34, 0.55, 0, 0x7a5a38],
  ],
};

const KINDS: readonly CornerProp[] = ['amp', 'cart', 'stall', 'dog'];

/** The geometry of one prop, with its colours on its vertices. */
export function propGeometry(kind: CornerProp): BufferGeometry {
  return merged(
    PROP_BOXES[kind].map(([length, height, width, x, y, z, colour]) => coloured(boxOf({ length, height, width, x, y, z, colour }, 0), colour)),
  );
}

export class CornerPropView {
  readonly group = new Group();
  private readonly corners: StreetCorners;
  private readonly meshes: Record<CornerProp, InstancedMesh>;
  private readonly material: MeshStandardMaterial;
  private readonly found: PlacedProp[] = [];
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);

  constructor(corners: StreetCorners) {
    this.corners = corners;
    this.material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05 });
    const mesh = (kind: CornerProp): InstancedMesh => instanced(propGeometry(kind), this.material, true, CORNER_DRAW_CAP);
    this.meshes = { amp: mesh('amp'), cart: mesh('cart'), stall: mesh('stall'), dog: mesh('dog') };
    for (const kind of KINDS) this.group.add(this.meshes[kind]);
  }

  /** How many props the last frame drew. */
  get drawn(): number {
    let count = 0;
    for (const kind of KINDS) count += this.meshes[kind].count;
    return count;
  }

  /** Stand the props of every corner out round a place at a moment. */
  update(tick: number, x: number, y: number): void {
    const found = this.corners.props(x - CORNER_VIEW, y - CORNER_VIEW, x + CORNER_VIEW, y + CORNER_VIEW, tick, this.found);
    for (const kind of KINDS) this.meshes[kind].count = 0;
    for (let i = 0; i < found; i++) {
      const prop = this.found[i] as PlacedProp;
      const mesh = this.meshes[prop.kind];
      if (mesh.count >= CORNER_DRAW_CAP) continue;
      this.at.set(prop.x, prop.height, prop.y);
      this.turn.setFromAxisAngle(this.up, -prop.heading);
      this.matrix.compose(this.at, this.turn, this.one);
      mesh.setMatrixAt(mesh.count++, this.matrix);
    }
    for (const kind of KINDS) {
      const mesh = this.meshes[kind];
      mesh.visible = mesh.count > 0;
      if (mesh.count > 0) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const kind of KINDS) {
      this.meshes[kind].geometry.dispose();
      this.meshes[kind].dispose();
    }
    this.material.dispose();
    this.group.clear();
  }
}

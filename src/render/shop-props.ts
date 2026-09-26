/**
 * The small things a shop counter sells, drawn for the turning preview of the
 * shop panel: the food, the care, the needle exchange's kits, a box of rounds,
 * a house for the broker and a wrench for the repair.
 *
 * Each one is a few primitives at no particular scale. The preview frames what
 * it is given, so a coffee cup and a house fill the window alike. Nothing here
 * is drawn in the city, so nothing is merged or batched: a prop is a handful
 * of meshes that live while their row is on screen.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import type { PropId } from '../sim/shop-goods.ts';

const BREAD = 0xd9a45a;
const WHITE = 0xf2ede6;
const STEEL = 0xb8bcc2;
const DARK = 0x2a2320;
const BRASS = 0xc19a53;

/** The meshes of one prop, and what they are made of, so all of it can be let go at once. */
export class Prop {
  readonly group = new Group();
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials = new Map<number, MeshStandardMaterial>();

  /** Put a part of the prop in: its shape, its colour, and where it stands. */
  add(geometry: BufferGeometry, colour: number, x = 0, y = 0, z = 0): Mesh {
    this.geometries.push(geometry);
    let material = this.materials.get(colour);
    if (material === undefined) {
      material = new MeshStandardMaterial({ color: colour, roughness: 0.6, metalness: 0.05 });
      this.materials.set(colour, material);
    }
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    return mesh;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.group.clear();
  }
}

/** Build the prop a row of a counter shows, in the colour its row gives it. */
export function buildProp(id: PropId, colour: number): Prop {
  const prop = new Prop();
  BUILDERS[id](prop, colour);
  return prop;
}

const BUILDERS: Readonly<Record<PropId, (p: Prop, colour: number) => void>> = {
  ammo: (p, colour) => {
    p.add(new BoxGeometry(1.4, 0.6, 0.9), 0x3b4a2a, 0, 0.3, 0);
    p.add(new BoxGeometry(1.44, 0.12, 0.94), colour, 0, 0.62, 0);
    for (let i = 0; i < 4; i++) bullet(p, -0.45 + i * 0.3, 0.68, 0.7);
  },
  coffee: (p, colour) => {
    p.add(new CylinderGeometry(0.42, 0.3, 1.1, 24), colour, 0, 0.55, 0);
    p.add(new CylinderGeometry(0.44, 0.44, 0.3, 24), 0x8a5a3a, 0, 0.55, 0);
    p.add(new CylinderGeometry(0.45, 0.43, 0.1, 24), DARK, 0, 1.14, 0);
  },
  soda: (p, colour) => can(p, colour, 0.36, 1.1, STEEL),
  energy: (p, colour) => {
    can(p, DARK, 0.28, 1.5, STEEL);
    p.add(new CylinderGeometry(0.285, 0.285, 0.5, 24), colour, 0, 0.8, 0);
  },
  donut: (p, colour) => {
    const dough = p.add(new TorusGeometry(0.5, 0.24, 16, 32), BREAD, 0, 0.24, 0);
    dough.rotation.x = Math.PI / 2;
    const icing = p.add(new TorusGeometry(0.5, 0.2, 16, 32), colour, 0, 0.32, 0);
    icing.rotation.x = Math.PI / 2;
    icing.scale.z = 0.7;
  },
  hotdog: (p, colour) => {
    const bun = p.add(new CapsuleGeometry(0.28, 1.3, 8, 16), BREAD, 0, 0.28, 0);
    bun.rotation.z = Math.PI / 2;
    bun.scale.set(1, 1.35, 1);
    const sausage = p.add(new CapsuleGeometry(0.15, 1.5, 8, 16), colour, 0, 0.5, 0);
    sausage.rotation.z = Math.PI / 2;
    p.add(new BoxGeometry(1.4, 0.04, 0.08), 0xf2c230, 0, 0.66, 0);
  },
  sandwich: (p, colour) => {
    const layers: [number, number][] = [
      [colour, 0.18],
      [0x5ab04a, 0.06],
      [0xc8302a, 0.08],
      [0xf2d06a, 0.05],
      [colour, 0.18],
    ];
    let y = 0;
    for (const [shade, height] of layers) {
      const slice = p.add(new CylinderGeometry(0.8, 0.8, height, 3), shade, 0, y + height / 2, 0);
      slice.rotation.y = Math.PI / 6;
      y += height;
    }
  },
  pizza: (p, colour) => {
    p.add(new CylinderGeometry(1, 1, 0.1, 24, 1, false, -Math.PI / 8, Math.PI / 4), colour, 0, 0.05, 0);
    const crust = p.add(new TorusGeometry(1, 0.07, 8, 24, Math.PI / 4), BREAD, 0, 0.1, 0);
    crust.rotation.set(Math.PI / 2, 0, -Math.PI / 8 + Math.PI / 2);
    // Each topping sits out along the slice, which points along +z, and to one side of it.
    for (const [out, side] of [[0.55, 0.05], [0.8, -0.12], [0.8, 0.16]] as const) {
      p.add(new CylinderGeometry(0.09, 0.09, 0.03, 16), 0xa32b28, side, 0.12, out);
    }
  },
  noodles: (p, colour) => {
    const box = p.add(new CylinderGeometry(0.6, 0.42, 1, 4), colour, 0, 0.5, 0);
    box.rotation.y = Math.PI / 4;
    p.add(new BoxGeometry(0.5, 0.08, 0.5), 0xd8a544, 0, 1.0, 0);
    for (const z of [-0.06, 0.06]) {
      const stick = p.add(new CylinderGeometry(0.02, 0.025, 1.3, 8), 0x8a5a3a, 0.1, 1.2, z);
      stick.rotation.z = 0.35;
    }
  },
  burger: (p, colour) => {
    p.add(new CylinderGeometry(0.62, 0.6, 0.22, 24), BREAD, 0, 0.11, 0);
    p.add(new CylinderGeometry(0.64, 0.64, 0.16, 24), colour, 0, 0.3, 0);
    p.add(new BoxGeometry(1.05, 0.04, 1.05), 0xf2c230, 0, 0.4, 0);
    p.add(new CylinderGeometry(0.66, 0.66, 0.05, 24), 0x5ab04a, 0, 0.45, 0);
    const top = p.add(new SphereGeometry(0.62, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), BREAD, 0, 0.47, 0);
    top.scale.y = 0.7;
  },
  bandage: (p, colour) => {
    const roll = p.add(new CylinderGeometry(0.5, 0.5, 0.7, 24), colour, 0, 0.5, 0);
    roll.rotation.x = Math.PI / 2;
    p.add(new BoxGeometry(0.05, 0.02, 0.6), colour, 0.45, 0.01, 0.25);
    p.add(new BoxGeometry(1.2, 0.02, 0.6), colour, 0.8, 0.01, 0);
  },
  medkit: (p, colour) => {
    p.add(new BoxGeometry(1.4, 0.9, 0.6), colour, 0, 0.45, 0);
    p.add(new BoxGeometry(0.5, 0.14, 0.64), WHITE, 0, 0.45, 0);
    p.add(new BoxGeometry(0.14, 0.5, 0.64), WHITE, 0, 0.45, 0);
    p.add(new BoxGeometry(0.5, 0.1, 0.1), DARK, 0, 0.95, 0);
  },
  treatment: (p, colour) => {
    p.add(new CylinderGeometry(0.35, 0.35, 0.9, 24), 0xe0a040, 0, 0.45, 0);
    p.add(new CylinderGeometry(0.38, 0.38, 0.25, 24), colour, 0, 1.02, 0);
    p.add(new BoxGeometry(0.72, 0.4, 0.02), WHITE, 0, 0.45, 0.35);
    for (const x of [0.6, 0.8]) {
      const pill = p.add(new CapsuleGeometry(0.06, 0.12, 4, 8), WHITE, x, 0.06, 0.2);
      pill.rotation.z = Math.PI / 2;
    }
  },
  naloxone: (p, colour) => {
    p.add(new BoxGeometry(1.1, 0.7, 0.35), colour, 0, 0.35, 0);
    p.add(new CylinderGeometry(0.12, 0.12, 0.7, 16), WHITE, 0.8, 0.35, 0);
    p.add(new CylinderGeometry(0.05, 0.1, 0.2, 16), WHITE, 0.8, 0.8, 0);
  },
  strips: (p, colour) => {
    p.add(new BoxGeometry(0.9, 0.08, 1.2), colour, 0, 0.04, 0);
    for (let i = 0; i < 3; i++) p.add(new BoxGeometry(0.1, 0.02, 1), WHITE, -0.25 + i * 0.25, 0.1, 0);
  },
  works: (p, colour) => {
    p.add(new BoxGeometry(0.9, 1.1, 0.9), colour, 0, 0.55, 0);
    p.add(new BoxGeometry(0.96, 0.18, 0.96), 0xc8302a, 0, 1.19, 0);
    p.add(new BoxGeometry(0.3, 0.02, 0.1), DARK, 0, 1.29, 0);
  },
  house: (p, colour) => {
    p.add(new BoxGeometry(1.6, 1, 1.2), colour, 0, 0.5, 0);
    const roof = p.add(new CylinderGeometry(0.85, 0.85, 1.7, 3), 0x8c3b1e, 0, 1.2, 0);
    roof.rotation.set(0, 0, Math.PI / 2);
    roof.scale.set(1, 1, 0.8);
    p.add(new BoxGeometry(0.3, 0.55, 0.04), 0x5a3a28, 0, 0.28, 0.61);
    for (const x of [-0.5, 0.5]) p.add(new BoxGeometry(0.3, 0.28, 0.04), 0x9ac8e0, x, 0.6, 0.61);
    p.add(new BoxGeometry(0.2, 0.5, 0.2), 0x7a3a2a, 0.45, 1.5, 0);
  },
  wrench: (p, colour) => {
    p.add(new BoxGeometry(1.6, 0.1, 0.22), colour, 0, 0.05, 0);
    const jaw = p.add(new TorusGeometry(0.22, 0.09, 8, 16, Math.PI * 1.4), colour, 0.95, 0.05, 0);
    jaw.rotation.set(Math.PI / 2, 0, Math.PI * 0.8);
    const ring = p.add(new TorusGeometry(0.18, 0.07, 8, 16), colour, -0.92, 0.05, 0);
    ring.rotation.x = Math.PI / 2;
  },
};

/** A can: a body and a rim at each end. */
function can(p: Prop, colour: number, radius: number, height: number, rim: number): void {
  p.add(new CylinderGeometry(radius, radius, height, 24), colour, 0, height / 2, 0);
  p.add(new CylinderGeometry(radius * 0.92, radius, 0.06, 24), rim, 0, height + 0.03, 0);
  p.add(new CylinderGeometry(radius, radius * 0.92, 0.06, 24), rim, 0, 0.03, 0);
}

/** One round standing on its base: a brass case and a lead tip. */
function bullet(p: Prop, x: number, y: number, height: number): void {
  p.add(new CylinderGeometry(0.08, 0.08, height * 0.7, 12), BRASS, x, y + height * 0.35, 0);
  p.add(new CylinderGeometry(0.01, 0.08, height * 0.3, 12), 0x8a8f96, x, y + height * 0.85, 0);
}

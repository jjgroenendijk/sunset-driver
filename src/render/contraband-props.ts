/**
 * The goods of the contraband trade (spec section 16.2), drawn for the turning
 * preview of the dealer's panel.
 *
 * Each one is a few primitives at no particular scale, as the shop's props are
 * (`shop-props.ts`): the preview frames what it is given. Nothing here is drawn
 * in the city, so nothing is merged or batched.
 */
import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import type { GoodId } from '../sim/goods.ts';
import { Prop } from './shop-props.ts';

const WHITE = 0xf2ede6;
const DARK = 0x2a2320;
const GOLD = 0xd4a93a;
const STEEL = 0xb8bcc2;
const RED = 0xb8312a;
const WOOD = 0x7a4a2a;
const TOBACCO = 0x6b3f22;

/** Build the prop a good of the trade is shown as. */
export function buildGood(id: GoodId): Prop {
  const prop = new Prop();
  BUILDERS[id](prop);
  return prop;
}

const BUILDERS: Readonly<Record<GoodId, (p: Prop) => void>> = {
  cigarettes: (p) => {
    // A carton, and one pack out of it with the filters showing.
    p.add(new BoxGeometry(1.6, 0.45, 0.7), WHITE, 0, 0.225, 0);
    p.add(new BoxGeometry(1.62, 0.2, 0.72), RED, 0, 0.3, 0);
    p.add(new BoxGeometry(0.4, 0.62, 0.22), WHITE, 0.3, 0.76, 0.1);
    p.add(new BoxGeometry(0.42, 0.24, 0.24), RED, 0.3, 0.9, 0.1);
    for (const x of [-0.1, 0, 0.1]) p.add(new CylinderGeometry(0.04, 0.04, 0.18, 10), 0xd9a45a, 0.3 + x, 1.14, 0.1);
  },
  liquor: (p) => {
    for (const [x, z, colour] of [[-0.35, 0, 0x8a4a1a], [0.35, 0.1, 0x3f6a3a]] as const) {
      p.add(new CylinderGeometry(0.3, 0.3, 1.1, 24), colour, x, 0.55, z);
      p.add(new CylinderGeometry(0.1, 0.3, 0.3, 24), colour, x, 1.25, z);
      p.add(new CylinderGeometry(0.1, 0.1, 0.35, 16), colour, x, 1.55, z);
      p.add(new CylinderGeometry(0.11, 0.11, 0.12, 16), GOLD, x, 1.76, z);
      p.add(new CylinderGeometry(0.305, 0.305, 0.4, 24), WHITE, x, 0.55, z);
    }
  },
  cigars: (p) => {
    // An open box of them, the lid stood up behind.
    p.add(new BoxGeometry(1.6, 0.14, 1), WOOD, 0, 0.07, 0);
    for (const x of [-0.79, 0.79]) p.add(new BoxGeometry(0.04, 0.3, 1), WOOD, x, 0.25, 0);
    for (const z of [-0.49, 0.49]) p.add(new BoxGeometry(1.6, 0.3, 0.04), WOOD, 0, 0.25, z);
    const lid = p.add(new BoxGeometry(1.6, 0.04, 1), 0xa0643a, 0, 0.9, -0.62);
    lid.rotation.x = -1.35;
    for (let i = 0; i < 6; i++) {
      p.add(new CapsuleGeometry(0.1, 0.72, 6, 12), TOBACCO, -0.6 + i * 0.24, 0.26, 0).rotation.x = Math.PI / 2;
      p.add(new CylinderGeometry(0.105, 0.105, 0.1, 12), GOLD, -0.6 + i * 0.24, 0.26, 0.25).rotation.x = Math.PI / 2;
    }
  },
  handbags: (p) => {
    const bag = p.add(new CylinderGeometry(0.5, 0.75, 0.9, 4), 0x9a3a4a, 0, 0.45, 0);
    bag.rotation.y = Math.PI / 4;
    bag.scale.z = 0.45;
    p.add(new TorusGeometry(0.34, 0.05, 8, 24, Math.PI), 0x6a2a34, 0, 0.9, 0);
    p.add(new BoxGeometry(0.2, 0.12, 0.05), GOLD, 0, 0.7, 0.19);
  },
  counterfeits: (p) => {
    // A watch lying on its strap, the face tipped up to the light.
    p.add(new BoxGeometry(0.42, 0.06, 1.8), 0x4a3024, 0, 0.03, 0);
    const face = p.add(new CylinderGeometry(0.42, 0.42, 0.16, 32), GOLD, 0, 0.14, 0);
    face.rotation.x = 0.1;
    p.add(new CylinderGeometry(0.34, 0.34, 0.02, 32), WHITE, 0, 0.23, 0.01);
    p.add(new BoxGeometry(0.03, 0.02, 0.26), DARK, 0, 0.25, -0.1);
    p.add(new BoxGeometry(0.2, 0.02, 0.03), DARK, 0.08, 0.25, 0.01);
    p.add(new CylinderGeometry(0.05, 0.05, 0.1, 12), GOLD, 0.45, 0.16, 0).rotation.z = Math.PI / 2;
  },
  phones: (p) => {
    // A short stack of them, the top one face up and lit.
    for (let i = 0; i < 3; i++) {
      const phone = p.add(new BoxGeometry(0.7, 0.08, 1.4), i === 2 ? DARK : 0x5a5f66, 0, 0.04 + i * 0.09, 0);
      phone.rotation.y = (i - 1) * 0.25;
    }
    const screen = p.add(new BoxGeometry(0.6, 0.01, 1.22), 0x4a90c8, 0, 0.265, 0);
    screen.rotation.y = 0.25;
  },
  parts: (p) => {
    // A wheel on its rim, with a brake disc showing through the spokes.
    const tyre = p.add(new TorusGeometry(0.72, 0.26, 16, 32), DARK, 0, 1, 0);
    tyre.rotation.y = 0.3;
    p.add(new CylinderGeometry(0.55, 0.55, 0.3, 24), STEEL, 0, 1, 0).rotation.set(Math.PI / 2, 0.3, 0, 'YXZ');
    p.add(new CylinderGeometry(0.4, 0.4, 0.32, 24), 0x8a4a2a, 0, 1, 0).rotation.set(Math.PI / 2, 0.3, 0, 'YXZ');
    p.add(new CylinderGeometry(0.12, 0.12, 0.36, 12), GOLD, 0, 1, 0).rotation.set(Math.PI / 2, 0.3, 0, 'YXZ');
  },
  jewellery: (p) => {
    // A ring with its stone, and a chain lying round it.
    const ring = p.add(new TorusGeometry(0.4, 0.08, 12, 32), GOLD, 0, 0.5, 0);
    ring.rotation.x = 0.2;
    p.add(new OctahedronGeometry(0.2), 0xbfe6ff, 0, 0.98, 0.1);
    const chain = p.add(new TorusGeometry(0.9, 0.04, 8, 48), GOLD, 0, 0.04, 0);
    chain.rotation.x = Math.PI / 2;
    chain.scale.y = 0.7;
    p.add(new CylinderGeometry(0.6, 0.6, 0.05, 32), 0x3a1e3a, 0, 0.02, 0);
  },
  paintings: (p) => {
    // A canvas in a gilt frame, leaning on nothing.
    const frame = [
      [0, 1.55, 1.8, 0.14],
      [0, 0.15, 1.8, 0.14],
      [-0.83, 0.85, 0.14, 1.54],
      [0.83, 0.85, 0.14, 1.54],
    ] as const;
    for (const [x, y, w, h] of frame) p.add(new BoxGeometry(w, h, 0.12), GOLD, x, y, 0);
    p.add(new BoxGeometry(1.56, 1.28, 0.04), 0x2f4a6a, 0, 0.85, 0);
    p.add(new BoxGeometry(1.56, 0.4, 0.05), 0x5a7a3a, 0, 0.4, 0);
    p.add(new CylinderGeometry(0.2, 0.2, 0.06, 24), 0xe8b04a, 0.35, 1.2, 0).rotation.x = Math.PI / 2;
    p.add(new ConeGeometry(0.3, 0.5, 3), 0x3a5a2a, -0.35, 0.8, 0.02);
  },
  weed: (p) => {
    // A sealed bag, the green inside it pressed against the plastic.
    p.add(new BoxGeometry(1.1, 0.05, 1.4), 0xdfe8e0, 0, 0.025, 0);
    p.add(new BoxGeometry(1.1, 0.06, 0.08), 0x6a9a6a, 0, 0.06, -0.62);
    for (const [x, z, r] of [[-0.2, 0.1, 0.3], [0.2, -0.1, 0.28], [0.05, 0.3, 0.24]] as const) {
      const bud = p.add(new SphereGeometry(r, 12, 8), 0x5a8a3a, x, 0.14, z);
      bud.scale.y = 0.45;
    }
  },
  pills: (p) => {
    p.add(new CylinderGeometry(0.4, 0.4, 1.1, 24), 0xd9782a, 0, 0.55, 0);
    p.add(new CylinderGeometry(0.43, 0.43, 0.24, 24), WHITE, 0, 1.22, 0);
    p.add(new CylinderGeometry(0.405, 0.405, 0.5, 24), WHITE, 0, 0.55, 0);
    for (const [x, z] of [[0.75, 0.2], [0.65, -0.2], [0.95, -0.05]] as const) {
      const pill = p.add(new CapsuleGeometry(0.08, 0.18, 4, 10), 0x4a8ac8, x, 0.08, z);
      pill.rotation.z = Math.PI / 2;
      pill.rotation.y = x * 2;
    }
  },
  powder: (p) => {
    // A pressed brick, taped round twice, with the stamp of who pressed it.
    p.add(new BoxGeometry(1.4, 0.45, 0.9), 0xe8e2d4, 0, 0.225, 0);
    for (const x of [-0.35, 0.35]) p.add(new BoxGeometry(0.16, 0.47, 0.92), 0xa08a5a, x, 0.225, 0);
    p.add(new CylinderGeometry(0.16, 0.16, 0.01, 6), RED, 0, 0.455, 0);
  },
};

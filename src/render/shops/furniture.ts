/**
 * The furniture of a shop's room: tables, chairs, stools, booths, sofas,
 * plants, pictures and the fittings of a counter, each laid into the room's
 * {@link RoomKit} as a handful of boxes and cylinders.
 *
 * A piece is built in its own frame, a {@link Spot}: `dx` across it and `dz`
 * out of its front, which for a piece against a wall is out into the room.
 * The spot turns and places it, so a booth is written once and stands against
 * any wall.
 *
 * Nothing here chooses where a piece goes or what it looks like: the layout
 * of `venue-fit.ts` does that from the room's style.
 */
import { cos, sin } from '../../core/libm.ts';
import type { Rng } from '../../core/rng.ts';
import type { Finish, RoomKit } from './room-kit.ts';
import { shade } from './room-style.ts';

/** A place in the room and the way a piece stands there: `rot` turns it about the vertical. */
export class Spot {
  readonly kit: RoomKit;
  readonly x: number;
  readonly z: number;
  readonly rot: number;

  constructor(kit: RoomKit, x: number, z: number, rot: number) {
    this.kit = kit;
    this.x = x;
    this.z = z;
    this.rot = rot;
  }

  /** The room's `x` and `z` of a point of the piece. */
  at(dx: number, dz: number): [number, number] {
    const c = cos(this.rot);
    const s = sin(this.rot);
    return [this.x + dx * c + dz * s, this.z - dx * s + dz * c];
  }

  /** A spot inside this one, moved and turned in its frame. */
  child(dx: number, dz: number, turn = 0): Spot {
    const [x, z] = this.at(dx, dz);
    return new Spot(this.kit, x, z, this.rot + turn);
  }

  /** A box standing at height `y`, its bottom there. */
  block(w: number, h: number, d: number, dx: number, y: number, dz: number, colour: number, finish: Finish = 'matte'): void {
    const [x, z] = this.at(dx, dz);
    this.kit.block(w, h, d, x, y, z, colour, finish, { y: this.rot });
  }

  cylinder(top: number, bottom: number, h: number, dx: number, y: number, dz: number, colour: number, finish: Finish = 'matte', sides = 12): void {
    const [x, z] = this.at(dx, dz);
    this.kit.cylinder(top, bottom, h, x, y, z, colour, finish, sides);
  }

  ball(radius: number, dx: number, y: number, dz: number, colour: number, finish: Finish = 'matte', squash = 1): void {
    const [x, z] = this.at(dx, dz);
    this.kit.ball(radius, x, y, z, colour, finish, squash);
  }

  /** A box turned in the piece's own frame as well: `tilt` about its `x`, `roll` about its `z`. */
  tilted(w: number, h: number, d: number, dx: number, y: number, dz: number, colour: number, tilt: number, roll: number, finish: Finish = 'matte'): void {
    const [x, z] = this.at(dx, dz);
    this.kit.box(w, h, d, x, y, z, colour, finish, { x: tilt, y: this.rot, z: roll });
  }
}

/** What a chair, a stool or a table is made of. */
export interface Materials {
  wood: number;
  metal: number;
  fabric: number;
}

/** A chair facing `-dz`, its back at `+dz`. */
export function chair(s: Spot, m: Materials, variant: number): void {
  const seat = 0.44;
  if (variant % 3 === 0) {
    // Four legs, a wooden seat, a slatted back.
    for (const [lx, lz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]] as const) s.block(0.04, seat, 0.04, lx, 0, lz, m.wood);
    s.block(0.44, 0.05, 0.44, 0, seat, 0, m.wood);
    s.block(0.44, 0.08, 0.04, 0, 0.78, 0.2, m.wood);
    s.block(0.04, 0.36, 0.04, -0.18, seat, 0.2, m.wood);
    s.block(0.04, 0.36, 0.04, 0.18, seat, 0.2, m.wood);
  } else if (variant % 3 === 1) {
    // A bistro chair: a thin metal frame and a round seat.
    for (const [lx, lz] of [[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16], [0.16, 0.16]] as const) s.block(0.025, seat, 0.025, lx, 0, lz, m.metal);
    s.cylinder(0.21, 0.21, 0.05, 0, seat, 0, m.wood, 'matte', 14);
    s.block(0.4, 0.3, 0.03, 0, seat + 0.1, 0.2, m.metal);
  } else {
    // An upholstered chair.
    s.block(0.48, seat, 0.48, 0, 0, 0, shade(m.fabric, -0.08));
    s.block(0.46, 0.08, 0.46, 0, seat, 0, m.fabric);
    s.block(0.48, 0.5, 0.1, 0, seat, 0.2, m.fabric);
  }
}

/** A stool, the seat at `height`. */
export function stool(s: Spot, m: Materials, height: number, variant: number): void {
  s.cylinder(0.2, 0.22, 0.03, 0, 0, 0, m.metal);
  s.cylinder(0.025, 0.025, height - 0.05, 0, 0.03, 0, m.metal, 'matte', 8);
  s.cylinder(0.14, 0.14, 0.02, 0, height * 0.35, 0, m.metal, 'matte', 12);
  if (variant % 2 === 0) s.cylinder(0.19, 0.18, 0.08, 0, height - 0.06, 0, m.fabric, 'matte', 14);
  else s.cylinder(0.18, 0.17, 0.05, 0, height - 0.04, 0, m.wood, 'matte', 14);
}

/** A table, `w` by `d`, round when `round`. */
export function table(s: Spot, m: Materials, w: number, d: number, round: boolean, height = 0.74): void {
  if (round) {
    s.cylinder(0.24, 0.26, 0.03, 0, 0, 0, m.metal, 'matte', 14);
    s.cylinder(0.04, 0.04, height - 0.04, 0, 0.03, 0, m.metal, 'matte', 8);
    s.cylinder(w / 2, w / 2, 0.04, 0, height - 0.04, 0, m.wood, 'matte', 20);
    return;
  }
  for (const lx of [-1, 1]) {
    for (const lz of [-1, 1]) s.block(0.05, height - 0.04, 0.05, lx * (w / 2 - 0.06), 0, lz * (d / 2 - 0.06), m.wood);
  }
  s.block(w, 0.04, d, 0, height - 0.04, 0, m.wood);
}

/** A high table with a round top, for standing at or for stools. */
export function highTable(s: Spot, m: Materials, radius: number): void {
  s.cylinder(0.22, 0.25, 0.03, 0, 0, 0, m.metal, 'matte', 14);
  s.cylinder(0.035, 0.035, 1.02, 0, 0.03, 0, m.metal, 'matte', 8);
  s.cylinder(radius, radius, 0.04, 0, 1.03, 0, m.wood, 'matte', 18);
}

/** A bench against a wall at `+dz`, `length` long, facing `-dz`, with a high back. */
export function bench(s: Spot, m: Materials, length: number, back: number): void {
  s.block(length, 0.42, 0.5, 0, 0, 0, shade(m.fabric, -0.12));
  s.block(length, 0.1, 0.5, 0, 0.42, 0, m.fabric);
  s.block(length, back, 0.14, 0, 0.42, 0.22, m.fabric);
  s.block(length + 0.04, 0.05, 0.18, 0, 0.42 + back, 0.22, m.wood);
}

/** A sofa facing `-dz`, `length` long. */
export function sofa(s: Spot, m: Materials, length: number): void {
  s.block(length, 0.25, 0.8, 0, 0.06, 0, shade(m.fabric, -0.1));
  s.block(length - 0.3, 0.14, 0.62, 0, 0.31, -0.06, m.fabric);
  s.block(length, 0.5, 0.2, 0, 0.3, 0.3, m.fabric);
  for (const side of [-1, 1]) s.block(0.16, 0.36, 0.8, side * (length / 2 - 0.08), 0.3, 0, m.fabric);
  for (const side of [-1, 1]) s.block(0.05, 0.06, 0.05, side * (length / 2 - 0.1), 0, 0.3, m.wood);
}

/** An armchair facing `-dz`. */
export function armchair(s: Spot, m: Materials): void {
  sofa(s, m, 0.85);
}

/** A low table for a lounge. */
export function lowTable(s: Spot, m: Materials, w: number, d: number): void {
  s.block(w, 0.05, d, 0, 0.38, 0, m.wood);
  s.block(w - 0.1, 0.3, d - 0.1, 0, 0.05, 0, shade(m.wood, -0.1));
}

/** A rug lying on the floor. */
export function rug(s: Spot, colour: number, w: number, d: number): void {
  s.block(w, 0.012, d, 0, 0.005, 0, colour);
  s.block(w - 0.2, 0.014, d - 0.2, 0, 0.006, 0, shade(colour, 0.12));
  s.block(w - 0.5, 0.016, d - 0.5, 0, 0.007, 0, colour);
}

/** The greens a plant is dealt from. */
const GREENS = [0x3a7a3a, 0x2f6a3a, 0x4a8a3a, 0x2a5a30, 0x5a9a4a];
const POTS = [0xc86a40, 0xe8e4dc, 0x2a2a2a, 0x8a8a84, 0xd8b890];

/** A potted plant: a bush, a tall one, or a palm. */
export function plant(s: Spot, rng: Rng): void {
  const pot = rng.pick(POTS);
  const green = rng.pick(GREENS);
  const kind = Math.floor(rng.float() * 3);
  const potHeight = 0.3 + rng.float() * 0.25;
  s.cylinder(0.2, 0.15, potHeight, 0, 0, 0, pot, 'matte', 12);
  s.cylinder(0.18, 0.18, 0.02, 0, potHeight - 0.03, 0, 0x3a2a1a);
  if (kind === 0) {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      s.ball(0.2 + rng.float() * 0.08, cos(a) * 0.14, potHeight + 0.2 + rng.float() * 0.2, sin(a) * 0.14, shade(green, (rng.float() - 0.5) * 0.1));
    }
    s.ball(0.24, 0, potHeight + 0.42, 0, green);
  } else if (kind === 1) {
    const height = 1.2 + rng.float() * 0.6;
    s.cylinder(0.03, 0.04, height, 0, potHeight, 0, 0x5a3a20, 'matte', 6);
    for (let i = 0; i < 7; i++) {
      const a = i * 2.4;
      const y = potHeight + height * (0.35 + (i / 7) * 0.65);
      s.ball(0.16 + rng.float() * 0.06, cos(a) * 0.16, y, sin(a) * 0.16, shade(green, (rng.float() - 0.5) * 0.1), 'matte', 0.7);
    }
  } else {
    const height = 0.9 + rng.float() * 0.5;
    s.cylinder(0.04, 0.06, height, 0, potHeight, 0, 0x7a5a38, 'matte', 6);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const leaf = s.child(cos(a) * 0.3, sin(a) * 0.3, -a);
      leaf.tilted(0.12, 0.02, 0.65, 0, potHeight + height, 0, green, 0.5, 0);
    }
  }
}

/** A plant hanging from the ceiling at `top`. */
export function hangingPlant(s: Spot, rng: Rng, top: number): void {
  const green = rng.pick(GREENS);
  const drop = 0.5 + rng.float() * 0.4;
  s.cylinder(0.008, 0.008, drop, 0, top - drop, 0, 0x3a3a3a, 'matte', 4);
  s.cylinder(0.16, 0.12, 0.18, 0, top - drop - 0.18, 0, rng.pick(POTS), 'matte', 10);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    s.block(0.06, 0.4 + rng.float() * 0.3, 0.06, cos(a) * 0.14, top - drop - 0.55, sin(a) * 0.14, green);
  }
  s.ball(0.18, 0, top - drop - 0.05, 0, green, 'matte', 0.7);
}

/** The colours a picture on the wall is painted in. */
const ART = [0xe0a040, 0x3a6ab0, 0xc03a3a, 0x3a9a7a, 0xf0e0c0, 0x2a2a2a, 0xe07aa0, 0x8a5ab0, 0xf0c060];

/** A framed picture on a wall behind `+dz`, its middle at height `y`. */
export function picture(s: Spot, rng: Rng, frame: number, w: number, h: number, y: number): void {
  s.block(w, h, 0.04, 0, y - h / 2, 0.0, frame);
  const ground = rng.pick(ART);
  s.block(w - 0.08, h - 0.08, 0.02, 0, y - h / 2 + 0.04, -0.02, ground);
  // Two or three blocks of colour: an abstract, a sunset, a poster.
  const count = 2 + Math.floor(rng.float() * 2);
  for (let i = 0; i < count; i++) {
    const bw = (w - 0.12) * (0.3 + rng.float() * 0.5);
    const bh = (h - 0.12) * (0.2 + rng.float() * 0.4);
    const bx = (rng.float() - 0.5) * (w - 0.12 - bw);
    const by = y - h / 2 + 0.06 + rng.float() * (h - 0.12 - bh);
    s.block(bw, bh, 0.01, bx, by, -0.035, rng.pick(ART));
  }
}

/** A mirror on a wall behind `+dz`. */
export function mirror(s: Spot, frame: number, w: number, h: number, y: number): void {
  s.block(w, h, 0.04, 0, y - h / 2, 0, frame);
  s.block(w - 0.1, h - 0.1, 0.02, 0, y - h / 2 + 0.05, -0.02, 0xc8d4dc);
}

/** A clock on a wall behind `+dz`. */
export function clock(s: Spot, frame: number, y: number): void {
  const [x, z] = s.at(0, -0.01);
  s.kit.rod(0.2, 0.04, x, y, z, 0xf2f0e8, { x: Math.PI / 2, y: s.rot });
  const [rx, rz] = s.at(0, -0.02);
  s.kit.ring(0.2, 0.025, rx, y, rz, frame, { y: s.rot });
  s.tilted(0.02, 0.14, 0.01, 0, y - 0.02, -0.04, 0x1a1a1a, 0, 0.4);
  s.tilted(0.015, 0.1, 0.01, 0, y - 0.02, -0.045, 0x1a1a1a, 0, -1.3);
}

/** A dartboard on a wall behind `+dz`. */
export function dartboard(s: Spot, y: number): void {
  const [x, z] = s.at(0, -0.02);
  s.kit.rod(0.23, 0.04, x, y, z, 0x1a1a1a, { x: Math.PI / 2, y: s.rot });
  const [x2, z2] = s.at(0, -0.045);
  s.kit.rod(0.17, 0.02, x2, y, z2, 0xe8dcc0, { x: Math.PI / 2, y: s.rot });
  const [x3, z3] = s.at(0, -0.06);
  s.kit.rod(0.08, 0.02, x3, y, z3, 0xc02a2a, { x: Math.PI / 2, y: s.rot });
  const [x4, z4] = s.at(0, -0.07);
  s.kit.rod(0.025, 0.02, x4, y, z4, 0x2a8a3a, { x: Math.PI / 2, y: s.rot });
}

/** A screen on a wall behind `+dz`, showing a game in a colour of its own. */
export function screen(s: Spot, picture: number, w: number, y: number): void {
  const h = w * 0.58;
  s.block(w, h, 0.06, 0, y - h / 2, 0, 0x121214);
  s.block(w - 0.06, h - 0.06, 0.02, 0, y - h / 2 + 0.03, -0.035, picture, 'lamp');
  s.block(w * 0.02, h - 0.1, 0.01, 0, y - h / 2 + 0.05, -0.05, 0xf0f0f0, 'lamp');
}

/** A board of the day's menu on a wall behind `+dz`: chalk lines on black. */
export function menuBoard(s: Spot, rng: Rng, frame: number, w: number, h: number, y: number): void {
  s.block(w, h, 0.04, 0, y - h / 2, 0, frame);
  s.block(w - 0.08, h - 0.08, 0.02, 0, y - h / 2 + 0.04, -0.02, 0x1f2422);
  const lines = Math.floor((h - 0.2) / 0.1);
  for (let i = 0; i < lines; i++) {
    const heading = i === 0;
    const lw = heading ? w * 0.5 : (w - 0.3) * (0.4 + rng.float() * 0.4);
    const ly = y - 0.12 - i * 0.1;
    s.block(lw, heading ? 0.04 : 0.022, 0.01, heading ? 0 : -((w - 0.3) - lw) / 2, ly, -0.035, 0xe8e4d8);
    if (!heading) s.block(0.1, 0.022, 0.01, w / 2 - 0.16, ly, -0.035, 0xf0d070);
  }
}

/** A bookshelf against a wall behind `+dz`, `w` wide. */
export function bookshelf(s: Spot, rng: Rng, wood: number, w: number, h: number): void {
  s.block(w, h, 0.32, 0, 0, 0.02, wood);
  const shelves = Math.floor(h / 0.36);
  for (let row = 0; row < shelves; row++) {
    const y = 0.08 + row * 0.36;
    s.block(w - 0.06, 0.3, 0.26, 0, y, -0.02, shade(wood, -0.2));
    let at = -w / 2 + 0.06;
    while (at < w / 2 - 0.1) {
      const bw = 0.03 + rng.float() * 0.04;
      const bh = 0.18 + rng.float() * 0.1;
      s.block(bw, bh, 0.2, at + bw / 2, y, -0.06, rng.pick(ART));
      at += bw + 0.005;
    }
  }
}

/** One glowing tube of a neon sign: `w` by `h`, its middle `(dx, dy)` off the sign's, turned by `roll`. */
type Tube = (w: number, h: number, dx: number, dy: number, roll?: number) => void;

/** The shapes a neon sign is bent into: a ring, a star, a wave and a cocktail glass. */
const NEON_SHAPES: readonly ((tube: Tube) => void)[] = [
  (tube) => {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      tube(0.14, 0.03, cos(a) * 0.24, sin(a) * 0.24, a + Math.PI / 2);
    }
    tube(0.3, 0.03, 0, 0);
  },
  (tube) => {
    for (let i = 0; i < 5; i++) tube(0.5, 0.03, 0, 0, (i / 5) * Math.PI);
  },
  (tube) => {
    for (const dy of [-0.05, -0.2]) {
      for (let i = 0; i < 6; i++) tube(0.15, 0.03, -0.35 + i * 0.14, (i % 2) * 0.1 + dy, i % 2 === 0 ? 0.6 : -0.6);
    }
  },
  (tube) => {
    tube(0.5, 0.03, 0, 0.2);
    tube(0.34, 0.03, -0.13, 0.05, 1.0);
    tube(0.34, 0.03, 0.13, 0.05, -1.0);
    tube(0.03, 0.22, 0, -0.14);
    tube(0.24, 0.03, 0, -0.25);
  },
];

/** A neon sign on a wall behind `+dz`, on a dark board, its middle at height `y`. */
export function neonSign(s: Spot, rng: Rng, colour: number, y: number): void {
  const tube: Tube = (w, h, dx, dy, roll = 0) => s.tilted(w, h, 0.03, dx, y + dy, -0.06, colour, 0, roll, 'lamp');
  s.block(0.9, 0.62, 0.02, 0, y - 0.31, -0.01, 0x121214);
  rng.pick(NEON_SHAPES)(tube);
}

/** The glass colours of the bottles behind a bar. */
const BOTTLES = [0x2a6a3a, 0x7a4a1a, 0xc08030, 0xe8e0c8, 0x3a3a7a, 0x8a1f2a, 0xd8d8b0, 0x1f4a2a, 0xe0a040];

/** A row of bottles along a shelf, `length` long, standing at `y`. */
export function bottles(s: Spot, rng: Rng, length: number, y: number, dz: number): void {
  let at = -length / 2 + 0.06;
  while (at < length / 2 - 0.06) {
    const colour = rng.pick(BOTTLES);
    const h = 0.22 + rng.float() * 0.12;
    const r = 0.03 + rng.float() * 0.015;
    s.cylinder(r, r, h * 0.7, at, y, dz, colour, 'matte', 8);
    s.cylinder(r * 0.35, r, h * 0.18, at, y + h * 0.7, dz, colour, 'matte', 8);
    s.cylinder(r * 0.35, r * 0.35, h * 0.12, at, y + h * 0.88, dz, shade(colour, -0.2), 'matte', 6);
    at += r * 2 + 0.02 + rng.float() * 0.03;
  }
}

/** A cup, a glass or a jar, small, for a counter or a table. */
export function cup(s: Spot, dx: number, y: number, dz: number, colour: number): void {
  s.cylinder(0.045, 0.035, 0.09, dx, y, dz, colour, 'matte', 10);
}

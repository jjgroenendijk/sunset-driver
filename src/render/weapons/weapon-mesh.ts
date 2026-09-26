/**
 * The shape of every weapon, and of every attachment on it (spec section 11.6).
 *
 * The camera looks down, so what a weapon needs is a top-down silhouette of its
 * own: how long it is, how wide, and what stands out to the side of it — a
 * scope, a box magazine, a warhead, a twin barrel. It is boxes, as the vehicles
 * and the character are, and this file is the one place that says which boxes.
 *
 * It is a plain function of the arsenal row and what is fitted, with no three.js
 * in it, so the silhouettes are measured headless. `weapon.ts` turns the boxes
 * into one mesh.
 *
 * Every box is in the weapon's own frame: `length` runs along local `+x`, which
 * is where the muzzle points, `height` along `+y` and `width` along `+z`. The
 * origin is where the hand holds it, at the height of the bore.
 */
import type { Attachment, WeaponId } from '../../sim/weapons/weapon.ts';

/** One box of a weapon's model. */
export interface WeaponBox {
  length: number;
  height: number;
  width: number;
  /** The middle of the box, in the weapon's own frame. */
  x: number;
  y: number;
  z: number;
  colour: number;
  /** The attachment this box is, or undefined on the weapon itself. */
  part: Attachment | undefined;
}

const BLUED = 0x1d1e21;
const STEEL = 0x44474c;
const CHROME = 0x9a9ea4;
const POLYMER = 0x262729;
const WOOD = 0x74482a;
const OLIVE = 0x4a5232;
const BLADE = 0xc3c7cc;
const BRASS = 0xb08d3c;
const RED = 0x9c2a22;
const ORANGE = 0xd0651e;
const BOTTLE = 0x4d6b2f;
const RAG = 0xd6c8a4;
/** The red of a laser's lens, the one bright point on a dark model. */
const LASER_LENS = 0xff3a2a;

/**
 * What a gun is made of, in metres. The receiver is the middle of it; the rest
 * hangs off the receiver's front, its back, above it, below it and beside it.
 */
interface GunForm {
  /** Receiver length, width and height, and where its middle stands along `x`. */
  body: readonly [number, number, number];
  at: number;
  /** Barrel beyond the receiver's front, and its thickness. */
  barrel: number;
  bore: number;
  /** Stock behind the receiver: length, width, height. */
  stock?: readonly [number, number, number];
  /** Handguard or pump over the barrel: length, width, and where it starts past the receiver. */
  fore?: readonly [number, number, number];
  /** A box magazine below: length, drop, and where its middle stands along `x`. */
  mag?: readonly [number, number, number];
  /** A scope, sight or carry handle on top: length, width, height, and its middle along `x`. */
  top?: readonly [number, number, number, number];
  /** A muzzle brake or a warhead: length and width. */
  brake?: readonly [number, number];
  /** Something to one side: length, how far out it reaches, and its middle along `x`. */
  side?: readonly [number, number, number];
  /** A revolver's cylinder, or anything wider round the middle: length and width. */
  bulge?: readonly [number, number];
  /** Two barrels side by side. */
  twin?: boolean;
  /** A tube under the barrel rather than a box magazine: a pump shotgun. */
  tube?: boolean;
  /** A pistol-sized weapon: shorter attachments. */
  small?: boolean;
  metal: number;
  furniture: number;
}

/** The guns of the arsenal, row by row. Nothing else should carry these shapes. */
const GUNS: Readonly<Partial<Record<WeaponId, GunForm>>> = {
  'glock-17': { body: [0.186, 0.032, 0.03], at: 0.04, barrel: 0, bore: 0.012, small: true, metal: POLYMER, furniture: POLYMER },
  'beretta-92fs': { body: [0.2, 0.038, 0.032], at: 0.045, barrel: 0.017, bore: 0.014, small: true, metal: BLUED, furniture: WOOD },
  'colt-m1911': { body: [0.216, 0.032, 0.03], at: 0.055, barrel: 0, bore: 0.012, bulge: [0.04, 0.042], small: true, metal: STEEL, furniture: WOOD },
  'sig-p226': { body: [0.196, 0.04, 0.034], at: 0.03, barrel: 0, bore: 0.012, top: [0.02, 0.012, 0.01, -0.06], small: true, metal: BLUED, furniture: POLYMER },
  'model-29': { body: [0.1, 0.03, 0.03], at: 0, barrel: 0.2, bore: 0.022, bulge: [0.045, 0.048], small: true, metal: CHROME, furniture: WOOD },
  'desert-eagle': { body: [0.267, 0.046, 0.04], at: 0.07, barrel: 0, bore: 0.02, small: true, metal: CHROME, furniture: POLYMER },
  uzi: { body: [0.24, 0.05, 0.06], at: 0.05, barrel: 0.03, bore: 0.018, small: true, metal: BLUED, furniture: POLYMER },
  'mac-10': { body: [0.2, 0.055, 0.07], at: 0.03, barrel: 0.055, bore: 0.022, small: true, metal: STEEL, furniture: POLYMER },
  mp5: { body: [0.3, 0.045, 0.06], at: 0.08, barrel: 0.05, bore: 0.02, fore: [0.14, 0.056, -0.14], stock: [0.2, 0.03, 0.05], mag: [0.03, 0.15, 0.16], top: [0.03, 0.03, 0.02, -0.04], metal: BLUED, furniture: POLYMER },
  'tec-9': { body: [0.17, 0.035, 0.05], at: 0.05, barrel: 0.13, bore: 0.032, mag: [0.03, 0.16, 0.11], small: true, metal: BLUED, furniture: POLYMER },
  'remington-870': { body: [0.22, 0.045, 0.06], at: 0.03, barrel: 0.5, bore: 0.024, fore: [0.2, 0.052, 0.14], stock: [0.35, 0.04, 0.12], tube: true, metal: BLUED, furniture: WOOD },
  'mossberg-500': { body: [0.2, 0.048, 0.06], at: 0.03, barrel: 0.46, bore: 0.026, fore: [0.17, 0.06, 0.08], stock: [0.33, 0.045, 0.12], tube: true, metal: BLUED, furniture: POLYMER },
  'sawn-off': { body: [0.12, 0.066, 0.05], at: 0.02, barrel: 0.3, bore: 0.025, twin: true, fore: [0.1, 0.07, 0], metal: STEEL, furniture: WOOD },
  'spas-12': { body: [0.25, 0.052, 0.07], at: 0.04, barrel: 0.44, bore: 0.026, fore: [0.3, 0.064, 0], stock: [0.3, 0.02, 0.02], tube: true, metal: BLUED, furniture: POLYMER },
  'ak-47': { body: [0.3, 0.045, 0.07], at: 0.06, barrel: 0.37, bore: 0.02, fore: [0.2, 0.052, 0.02], stock: [0.3, 0.04, 0.1], mag: [0.04, 0.2, 0.16], brake: [0.03, 0.028], metal: BLUED, furniture: WOOD },
  m4a1: { body: [0.26, 0.045, 0.07], at: 0.05, barrel: 0.32, bore: 0.018, fore: [0.19, 0.058, 0], stock: [0.26, 0.04, 0.08], mag: [0.03, 0.17, 0.12], top: [0.03, 0.02, 0.06, 0.38], metal: POLYMER, furniture: POLYMER },
  'fn-fal': { body: [0.38, 0.05, 0.07], at: 0.08, barrel: 0.45, bore: 0.02, fore: [0.25, 0.056, 0], stock: [0.3, 0.045, 0.1], mag: [0.04, 0.17, 0.18], brake: [0.05, 0.03], metal: STEEL, furniture: POLYMER },
  'mini-14': { body: [0.3, 0.04, 0.05], at: 0.04, barrel: 0.42, bore: 0.022, fore: [0.3, 0.05, 0], stock: [0.34, 0.046, 0.1], mag: [0.035, 0.09, 0.12], metal: CHROME, furniture: WOOD },
  'remington-700': { body: [0.25, 0.04, 0.05], at: 0.03, barrel: 0.61, bore: 0.022, fore: [0.36, 0.054, 0], stock: [0.36, 0.05, 0.12], top: [0.35, 0.044, 0.05, 0.05], side: [0.02, 0.05, -0.03], metal: BLUED, furniture: OLIVE },
  'barrett-m82': { body: [0.55, 0.07, 0.1], at: 0.12, barrel: 0.5, bore: 0.035, brake: [0.12, 0.09], stock: [0.3, 0.05, 0.12], top: [0.32, 0.05, 0.06, 0.15], mag: [0.07, 0.1, 0.16], metal: POLYMER, furniture: POLYMER },
  m249: { body: [0.45, 0.07, 0.1], at: 0.06, barrel: 0.47, bore: 0.03, fore: [0.15, 0.08, 0], stock: [0.3, 0.05, 0.12], side: [0.12, 0.09, 0.05], top: [0.12, 0.02, 0.04, 0.15], metal: POLYMER, furniture: OLIVE },
  'rpg-7': { body: [0.95, 0.045, 0.045], at: 0.1, barrel: 0, bore: 0.045, brake: [0.28, 0.085], fore: [0.22, 0.056, -0.6], stock: [0.09, 0.07, 0.07], metal: OLIVE, furniture: WOOD },
  m79: { body: [0.2, 0.05, 0.06], at: 0.02, barrel: 0.36, bore: 0.06, stock: [0.3, 0.05, 0.12], metal: BLUED, furniture: WOOD },
  flamethrower: { body: [0.25, 0.05, 0.06], at: 0.05, barrel: 0.42, bore: 0.03, brake: [0.05, 0.05], side: [0.28, 0.1, 0.12], metal: OLIVE, furniture: BRASS },
};

/**
 * The boxes one weapon is drawn as, with what is fitted to it. Bare fists are
 * no boxes at all. An attachment the model has no place for adds nothing; the
 * sim's own table of what fits is what decides what is fitted.
 */
export function weaponBoxes(id: WeaponId, attachments: readonly Attachment[] = []): WeaponBox[] {
  const form = GUNS[id];
  if (form !== undefined) return gun(form, attachments);
  return OTHERS[id]?.() ?? [];
}

function box(length: number, height: number, width: number, x: number, y: number, z: number, colour: number, part?: Attachment): WeaponBox {
  return { length, height, width, x, y, z, colour, part };
}

/** A gun, from its form, with its attachments on the places they mount. */
function gun(f: GunForm, attachments: readonly Attachment[]): WeaponBox[] {
  const [length, width, height] = f.body;
  const front = f.at + length / 2;
  const back = f.at - length / 2;
  const top = height / 2;
  const bottom = -height / 2;
  const boxes: WeaponBox[] = [box(length, height, width, f.at, 0, 0, f.metal)];
  // The grip is under the hand, which is the origin, whatever the gun.
  boxes.push(box(0.03, 0.1, width * 0.8, -0.01, bottom - 0.05, 0, f.furniture));
  const across = f.twin ? f.bore * 2 : f.bore;
  if (f.barrel > 0) boxes.push(box(f.barrel, f.bore, across, front + f.barrel / 2, 0, 0, f.metal));
  let muzzle = front + f.barrel;
  if (f.brake !== undefined) {
    boxes.push(box(f.brake[0], f.brake[1], f.brake[1], muzzle + f.brake[0] / 2, 0, 0, f.metal));
    muzzle += f.brake[0];
  }
  if (f.stock !== undefined) {
    const [sl, sw, sh] = f.stock;
    boxes.push(box(sl, sh, sw, back - sl / 2, bottom + sh / 2 - 0.01, 0, f.furniture));
  }
  if (f.fore !== undefined) {
    const [fl, fw, fs] = f.fore;
    boxes.push(box(fl, height * 0.8, fw, front + fs + fl / 2, 0, 0, f.furniture));
  }
  if (f.mag !== undefined) {
    const [ml, drop, mx] = f.mag;
    boxes.push(box(ml, drop, width * 0.7, mx, bottom - drop / 2, 0, f.metal));
  }
  if (f.top !== undefined) {
    const [tl, tw, th, tx] = f.top;
    boxes.push(box(tl, th, tw, tx, top + th / 2, 0, f.metal));
  }
  if (f.side !== undefined) {
    const [sl, reach, sx] = f.side;
    boxes.push(box(sl, height * 0.8, reach, sx, 0, width / 2 + reach / 2, f.furniture));
  }
  if (f.bulge !== undefined) boxes.push(box(f.bulge[0], height * 1.1, f.bulge[1], 0.02, 0, 0, f.metal));
  if (f.tube) boxes.push(box(f.barrel * 0.8, f.bore, f.bore, front + f.barrel * 0.4, -f.bore, 0, f.metal));

  const mount: Mount = { front, top, bottom, width, muzzle, scale: f.small ? 0.8 : 1 };
  for (const attachment of attachments) boxes.push(...attachmentBoxes(f, attachment, mount));
  return boxes;
}

/** The places on a gun its attachments mount on. */
interface Mount {
  front: number;
  top: number;
  bottom: number;
  width: number;
  /** The end of the barrel and its brake, where a suppressor goes. */
  muzzle: number;
  /** The size of an attachment on this gun: a small gun takes a smaller one. */
  scale: number;
}

/** The boxes of one attachment on a gun. */
function attachmentBoxes(f: GunForm, attachment: Attachment, m: Mount): WeaponBox[] {
  const { front, top, bottom, width, muzzle, scale } = m;
  const boxes: WeaponBox[] = [];
  switch (attachment) {
    case 'suppressor': {
      const sl = 0.17 * scale;
      const sw = Math.max(f.bore * 1.7, 0.034);
      boxes.push(box(sl, sw, sw, muzzle + sl / 2, 0, 0, POLYMER, attachment));
      break;
    }
    case 'extended-mag':
      boxes.push(...extendedMag(f, bottom, front, attachment));
      break;
    case 'optic': {
      const at = f.top !== undefined && f.top[3] < front - 0.1 ? f.top[3] + f.top[0] / 2 + 0.07 : f.at;
      boxes.push(box(0.12 * scale, 0.045, 0.036, at, top + 0.035, 0, POLYMER, attachment));
      break;
    }
    case 'laser': {
      // On the side of the front, where the camera above can see it.
      const lx = front - 0.03;
      const lz = width / 2 + 0.012;
      boxes.push(box(0.05, 0.022, 0.022, lx, bottom + 0.01, lz, POLYMER, attachment));
      boxes.push(box(0.006, 0.012, 0.012, lx + 0.028, bottom + 0.01, lz, LASER_LENS, attachment));
      break;
    }
    case 'foregrip': {
      const gx = f.fore !== undefined ? front + f.fore[2] + f.fore[0] * 0.5 : front + 0.05;
      boxes.push(box(0.035, 0.09, 0.032, gx, bottom - 0.045, 0, POLYMER, attachment));
      // A grip pad to the side, so the fit reads from above as well as below.
      boxes.push(box(0.05, 0.02, width + 0.03, gx, bottom - 0.005, 0, POLYMER, attachment));
      break;
    }
  }
  return boxes;
}

/**
 * An extended magazine: a longer box under the magazine there is, a longer tube
 * under a pump gun's barrel, or a base plate under a grip that holds the
 * magazine. The plate stands out to the side a little, because a camera above
 * sees nothing that only hangs down.
 */
function extendedMag(f: GunForm, bottom: number, front: number, part: Attachment): WeaponBox[] {
  const [, width] = f.body;
  if (f.mag !== undefined) {
    const [ml, drop, mx] = f.mag;
    return [box(ml * 1.3, drop * 0.5, width + 0.02, mx + ml * 0.15, bottom - drop * 1.2, 0, POLYMER, part)];
  }
  if (f.tube) {
    return [box(0.14, f.bore * 1.3, f.bore * 1.3, front + f.barrel + 0.07, -f.bore, 0, f.metal, part)];
  }
  return [box(0.045, 0.06, width * 1.2, -0.012, bottom - 0.13, 0, POLYMER, part)];
}

/** The weapons that are not a gun: blades, clubs, a chainsaw and what is thrown. */
const OTHERS: Readonly<Partial<Record<WeaponId, () => WeaponBox[]>>> = {
  'brass-knuckles': () => [box(0.03, 0.04, 0.1, 0.02, 0, 0, BRASS), box(0.02, 0.03, 0.07, -0.005, -0.01, 0, BRASS)],
  'baseball-bat': () => [
    box(0.32, 0.032, 0.032, 0.1, 0, 0, WOOD),
    box(0.5, 0.066, 0.066, 0.51, 0, 0, WOOD),
    box(0.02, 0.045, 0.045, -0.07, 0, 0, WOOD),
  ],
  crowbar: () => [box(0.7, 0.022, 0.022, 0.3, 0, 0, RED), box(0.03, 0.02, 0.1, 0.66, 0, 0.04, RED)],
  machete: () => [box(0.13, 0.03, 0.03, 0, 0, 0, POLYMER), box(0.45, 0.006, 0.055, 0.29, 0, 0.008, BLADE)],
  katana: () => [
    box(0.26, 0.03, 0.03, -0.05, 0, 0, POLYMER),
    box(0.012, 0.07, 0.08, 0.086, 0, 0, BRASS),
    box(0.7, 0.008, 0.032, 0.44, 0, 0, BLADE),
  ],
  switchblade: () => [box(0.11, 0.02, 0.022, 0, 0, 0, STEEL), box(0.09, 0.004, 0.018, 0.1, 0, 0, BLADE)],
  'combat-knife': () => [
    box(0.12, 0.03, 0.03, 0, 0, 0, POLYMER),
    box(0.01, 0.02, 0.07, 0.065, 0, 0, STEEL),
    box(0.18, 0.005, 0.036, 0.16, 0, 0, BLADE),
  ],
  'golf-club': () => [
    box(0.25, 0.026, 0.026, 0, 0, 0, POLYMER),
    box(0.75, 0.014, 0.014, 0.5, 0, 0, CHROME),
    box(0.05, 0.05, 0.11, 0.9, 0, 0.04, CHROME),
  ],
  chainsaw: () => [
    box(0.35, 0.22, 0.2, 0, 0, 0, ORANGE),
    box(0.45, 0.03, 0.07, 0.4, 0, 0, STEEL),
    box(0.04, 0.03, 0.22, 0.08, 0.13, 0, POLYMER),
  ],
  grenade: () => [box(0.06, 0.09, 0.06, 0, 0, 0, OLIVE), box(0.07, 0.01, 0.015, -0.01, 0.03, 0.035, STEEL)],
  molotov: () => [
    box(0.08, 0.2, 0.08, 0, 0, 0, BOTTLE),
    box(0.03, 0.06, 0.03, 0, 0.13, 0, BOTTLE),
    box(0.03, 0.08, 0.05, 0.01, 0.18, 0.02, RAG),
  ],
  'pipe-bomb': () => [
    box(0.25, 0.05, 0.05, 0, 0, 0, STEEL),
    box(0.03, 0.062, 0.062, -0.125, 0, 0, STEEL),
    box(0.03, 0.062, 0.062, 0.125, 0, 0, STEEL),
    box(0.06, 0.005, 0.005, 0.17, 0, 0, RED),
  ],
  'smoke-grenade': () => [box(0.064, 0.14, 0.064, 0, 0, 0, 0x6f7a78), box(0.1, 0.01, 0.015, 0.02, 0.06, 0.02, STEEL)],
  'tear-gas': () => [box(0.07, 0.15, 0.07, 0, 0, 0, 0x5d6a4a), box(0.03, 0.01, 0.03, 0, 0.07, 0.05, STEEL)],
};

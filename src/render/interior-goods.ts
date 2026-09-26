/**
 * What stands in a shop's room (spec section 16.1): the goods of its trade on
 * the shelves and the counter, and someone behind the counter to sell them.
 *
 * The room of `interior.ts` is read from a camera 30 m over the street, so
 * what matters is the shape and the colour of a thing seen from above: guns
 * laid flat and hung on the back wall, cans and cups in rows, figures in the
 * clothes for sale. The models are the ones the city and the shop preview
 * already draw — `WeaponArt`, `CharacterModel` and the props of
 * `shop-props.ts` — each scaled here to a real size.
 *
 * The room lies in the shadow of its own building, so the goods carry their
 * own glow, as the walls do. A light in the room would be the first point light
 * in the scene, and that would rebuild the shader of every lit thing in the
 * city on the first step through a door.
 *
 * Which goods stand where is fixed per trade, not dealt from the seed: the
 * display is scenery, and the counter of `shop-stock.ts` is what is for sale.
 */
import { Box3, BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, TorusGeometry, Vector3, type Object3D } from 'three';
import { DEFAULT_APPEARANCE, OUTFITS } from '../sim/character.ts';
import type { PropId } from '../sim/shop-goods.ts';
import type { WeaponId } from '../sim/weapon.ts';
import type { ShopKind } from '../world/shops.ts';
import { CharacterModel } from './character.ts';
import { buildProp } from './shop-props.ts';
import { WeaponArt } from './weapon.ts';

/** Where the fittings of `interior.ts` stand, in the room's frame: `z` out to the door. */
export interface Fittings {
  /** Half the room's inside width and depth. */
  halfWidth: number;
  halfDepth: number;
  /** The counter: the middle of it along `z`, its half length along `x`, and the height of its top. */
  counter: { z: number; half: number; top: number };
  /** The shelf down each side wall: the middle of it across and along the room, its half length and its top. */
  shelf: { x: number; z: number; half: number; top: number };
}

/** How much of its own colour a good gives off, a little under the walls' so it stands out on them. */
const GLOW = 0.3;

/** A weapon is dark metal, and its colours are in its vertices: it gets a faint grey glow of its own. */
const WEAPON_GLOW = 0x2a2a2a;

/** How far a shopkeeper stands behind the counter. */
const BEHIND = 0.7;

/** The long guns hung on a gun shop's back wall, and the ones laid out on its shelves and counter. */
const RACK: readonly WeaponId[] = ['ak-47', 'remington-870', 'mini-14', 'mp5'];
const LAID: readonly WeaponId[] = ['beretta-92fs', 'desert-eagle', 'uzi', 'glock-17', 'sawn-off', 'machete'];
const COUNTER_GUNS: readonly WeaponId[] = ['colt-m1911', 'sig-p226'];

/** The goods of each trade that is shelved as props, in the order they fill a shelf. */
const SHELVED: Readonly<Partial<Record<ShopKind, readonly PropId[]>>> = {
  convenience: ['soda', 'energy', 'coffee', 'donut', 'sandwich', 'hotdog', 'noodles', 'burger'],
  clinic: ['medkit', 'bandage', 'naloxone', 'strips', 'works', 'treatment'],
  broker: ['house', 'house', 'house'],
  weapons: ['ammo', 'ammo'],
};

/** What stands on the counter of each trade, beside the till. */
const ON_COUNTER: Readonly<Record<ShopKind, readonly PropId[]>> = {
  weapons: ['ammo'],
  workshop: ['wrench'],
  convenience: ['coffee', 'burger'],
  clothing: [],
  clinic: ['treatment'],
  broker: ['house'],
};

/** The colours of the paint tins in a workshop and of the folded clothes in a clothing shop. */
const TINS = [0xb03a2e, 0x2e6fb0, 0xe0c030, 0x2e9a5a, 0xf2ede6, 0x222222];

/** The colours a prop is drawn in on a shelf, one per row, so a shelf is not one colour. */
const WRAPPERS = [0xc03030, 0x2e6fb0, 0xe0a030, 0x3a9a5a];

/** The goods of one room, and how to let all of them go. */
export class InteriorGoods {
  readonly group = new Group();
  private readonly releases: (() => void)[] = [];
  private readonly weapons = new WeaponArt();

  constructor(kind: ShopKind, fittings: Fittings) {
    this.weapons.material.emissive = new Color(WEAPON_GLOW);
    this.stock(kind, fittings);
    this.keeper(kind, fittings);
  }

  dispose(): void {
    for (const release of this.releases) release();
    this.releases.length = 0;
    this.group.clear();
    this.weapons.dispose();
  }

  private stock(kind: ShopKind, f: Fittings): void {
    this.shelves(kind, f.shelf);
    // The counter: the goods of the trade at one end, the till at the other.
    const { counter } = f;
    const goods = ON_COUNTER[kind];
    goods.forEach((id, i) => {
      this.prop(id, new Vector3(-counter.half * (0.6 - i * 0.3), counter.top, counter.z), 0.3, WRAPPERS[i % 4] as number);
    });
    this.box(0.35, 0.22, 0.3, 0x2a2320, new Vector3(counter.half * 0.6, counter.top, counter.z));
    if (kind === 'weapons') this.armoury(f);
    if (kind === 'clothing') this.figures(f);
    if (kind === 'workshop') this.tyres(f);
  }

  /** Along each shelf, spaced evenly, a row of goods on its top. */
  private shelves(kind: ShopKind, shelf: Fittings['shelf']): void {
    const slots = Math.max(2, Math.floor((2 * shelf.half) / 0.55));
    for (const side of [-1, 1]) {
      for (let i = 0; i < slots; i++) {
        const z = shelf.z - shelf.half + ((i + 0.5) / slots) * 2 * shelf.half;
        this.shelved(kind, i, i + (side > 0 ? slots : 0), new Vector3(side * shelf.x, shelf.top, z), side);
      }
    }
  }

  /** The good in slot `i` of a shelf, the `n`th along both shelves. */
  private shelved(kind: ShopKind, i: number, n: number, at: Vector3, side: number): void {
    const shelved = SHELVED[kind] ?? [];
    if (kind === 'weapons' && i % 2 === 0) this.gun(LAID[n % LAID.length] as WeaponId, at, 0.55, side);
    else if (kind === 'workshop') this.tin(TINS[n % TINS.length] as number, at);
    else if (kind === 'clothing') this.folded(TINS[n % TINS.length] as number, at);
    else if (shelved.length > 0) this.prop(shelved[n % shelved.length] as PropId, at, 0.32, WRAPPERS[i % 4] as number);
  }

  /** Guns on the counter, and the long guns on the back wall. */
  private armoury(f: Fittings): void {
    const { counter } = f;
    COUNTER_GUNS.forEach((id, i) => this.gun(id, new Vector3((i - 0.5) * 0.5, counter.top, counter.z), 0.3, 1));
    // The long guns hang on the back wall, one over another, above the counter's height.
    RACK.forEach((id, i) => this.hung(id, new Vector3(0, 1.3 + i * 0.42, -f.halfDepth + 0.08), 1.1));
  }

  /** Figures in the clothes for sale, in a row across the middle of the floor. */
  private figures(f: Fittings): void {
    const count = Math.min(4, Math.max(2, Math.floor((2 * f.halfWidth) / 1.2)));
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) / 2) * ((1.6 * f.halfWidth) / count);
      this.figure(i + 1, new Vector3(x, 0, f.halfDepth * 0.3), -Math.PI / 2);
    }
  }

  /** A stack of tyres in each back corner. */
  private tyres(f: Fittings): void {
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        this.tyre(new Vector3(side * (f.halfWidth - 0.5), 0.1 + i * 0.2, -f.halfDepth + 0.5));
      }
    }
  }

  /** The one who sells: behind the counter, facing the door. */
  private keeper(kind: ShopKind, f: Fittings): void {
    this.figure(keeperOutfit(kind), new Vector3(0, 0, f.counter.z - BEHIND), -Math.PI / 2);
  }

  /** Add an object to the room, scaled so its longest side is `size` metres, standing at `at`. */
  private place(object: Object3D, at: Vector3, size: number): void {
    object.updateMatrixWorld(true);
    const box = new Box3().setFromObject(object);
    const extent = box.getSize(new Vector3());
    const scale = size / Math.max(extent.x, extent.y, extent.z, 1e-6);
    const centre = box.getCenter(new Vector3());
    object.scale.multiplyScalar(scale);
    object.position.set(at.x - centre.x * scale, at.y - box.min.y * scale, at.z - centre.z * scale);
    this.group.add(object);
  }

  private prop(id: PropId, at: Vector3, size: number, colour: number): void {
    const prop = buildProp(id, colour);
    glow(prop.group);
    this.place(prop.group, at, size);
    this.releases.push(() => prop.dispose());
  }

  /** A weapon laid flat, its side up, so the camera overhead sees its shape. */
  private gun(id: WeaponId, at: Vector3, size: number, side: number): void {
    const geometry = this.weapons.geometry(id, []);
    if (geometry === undefined) return;
    const mesh = new Mesh(geometry, this.weapons.material);
    mesh.rotation.set(-Math.PI / 2, side > 0 ? Math.PI / 2 : -Math.PI / 2, 0, 'YXZ');
    const held = new Group();
    held.add(mesh);
    this.place(held, at, size);
  }

  /** A weapon hung on the back wall, muzzle across the room. */
  private hung(id: WeaponId, at: Vector3, size: number): void {
    const geometry = this.weapons.geometry(id, []);
    if (geometry === undefined) return;
    const mesh = new Mesh(geometry, this.weapons.material);
    const held = new Group();
    held.add(mesh);
    this.place(held, at, size);
  }

  private figure(outfit: number, at: Vector3, facing: number): void {
    const model = new CharacterModel({ ...DEFAULT_APPEARANCE, outfit: outfit % OUTFITS.length });
    glow(model.group);
    model.group.rotation.y = facing;
    model.group.position.copy(at);
    this.group.add(model.group);
    this.releases.push(() => model.dispose());
  }

  private box(width: number, height: number, depth: number, colour: number, at: Vector3): Mesh {
    const geometry = new BoxGeometry(width, height, depth);
    const material = glowing(colour);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(at.x, at.y + height / 2, at.z);
    this.group.add(mesh);
    this.releases.push(() => {
      geometry.dispose();
      material.dispose();
    });
    return mesh;
  }

  /** A tin of paint: a short drum. A box reads the same from 30 m and costs less. */
  private tin(colour: number, at: Vector3): void {
    for (const dz of [-0.12, 0.12]) this.box(0.18, 0.22, 0.18, colour, new Vector3(at.x, at.y, at.z + dz));
  }

  /** A pile of folded clothes. */
  private folded(colour: number, at: Vector3): void {
    this.box(0.34, 0.14, 0.3, colour, at);
  }

  private tyre(at: Vector3): void {
    const geometry = new TorusGeometry(0.3, 0.1, 8, 20);
    const material = glowing(0x1c1c1c);
    const mesh = new Mesh(geometry, material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.copy(at);
    this.group.add(mesh);
    this.releases.push(() => {
      geometry.dispose();
      material.dispose();
    });
  }
}

function glowing(colour: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: colour, roughness: 0.7, emissive: new Color(colour), emissiveIntensity: GLOW });
}

/** Make every surface of a model give off its own colour. The model owns its materials, so they are changed in place. */
function glow(object: Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const material = child.material as MeshStandardMaterial;
    if (!(material instanceof MeshStandardMaterial) || material.vertexColors) return;
    material.emissive = material.color.clone();
    material.emissiveIntensity = GLOW;
  });
}

/** What the one behind the counter wears. */
function keeperOutfit(kind: ShopKind): number {
  if (kind === 'clinic') return 4;
  if (kind === 'broker') return 3;
  return 0;
}

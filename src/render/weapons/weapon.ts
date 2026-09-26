/**
 * The weapons, drawn (spec section 11.6): the one in the player's hands, and
 * the geometry every drawn weapon shares.
 *
 * The shape comes from `weapon-mesh.ts`. This merges one weapon's boxes into
 * one geometry with a colour per vertex, so a weapon is one draw call whatever
 * is fitted to it. A weapon with the same attachments is the same geometry, so
 * a street of dropped pistols builds the pistol once.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PlayerState } from '../../sim/player/on-foot.ts';
import { currentSlot, normaliseAttachments, weaponOf, type Attachment, type LoadoutState, type WeaponId } from '../../sim/weapons/weapon.ts';
import { weaponBoxes, type WeaponBox } from './weapon-mesh.ts';
import { swingAngle } from '../people/character-pose.ts';

/** The geometry and the material every drawn weapon is made of. */
export class WeaponArt {
  readonly material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 });
  private readonly built = new Map<string, BufferGeometry | undefined>();

  /**
   * The geometry of one weapon with what is fitted to it, or undefined where
   * there is nothing to draw: bare fists. It is built once per weapon and list,
   * and belongs to this art until {@link WeaponArt.dispose}.
   */
  geometry(id: WeaponId, attachments: readonly Attachment[]): BufferGeometry | undefined {
    const list = normaliseAttachments(weaponOf(id), attachments);
    const key = `${id}|${list.join(',')}`;
    if (this.built.has(key)) return this.built.get(key);
    const geometry = weaponGeometry(weaponBoxes(id, list));
    this.built.set(key, geometry);
    return geometry;
  }

  /** How many geometries have been built, which the tests read. */
  get size(): number {
    return this.built.size;
  }

  dispose(): void {
    for (const geometry of this.built.values()) geometry?.dispose();
    this.built.clear();
    this.material.dispose();
  }
}

/** Merge a weapon's boxes into one geometry, each vertex carrying the colour of its box. */
export function weaponGeometry(boxes: readonly WeaponBox[]): BufferGeometry | undefined {
  if (boxes.length === 0) return undefined;
  const colour = new Color();
  const parts = boxes.map((b) => {
    const geometry = new BoxGeometry(b.length, b.height, b.width);
    geometry.translate(b.x, b.y, b.z);
    const count = geometry.getAttribute('position').count;
    const colours = new Float32Array(count * 3);
    colour.setHex(b.colour);
    for (let i = 0; i < count; i++) colours.set([colour.r, colour.g, colour.b], i * 3);
    geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
    return geometry;
  });
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged;
}

/** Metres in front of the player's middle the hand holds a weapon. */
const HOLD_REACH = 0.3;

/** Metres to the side of the player's middle the weapon is held, toward the hand that holds it. */
const HOLD_SIDE = 0.14;

/** Metres the arm reaches further out while a blow is thrown. */
const SWING_EXTEND = 0.25;

/** Radians the weapon is thrown down through the arc at the middle of a swing. */
const SWING_PITCH = 0.7;

/**
 * How high the weapon is held, as a share of the player's height: at the hip,
 * and at the shoulder while aiming (spec section 11.5).
 */
const HIP_HEIGHT = 0.55;
const AIM_HEIGHT = 0.74;

/** Radians the muzzle is thrown up by a shot at its strongest. */
const KICK_TILT = 0.35;

/**
 * The weapon in the player's hands. It is posed like the character: the group
 * takes the player's place and heading, and the mesh inside it stands where
 * the hand is. It is drawn only on foot, since a weapon fired from a seat is
 * inside the vehicle.
 */
export class HeldWeapon {
  readonly group = new Group();
  private readonly mesh: Mesh;
  /**
   * The hand, turned about the player's up axis. The weapon hangs off it at
   * arm's length, so turning this carries the weapon round the player on an
   * arc, which is what a swing is (spec section 11.6).
   */
  private readonly hand = new Group();
  private readonly art: WeaponArt;
  /** What the mesh holds before a weapon is first shown. */
  private readonly empty = new BufferGeometry();

  constructor(art: WeaponArt) {
    this.art = art;
    this.mesh = new Mesh(this.empty, art.material);
    this.mesh.castShadow = true;
    this.mesh.visible = false;
    this.hand.add(this.mesh);
    this.group.add(this.hand);
  }

  /**
   * Show what the record says is in the hands, where the drawn player stands.
   * `height` is the character's height, so a tall body holds it higher.
   *
   * `grip` is where the model's right fist is, in its own frame, while its arms
   * hold a gun (`character-hold.ts`). The gun is drawn in that fist, level and
   * along the heading, and `kick` throws its muzzle up after a shot. Without a
   * grip — a swing, or a swimmer — it is carried at a fixed place instead.
   */
  set(
    loadout: LoadoutState,
    player: PlayerState,
    pose: { x: number; y: number; height: number; heading: number },
    height: number,
    swing = -1,
    grip?: Vector3,
    kick = 0,
  ): void {
    const slot = currentSlot(loadout);
    const geometry = player.driving ? undefined : this.art.geometry(slot.id, slot.attachments ?? []);
    this.mesh.visible = geometry !== undefined;
    if (geometry === undefined) return;
    this.mesh.geometry = geometry;
    this.group.position.set(pose.x, pose.height, pose.y);
    // A yaw of -heading turns local +x, where the muzzle points, along the heading.
    this.group.rotation.y = -pose.heading;
    const swinging = swing >= 0;
    if (grip !== undefined && !swinging) {
      this.hand.rotation.set(0, 0, 0);
      this.mesh.position.copy(grip);
      this.mesh.rotation.z = kick * KICK_TILT;
      return;
    }
    this.mesh.rotation.z = 0;
    // The hand follows the arm of `character-pose.ts`, so the weapon is where
    // the hand that holds it is, all the way through the blow.
    this.hand.rotation.y = swinging ? swingAngle(swing) : 0;
    // And the weapon is thrown down through the arc rather than carried level:
    // a bat comes down on what it meets.
    this.hand.rotation.z = swinging ? -SWING_PITCH * Math.sin(Math.PI * Math.min(1, swing)) : 0;
    this.mesh.position.set(
      HOLD_REACH + (swinging ? SWING_EXTEND : 0),
      height * (loadout.aiming && !swinging ? AIM_HEIGHT : HIP_HEIGHT),
      HOLD_SIDE,
    );
  }

  /** Put the weapon away for a frame: the hands are on a car door (`boarding.ts`). */
  stow(): void {
    this.mesh.visible = false;
  }

  /** True while a weapon is drawn in the hands. */
  get shown(): boolean {
    return this.mesh.visible;
  }

  dispose(): void {
    this.group.clear();
    this.empty.dispose();
  }
}

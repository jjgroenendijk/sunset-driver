/**
 * The weapon in view in first person (spec sections 10.7, 11.6): the gun and
 * the forearms holding it, drawn low and to the right of the view as a shooter
 * draws them, and raised to the eye while aiming.
 *
 * The body the other views draw stands behind the eyes in first person and
 * its weapon hangs below the frame, so this stands in for both. It is placed
 * in the camera's own frame every frame, after the camera has moved, and is
 * render state only: it reads the record and writes nothing.
 *
 * Everything it does is read off the record at the drawn tick, so a frame
 * between two ticks is posed between them: the kick after a shot, the dip of
 * a reload, the arc of a swing and the throw of a grenade. What only the
 * renderer knows — the walk's bob and the sway as the view turns — is eased
 * in render time.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Camera,
} from 'three';
import { resolveAppearance, type CharacterAppearance } from '../sim/character.ts';
import { swingOf } from '../sim/melee.ts';
import { currentSlot, currentWeapon, reloading, type LoadoutState, type WeaponSpec } from '../sim/weapon.ts';
import type { WeaponArt } from './weapon.ts';

/** Where the grip stands in the camera's frame at the hip and aimed: right, up, back (the view looks along -z). */
const HIP_LONG = new Vector3(0.17, -0.19, -0.4);
const AIM_LONG = new Vector3(0, -0.105, -0.44);
const HIP_SHORT = new Vector3(0.16, -0.15, -0.42);
const AIM_SHORT = new Vector3(0, -0.075, -0.4);
const HIP_TUBE = new Vector3(0.2, -0.12, -0.34);
const AIM_TUBE = new Vector3(0.06, -0.1, -0.34);
const MELEE = new Vector3(0.24, -0.26, -0.42);
const THROW = new Vector3(0.22, -0.2, -0.36);

/** Where the elbows stand, off the bottom corners of the view. */
const ELBOW_RIGHT = new Vector3(0.28, -0.4, -0.2);
const ELBOW_LEFT = new Vector3(-0.1, -0.42, -0.28);

/**
 * How much larger than life a pistol or an SMG is drawn in view. A real one is
 * a hand's length, and at arm's length the hand holding it hides most of it.
 */
const SHORT_SCALE = 1.45;

/** How fast the raise to the eye goes, in e-foldings a second. */
const AIM_RATE = 14;

/** Radians the view has to turn in a frame to throw the weapon to the other side, and how far it is thrown. */
const SWAY_PER_RADIAN = 0.18;
const SWAY_MAX = 0.05;
const SWAY_RATE = 9;

/** Metres of bob at a run, and radians of walk cycle per metre covered. */
const BOB = 0.014;
const BOB_PER_METRE = 2.4;

/** Ticks the kick of a shot takes to settle, and how long a flash stands at the muzzle. */
const KICK_TICKS = 9;
const FLASH_TICKS = 2.5;

/** Ticks a throw takes, from the arm drawn back to the hand empty. */
const THROW_TICKS = 18;

/** The size of the forearms and hands, in metres. */
const ARM = 0.06;
const HAND = new Vector3(0.055, 0.05, 0.085);

/** How the weapon in hand is held. */
type Carry = 'fists' | 'short' | 'long' | 'tube' | 'melee' | 'thrown';

/** Where a gun is held at the hip, and where at the eye. */
function stanceOf(carry: Carry): readonly [Vector3, Vector3] {
  if (carry === 'tube') return [HIP_TUBE, AIM_TUBE];
  if (carry === 'short') return [HIP_SHORT, AIM_SHORT];
  return [HIP_LONG, AIM_LONG];
}

/** How far forward of the grip the left hand holds a gun. */
function foreOf(carry: Carry, muzzle: number): number {
  if (carry === 'short') return 0.02;
  if (carry === 'tube') return 0.28;
  return Math.min(0.32, muzzle * 0.45);
}

/** How big the flash at the muzzle is: a pilot flame small or firing, a shot's flash shrinking. */
function flashSize(pilot: boolean, firing: boolean, age: number, spec: WeaponSpec): number {
  if (pilot) return firing ? 0.16 : 0.05;
  return 0.22 * (1 - age / FLASH_TICKS / 2) * (spec.projectile ? 2 : 1);
}

function carryOf(spec: WeaponSpec): Carry {
  if (spec.id === 'fists' || spec.id === 'brass-knuckles') return 'fists';
  if (spec.cls === 'melee') return 'melee';
  if (spec.cls === 'thrown') return 'thrown';
  if (spec.id === 'rpg-7') return 'tube';
  if (spec.cls === 'pistol' || spec.cls === 'smg') return 'short';
  return 'long';
}

/** How hard a shot of this weapon throws the view model back, 0 to 1. */
export function kickOf(spec: WeaponSpec): number {
  if (spec.effect === 'fire') return 0.08;
  if (spec.projectile !== undefined) return 1;
  return Math.min(1, 0.25 + spec.recoil * 12);
}

/**
 * How far first person zooms in while the weapon in hand is aimed: a little
 * for a pistol, more for a long gun, and a scope's worth for a precision rifle
 * or a gun with an optic fitted. A weapon that is not aimed does not zoom.
 */
export function zoomOf(loadout: LoadoutState): number {
  if (!loadout.aiming) return 1;
  const spec = currentWeapon(loadout);
  if (spec.cls === 'melee' || spec.cls === 'thrown') return 1;
  if (spec.cls === 'precision') return 3;
  if (spec.sight > 1) return 2;
  if (spec.cls === 'pistol' || spec.cls === 'smg') return 1.15;
  return 1.35;
}

/** The weapon, the forearms and the flash of first person. */
export class ViewModel {
  readonly group = new Group();
  private readonly rig = new Group();
  private readonly weapon: Mesh;
  private readonly flash: Mesh;
  private readonly skin = new MeshStandardMaterial({ roughness: 0.8 });
  private readonly sleeve = new MeshStandardMaterial({ roughness: 0.9 });
  private readonly arms: Mesh[] = [];
  private readonly hands: Mesh[] = [];
  private readonly art: WeaponArt;
  private readonly box = new BoxGeometry(1, 1, 1);
  private readonly empty: BufferGeometry;
  /** How far the weapon is raised to the eye, eased. */
  private aimed = 0;
  private swayX = 0;
  private swayY = 0;
  private lastYaw = Number.NaN;
  private lastPitch = 0;
  private cycle = 0;
  /** Where the muzzle is along the weapon's own `+x`, for the flash. */
  private muzzle = 0.3;
  private shown: BufferGeometry | undefined;
  private dressed = '';
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly q = new Quaternion();
  private readonly forward = new Vector3(0, 0, 1);

  constructor(art: WeaponArt) {
    this.art = art;
    this.empty = new BoxGeometry(0, 0, 0);
    this.weapon = new Mesh(this.empty, art.material);
    this.weapon.rotation.order = 'YXZ';
    const disc = new CircleGeometry(0.5, 12);
    this.flash = new Mesh(
      disc,
      new MeshBasicMaterial({ color: 0xffd48a, transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false }),
    );
    this.flash.visible = false;
    for (let i = 0; i < 2; i++) {
      const arm = new Mesh(this.box, this.sleeve);
      const hand = new Mesh(this.box, this.skin);
      this.arms.push(arm);
      this.hands.push(hand);
      this.rig.add(arm, hand);
    }
    this.rig.add(this.weapon, this.flash);
    this.group.add(this.rig);
    this.group.visible = false;
    this.group.traverse((object) => {
      object.frustumCulled = false;
      object.castShadow = false;
      object.receiveShadow = false;
    });
  }

  /** Hide it: another view, a seat, a menu or a detached camera. */
  hide(): void {
    this.group.visible = false;
    this.lastYaw = Number.NaN;
  }

  /**
   * Stand the weapon in front of `camera` for this frame. `tick` is the drawn
   * tick, which may fall between two; `yaw` and `pitch` are where the view
   * looks, so turning it sways the weapon; `speed` is how fast the player
   * walks, which bobs it.
   */
  update(
    camera: Camera,
    loadout: LoadoutState,
    look: CharacterAppearance,
    tick: number,
    dt: number,
    view: { yaw: number; pitch: number; speed: number; grounded: boolean },
  ): void {
    this.dress(look);
    const spec = currentWeapon(loadout);
    const slot = currentSlot(loadout);
    const carry = carryOf(spec);
    const geometry = carry === 'fists' ? undefined : this.art.geometry(slot.id, slot.attachments ?? []);
    if (geometry !== this.shown) {
      this.shown = geometry;
      this.weapon.geometry = geometry ?? this.empty;
      geometry?.computeBoundingBox();
      this.muzzle = geometry?.boundingBox?.max.x ?? 0.3;
    }
    this.group.visible = true;
    this.group.position.copy(camera.position);
    this.group.quaternion.copy(camera.quaternion);

    const ease = 1 - Math.exp(-AIM_RATE * dt);
    const canAim = carry === 'short' || carry === 'long' || carry === 'tube';
    this.aimed += ((loadout.aiming && canAim ? 1 : 0) - this.aimed) * ease;
    this.swayBy(view.yaw, view.pitch, dt);
    if (view.grounded) this.cycle += Math.abs(view.speed) * dt * BOB_PER_METRE;
    const walk = Math.min(1, Math.abs(view.speed) / 6) * (1 - this.aimed * 0.8);
    const bobX = Math.sin(this.cycle) * BOB * walk;
    const bobY = -Math.abs(Math.cos(this.cycle)) * BOB * walk;

    const age = loadout.firedTick >= 0 ? tick - loadout.firedTick : Infinity;
    const kick = age >= 0 && age < KICK_TICKS ? (1 - age / KICK_TICKS) ** 2 * kickOf(spec) : 0;
    const reload = reloading(loadout) && spec.reloadTicks > 0
      ? Math.min(1, Math.max(0, 1 - (loadout.reloadTick - tick) / spec.reloadTicks))
      : -1;
    // A reload takes the weapon down and out of the way and brings it back.
    const dip = reload >= 0 ? Math.sin(Math.PI * reload) : 0;

    this.rig.position.set(this.swayX + bobX, this.swayY + bobY - dip * 0.12, 0);
    this.rig.rotation.set(0, 0, 0);
    this.weapon.visible = geometry !== undefined;
    this.flash.visible = false;
    this.weapon.scale.setScalar(1);

    if (carry === 'fists') this.fists(swingOf(loadout, tick), loadout.shots);
    else if (carry === 'melee') this.swing(swingOf(loadout, tick));
    else if (carry === 'thrown') this.toss(age, reload);
    else this.gun(carry, kick, dip, age, spec);
  }

  /** A gun: at the hip or at the eye, kicked back and up by a shot, with a flash at the muzzle. */
  private gun(carry: Carry, kick: number, dip: number, age: number, spec: WeaponSpec): void {
    const [hip, aim] = stanceOf(carry);
    const at = this.a.copy(hip).lerp(aim, this.aimed);
    at.z += kick * 0.07;
    at.y += kick * 0.015;
    this.weapon.position.copy(at);
    // Muzzle along -z: a quarter turn about up. The kick lifts the muzzle,
    // and a reload rolls the weapon over to its magazine and tips it down.
    this.weapon.rotation.set(dip * 0.6, Math.PI / 2, kick * 0.18 - dip * 0.3, 'YXZ');
    this.weapon.scale.setScalar(carry === 'short' ? SHORT_SCALE : 1);
    this.weapon.updateMatrix();
    // The right hand on the grip, the left along the barrel: a pistol takes
    // both hands at the grip, a long gun the left under the handguard.
    const fore = foreOf(carry, this.muzzle);
    // The fist wraps the grip below the bore, so the slide or the receiver
    // shows over it. A pistol is held in one hand at the hip, and the other
    // comes up under it only to aim.
    this.hand(0, this.local(-0.035, -0.075, 0.005), ELBOW_RIGHT);
    if (carry !== 'short') this.hand(1, this.local(fore, -0.045, 0), ELBOW_LEFT);
    else if (this.aimed > 0.5) this.hand(1, this.local(-0.03, -0.085, -0.03), ELBOW_LEFT);
    else this.drop(1);
    this.muzzleFlash(age, spec);
  }

  /**
   * The flash at the muzzle for a few ticks after a shot, unless the gun is
   * suppressed. A flamethrower shows a pilot flame instead, which flares as it fires.
   */
  private muzzleFlash(age: number, spec: WeaponSpec): void {
    const flashing = age >= 0 && age < FLASH_TICKS && spec.effect !== 'fire' && !spec.suppressed;
    const pilot = spec.effect === 'fire';
    if (!flashing && !pilot) return;
    this.flash.visible = true;
    this.flash.position.copy(this.local(this.muzzle + 0.04, 0, 0));
    this.flash.quaternion.identity();
    const firing = pilot && age >= 0 && age < 8;
    const size = flashSize(pilot, firing, age, spec);
    this.flash.scale.set(size, size, size);
    (this.flash.material as MeshBasicMaterial).color.setHex(pilot && !firing ? 0x7fa8ff : 0xffd48a);
  }

  /** A melee weapon: carried up at the right, swung across the view from right to left. */
  private swing(p: number): void {
    const t = p < 0 ? 0 : p;
    const arc = p < 0 ? 0 : Math.sin(Math.PI * t);
    const at = this.a.copy(MELEE);
    at.x -= arc * 0.3 + (p < 0 ? 0 : t * 0.1);
    at.y += arc * 0.05;
    at.z -= arc * 0.12;
    this.weapon.position.copy(at);
    // The blade stands up and forward, and comes down and across through the blow.
    const up = 1.1 - (p < 0 ? 0 : 1.6 * t);
    const across = p < 0 ? 0.25 : 0.25 + 1.2 * t;
    this.weapon.rotation.set(0, Math.PI / 2 + across, up, 'YXZ');
    this.weapon.updateMatrix();
    this.hand(0, this.local(0, 0, 0), ELBOW_RIGHT);
    this.drop(1);
  }

  /** Bare fists: both up, the one that throws the blow driven out at the middle of the view. */
  private fists(p: number, shots: number): void {
    this.weapon.visible = false;
    const punch = p < 0 ? 0 : Math.sin(Math.PI * Math.min(1, p * 1.4));
    const left = shots % 2 === 0;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const out = (i === 1) === left ? punch : 0;
      this.b.set(side * (0.15 - out * 0.11), -0.15 + out * 0.06, -0.36 - out * 0.2);
      this.hand(i, this.b, i === 0 ? ELBOW_RIGHT : ELBOW_LEFT);
    }
  }

  /** A grenade or a bottle in the right hand: drawn back and thrown, and the hand empty until the next is out. */
  private toss(age: number, reload: number): void {
    const throwing = age >= 0 && age < THROW_TICKS;
    const t = throwing ? age / THROW_TICKS : 0;
    const at = this.a.copy(THROW);
    // Back over the shoulder, then over and forward.
    at.y += throwing ? Math.sin(Math.PI * t) * 0.18 : 0;
    at.z += throwing ? 0.15 * Math.cos(Math.PI * t) - 0.15 * t : 0;
    this.weapon.position.copy(at);
    this.weapon.rotation.set(0, Math.PI / 2, 0.4, 'YXZ');
    this.weapon.updateMatrix();
    this.weapon.visible = this.weapon.visible && !(throwing && t > 0.55) && reload < 0;
    this.hand(0, this.local(0, -0.02, 0), ELBOW_RIGHT);
    this.drop(1);
  }

  /** Take hand `i` and its forearm out of the view. */
  private drop(i: number): void {
    (this.hands[i] as Mesh).visible = false;
    (this.arms[i] as Mesh).visible = false;
  }

  /** A point of the weapon's own frame, in the rig's. */
  private local(x: number, y: number, z: number): Vector3 {
    return this.b.set(x, y, z).applyMatrix4(this.weapon.matrix);
  }

  /** Put hand `i` at `at` in the rig's frame, with its forearm back to `elbow`. */
  private hand(i: number, at: Vector3, elbow: Vector3): void {
    const hand = this.hands[i] as Mesh;
    const arm = this.arms[i] as Mesh;
    hand.visible = true;
    arm.visible = true;
    const dir = this.a.copy(at).sub(elbow);
    const length = dir.length();
    dir.divideScalar(length || 1);
    this.q.setFromUnitVectors(this.forward, dir);
    hand.position.copy(at);
    hand.quaternion.copy(this.q);
    hand.scale.copy(HAND);
    arm.position.copy(elbow).addScaledVector(dir, (length - HAND.z / 2) / 2);
    arm.quaternion.copy(this.q);
    arm.scale.set(ARM, ARM, Math.max(0.01, length - HAND.z / 2));
  }

  /** Lag the weapon behind a turn of the view, so it swings as the head does. */
  private swayBy(yaw: number, pitch: number, dt: number): void {
    if (Number.isNaN(this.lastYaw)) {
      this.lastYaw = yaw;
      this.lastPitch = pitch;
    }
    let turn = yaw - this.lastYaw;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    const tilt = pitch - this.lastPitch;
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    const clamp = (v: number): number => Math.max(-SWAY_MAX, Math.min(SWAY_MAX, v));
    this.swayX = clamp(this.swayX + turn * SWAY_PER_RADIAN);
    this.swayY = clamp(this.swayY - tilt * SWAY_PER_RADIAN);
    const settle = Math.exp(-SWAY_RATE * dt);
    this.swayX *= settle;
    this.swayY *= settle;
  }

  /** Colour the hands and sleeves as the player is dressed. */
  private dress(look: CharacterAppearance): void {
    const resolved = resolveAppearance(look);
    const key = `${resolved.skin.colour}|${resolved.outfit.top}`;
    if (key === this.dressed) return;
    this.dressed = key;
    this.skin.color.setHex(resolved.skin.colour);
    this.sleeve.color.setHex(resolved.outfit.top);
  }

  dispose(): void {
    this.group.clear();
    this.box.dispose();
    this.empty.dispose();
    this.flash.geometry.dispose();
    (this.flash.material as MeshBasicMaterial).dispose();
    this.skin.dispose();
    this.sleeve.dispose();
  }
}

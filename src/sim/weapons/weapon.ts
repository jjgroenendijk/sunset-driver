/**
 * The arsenal of spec section 11.6: what a weapon is, and what firing one does.
 *
 * This holds the numbers one weapon is made of and the pure rules of one tick
 * of firing. The rows of the table are `arsenal.ts` and what the player is
 * carrying is `loadout.ts`; both are re-exported here, so this file stays the
 * one door onto the model. Nothing in any of the three touches Rapier or the
 * DOM, so the whole model can be read and tested headless. `physics.ts` is the
 * Rapier half: it casts the rays, sweeps the melee arcs and flies the thrown
 * things through the world.
 *
 * Every roll comes from `rngFor(seed, tick, Subsystem.Weapons, shot)`, so the
 * same trigger pull at the same tick of the same seed throws its pellets the
 * same way. The shot counter is part of the record, which is what keeps a
 * replay in step with the session it replays.
 *
 * What an attachment does to a weapon is `attachment.ts`: a fitted weapon is a
 * row like any other, so nothing here asks what is fitted. What lies on the
 * ground to be picked up is `pickup.ts`, and what a weapon looks like is
 * `src/render/weapons/weapon-mesh.ts`. The weapon shops and the faction arsenals are
 * spec section 16.
 */
import { rngFor, Subsystem } from '../../core/rng.ts';
import { cos, sin } from '../../core/libm.ts';
import { TICK_RATE } from '../clock.ts';
import type { InputFrame } from '../input.ts';
import type { PlayerState } from '../player/on-foot.ts';
import { weaponOf } from './arsenal.ts';
import {
  beginReload,
  currentSlot,
  currentWeapon,
  cycleWeapon,
  finishReload,
  reloading,
  type LoadoutState,
} from './loadout.ts';

// The table and the record live next door. Both come out through this file, so
// nothing outside `src/sim` needs to know which of the three holds what.
export { ARSENAL, DEFAULT_WEAPON, WEAPON_IDS, weaponOf } from './arsenal.ts';
export {
  ATTACHMENTS,
  EXTENDED_MAG,
  FOREGRIP_RECOIL,
  LASER_HIP,
  OPTIC_RANGE,
  fits,
  fitsOf,
  fitted,
  normaliseAttachments,
  type Attachment,
} from './attachment.ts';
export {
  addAmmo,
  fitAttachment,
  removeAttachment,
  showsLongGun,
  slotSpec,
  takeWeapon,
  beginReload,
  createLoadout,
  currentSlot,
  currentWeapon,
  cycleWeapon,
  giveWeapon,
  poolOf,
  reloading,
  selectWeapon,
  SPARE_MAGAZINES,
  type LoadoutState,
} from './loadout.ts';

/** The classes of the spec's table, in the order the debug picker shows them. */
export type WeaponClass = 'melee' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'precision' | 'heavy' | 'thrown';

/** Every class, in picker order. Nothing else should list them. */
export const WEAPON_CLASSES: readonly WeaponClass[] = [
  'melee',
  'pistol',
  'smg',
  'shotgun',
  'rifle',
  'precision',
  'heavy',
  'thrown',
];

/**
 * The ammunition pools. A calibre is what the spec's table names in brackets,
 * so two weapons that take the same cartridge draw on the same pool; a thrown
 * weapon is its own pool, because a grenade is not a cartridge.
 *
 * `.308` and 7.62×51 are the same cartridge in life and two rows in the spec's
 * table, so they are two pools here: the table is the source of truth.
 */
export type Calibre =
  | '9×19'
  | '.45 ACP'
  | '.44 Magnum'
  | '.50 AE'
  | '12 gauge'
  | '7.62×39'
  | '5.56×45'
  | '7.62×51'
  | '.308'
  | '.50 BMG'
  | '40 mm'
  | 'rocket'
  | 'fuel'
  | 'grenade'
  | 'molotov'
  | 'pipe bomb'
  | 'smoke'
  | 'tear gas';

/** Every pool, in a fixed order, so nothing has to iterate a record's keys. */
export const CALIBRES: readonly Calibre[] = [
  '9×19',
  '.45 ACP',
  '.44 Magnum',
  '.50 AE',
  '12 gauge',
  '7.62×39',
  '5.56×45',
  '7.62×51',
  '.308',
  '.50 BMG',
  '40 mm',
  'rocket',
  'fuel',
  'grenade',
  'molotov',
  'pipe bomb',
  'smoke',
  'tear gas',
];

/** The most of each calibre a player can carry. A pool full is a pool capped. */
export const AMMO_CAP: Readonly<Record<Calibre, number>> = Object.freeze({
  '9×19': 240,
  '.45 ACP': 180,
  '.44 Magnum': 60,
  '.50 AE': 60,
  '12 gauge': 80,
  '7.62×39': 180,
  '5.56×45': 240,
  '7.62×51': 140,
  '.308': 40,
  '.50 BMG': 30,
  '40 mm': 12,
  rocket: 6,
  fuel: 600,
  grenade: 10,
  molotov: 10,
  'pipe bomb': 8,
  smoke: 8,
  'tear gas': 8,
});

/**
 * What a hit does beyond the health it takes (spec section 11.6). `stagger` and
 * `bleed` are the character the spec gives the melee weapons and are read by
 * whoever is hit, so they wait for the pedestrians and the police of spec
 * sections 13.1 and 14. The rest land today: a blast is felt over its radius, a
 * fire sets what it touches alight, and an `engine` round is the Barrett taking
 * a car's engine out.
 */
export type WeaponEffect = 'none' | 'stagger' | 'bleed' | 'blast' | 'fire' | 'smoke' | 'gas' | 'engine';

/** Every weapon of the spec's table. The id is what a save carries. */
export type WeaponId =
  | 'fists'
  | 'brass-knuckles'
  | 'baseball-bat'
  | 'crowbar'
  | 'machete'
  | 'katana'
  | 'switchblade'
  | 'combat-knife'
  | 'golf-club'
  | 'chainsaw'
  | 'glock-17'
  | 'beretta-92fs'
  | 'colt-m1911'
  | 'sig-p226'
  | 'model-29'
  | 'desert-eagle'
  | 'uzi'
  | 'mac-10'
  | 'mp5'
  | 'tec-9'
  | 'remington-870'
  | 'mossberg-500'
  | 'sawn-off'
  | 'spas-12'
  | 'ak-47'
  | 'm4a1'
  | 'fn-fal'
  | 'mini-14'
  | 'remington-700'
  | 'barrett-m82'
  | 'm249'
  | 'rpg-7'
  | 'm79'
  | 'flamethrower'
  | 'grenade'
  | 'molotov'
  | 'pipe-bomb'
  | 'smoke-grenade'
  | 'tear-gas';

/**
 * What flies rather than arriving at once: a thrown weapon, a rocket and a
 * grenade from a launcher. The flight is stepped a tick at a time, so the world
 * moves around it the way it moves around everything else.
 */
export interface ProjectileSpec {
  /** Metres per second it leaves the hand or the muzzle at. */
  speed: number;
  /** Radians above the horizon it is thrown at. A rocket leaves flat. */
  pitch: number;
  /** Ticks before it goes off on its own, or -1 where only an impact sets it off. */
  fuse: number;
  /** True where the first thing it touches sets it off. */
  burstOnImpact: boolean;
  /** True where gravity pulls it down. A rocket flies its own line. */
  gravity: boolean;
  /** Metres the burst is felt over. */
  blastRadius: number;
}

/** What one weapon is made of. The arsenal of spec section 11.6 is a table of these. */
export interface WeaponSpec {
  /** The row this is the entry for. */
  id: WeaponId;
  /** The real name, as the spec lists it. */
  name: string;
  cls: WeaponClass;
  /** The pool it draws on, or undefined on a melee weapon, which needs none. */
  calibre: Calibre | undefined;
  /** Rounds one magazine holds. 0 on a melee weapon. */
  capacity: number;
  /** Rounds a minute the action cycles at: the spec's rate of fire. */
  rpm: number;
  /** True where holding the trigger keeps firing. */
  automatic: boolean;
  /** Radians of cone a hip-fired shot leaves in. Aiming narrows it. */
  spread: number;
  /** Radians the muzzle climbs per shot, which widens the shot after it. */
  recoil: number;
  /** Ticks a reload takes. */
  reloadTicks: number;
  /** Health one hit takes off a person, or the middle of a blast. */
  damage: number;
  /** Metres the shot carries. Past it the round does nothing. */
  range: number;
  /** Pellets one pull throws: 1 on everything but a shotgun. */
  pellets: number;
  /** How much of the damage reaches through a car body, 0 to about 3. */
  penetration: number;
  /** Metres a swing reaches, and the half-angle it sweeps. 0 on a gun. */
  reach: number;
  arc: number;
  effect: WeaponEffect;
  /**
   * True where the weapon is out of sight under a coat, so carrying it draws no
   * attention and firing it draws less (spec sections 11.6, 14).
   */
  concealed: boolean;
  /** Set where the weapon throws or launches something rather than hitting at once. */
  projectile: ProjectileSpec | undefined;
  /** True with a suppressor fitted: less heat a shot, and a smaller alert radius. */
  suppressed: boolean;
  /** How much further an aimed shot carries than {@link WeaponSpec.range}: 1 without an optic. */
  sight: number;
  /** How much of {@link WeaponSpec.spread} a hip-fired shot keeps: 1 without a laser. */
  hipSpread: number;
}

/** How much narrower an aimed shot is than a hip-fired one (spec section 11.5). */
export const AIM_TIGHTEN = 0.35;

/**
 * Radians of recoil the shooter takes back per second, and the ticks of quiet
 * they need before they start.
 *
 * The muzzle only comes back down once the shooting stops, which is why it
 * climbs at all: a machine gun at 850 rounds a minute adds recoil far faster
 * than anybody pulls it back, so a burst held to the end of the belt is a burst
 * that sprays. The shooter resettles a fifth of a second after the last shot.
 */
export const RECOIL_RECOVERY = 0.9;
export const RECOIL_SETTLE = 12;

/** The most recoil that can stand at once, however fast the weapon cycles. */
export const MAX_RECOIL = 0.22;

/** Metres above the player's feet the muzzle sits, and how far in front of them. */
export const MUZZLE_HEIGHT = 1.2;
export const MUZZLE_REACH = 0.45;

/**
 * The most radians above or below level a shot may be aimed, which only the
 * first-person view does (`InputFrame.pitch`).
 */
const MAX_AIM_PITCH = 1.2;

/** How much of the spread is spent up and down rather than left and right. */
const PITCH_SHARE = 0.5;

/**
 * Heat one shot raises (spec sections 11.6, 14). A concealed weapon draws less
 * than a long gun in the open, and melee draws none at all, because the spec
 * calls it silent. A pistol's magazine emptied from no heat is under one star;
 * thirty rounds of a rifle are about two.
 */
export const SHOT_HEAT_CONCEALED = 0.05;
const SHOT_HEAT_OPEN = 0.12;

/** How much of a shot's heat a suppressor leaves (spec section 11.6). */
const SUPPRESSED_HEAT = 0.4;

/**
 * Metres a shot is heard over, which is the radius police are alerted from
 * (spec sections 11.6, 14). A suppressed shot is heard over a much smaller one.
 */
export const ALERT_RADIUS = 150;
export const SUPPRESSED_ALERT_RADIUS = 40;

/**
 * How much of a vehicle one point of damage takes off it, once the round's
 * penetration is counted (spec section 11.6). A shotgun blast at a door is
 * about a third of the car, so the door gives way in three; a pistol is a
 * scratch, and a rocket is most of the car at once.
 */
export const VEHICLE_SHARE_PER_POINT = 0.002;

/** Ticks a projectile may fly before it is given up on, wherever it has got to. */
const PROJECTILE_LIFE = 600;

/** Metres per second squared on a thrown thing. Earth's, as everywhere else. */
const GRAVITY = 9.81;

/** Ticks between two shots of a weapon, from the rate of fire it cycles at. */
export function shotInterval(spec: WeaponSpec): number {
  return Math.max(1, Math.round((60 * TICK_RATE) / spec.rpm));
}

/** True where the weapon can be used from a seat of a vehicle (spec section 11.6). */
export function firesFromVehicle(spec: WeaponSpec): boolean {
  return spec.cls === 'pistol' || spec.cls === 'smg';
}

/** Heat one shot of this weapon raises (spec section 14). */
export function heatPerShot(spec: WeaponSpec): number {
  if (spec.cls === 'melee') return 0;
  const heat = spec.concealed ? SHOT_HEAT_CONCEALED : SHOT_HEAT_OPEN;
  return spec.suppressed ? heat * SUPPRESSED_HEAT : heat;
}

/**
 * Metres police hear one shot of this weapon from (spec sections 11.6, 14).
 * Melee is silent, so it is heard from nowhere. The police of spec section 14
 * are what will read it.
 */
export function alertRadius(spec: WeaponSpec): number {
  if (spec.cls === 'melee') return 0;
  return spec.suppressed ? SUPPRESSED_ALERT_RADIUS : ALERT_RADIUS;
}

/** Metres a shot carries: further when it is aimed through an optic (spec section 11.6). */
export function rangeOf(spec: WeaponSpec, aiming: boolean): number {
  return aiming ? spec.range * spec.sight : spec.range;
}

/**
 * How much of a vehicle one round of this weapon takes off it, 0 to 1. A
 * shotgun throws {@link WeaponSpec.pellets} of them at once, so the blast is
 * worth that many.
 */
export function roundSeverity(spec: WeaponSpec): number {
  return spec.damage * spec.penetration * VEHICLE_SHARE_PER_POINT;
}

/**
 * What a blast is worth a distance from its middle, 1 at the middle and 0 at
 * the edge. It falls away with the square, so the far edge is a scare rather
 * than a wound, as the vehicle blast of spec section 11.3 does.
 */
export function blastFalloff(distance: number, radius: number): number {
  if (distance >= radius) return 0;
  const reach = 1 - distance / radius;
  return reach * reach;
}

/**
 * The half-angle of the cone a shot leaves in, in radians. Aiming narrows it to
 * {@link AIM_TIGHTEN} of the hip-fired cone, a laser narrows only the hip-fired
 * one, and the recoil still standing from the last shots widens it again (spec
 * sections 11.5, 11.6).
 */
export function spreadOf(spec: WeaponSpec, aiming: boolean, recoil: number): number {
  return spec.spread * (aiming ? AIM_TIGHTEN : spec.hipSpread) + recoil;
}

/** One pellet of a shot: where it starts and the unit direction it flies in. */
export interface ShotRay {
  /** Where it starts, in map metres with `h` above sea level. */
  x: number;
  y: number;
  h: number;
  /** Unit direction, in the same axes. */
  dx: number;
  dy: number;
  dh: number;
}

/** Something in the air, as the record carries it: a grenade, a Molotov or a rocket. */
export interface ProjectileState {
  /** The weapon that threw it, which says what it does when it goes off. */
  weapon: WeaponId;
  /** Where it is, in map metres with `h` above sea level. */
  x: number;
  y: number;
  h: number;
  /** Metres per second, in the same axes. */
  vx: number;
  vy: number;
  vh: number;
  /** The tick it left the hand or the muzzle. Its fuse is read off this. */
  thrownTick: number;
}

/**
 * What one trigger pull threw. A gun answers rays, one per pellet; a melee
 * weapon answers neither rays nor a projectile, because the caller sweeps its
 * arc instead; a thrown weapon or a launcher answers the thing in the air.
 */
export interface Shot {
  spec: WeaponSpec;
  rays: ShotRay[];
  projectile: ProjectileState | undefined;
  /** Heat the shot raised (spec section 14). */
  heat: number;
  /** Metres police hear the shot from (spec sections 11.6, 14). */
  alert: number;
  /** Metres each ray carries. */
  range: number;
}

/**
 * Run the weapons for one tick and answer what was fired, or undefined where
 * nothing was (spec sections 11.2, 11.6).
 *
 * This is the whole firing model in one call, the way `stepTheft` is the whole
 * minigame: aiming, the weapon cycle, the reload, the recoil coming back and
 * the trigger. `physics.ts` takes what comes out and puts it into the Rapier
 * world.
 *
 * The trigger is read as a level on an automatic weapon and as an edge on
 * everything else, so a finger held on a pump gun fires once. A trigger pulled
 * on an empty magazine starts the reload instead of firing, because a player
 * who is out is a player who wants to reload.
 *
 * `yaw` is the direction the shot goes in, which is the way the player faces
 * unless the pointer says otherwise (`aim.ts`). The input's `pitch` tilts it
 * up or down, which only the first-person view asks for.
 */
export function stepWeapons(
  loadout: LoadoutState,
  input: InputFrame,
  player: PlayerState,
  seed: number,
  tick: number,
  yaw: number = player.heading,
): Shot | undefined {
  loadout.aiming = input.aim;
  if (loadout.firedTick < 0 || tick - loadout.firedTick >= RECOIL_SETTLE) {
    loadout.recoil = Math.max(0, loadout.recoil - RECOIL_RECOVERY / TICK_RATE);
  }
  finishReload(loadout, tick);

  if (input.cycle !== 0) cycleWeapon(loadout, input.cycle);

  const asked = input.reload && !loadout.held.reload;
  loadout.held.reload = input.reload;
  if (asked) beginReload(loadout, tick);

  const spec = currentWeapon(loadout);
  const pulled = input.fire && (spec.automatic || !loadout.held.fire);
  loadout.held.fire = input.fire;
  if (!pulled) return undefined;
  const climb = Math.max(-MAX_AIM_PITCH, Math.min(MAX_AIM_PITCH, input.pitch));
  return fire(loadout, spec, player, seed, tick, yaw, climb);
}

/** Spend a round and answer what it threw, or undefined where the weapon would not fire. */
function fire(
  loadout: LoadoutState,
  spec: WeaponSpec,
  player: PlayerState,
  seed: number,
  tick: number,
  aim: number,
  climb: number,
): Shot | undefined {
  if (reloading(loadout)) return undefined;
  // Only a pistol or an SMG is any use from a seat (spec section 11.6).
  if (player.driving && !firesFromVehicle(spec)) return undefined;
  if (loadout.firedTick >= 0 && tick - loadout.firedTick < shotInterval(spec)) return undefined;
  const slot = currentSlot(loadout);
  if (spec.capacity > 0 && slot.loaded <= 0) {
    beginReload(loadout, tick);
    return undefined;
  }
  if (spec.capacity > 0) slot.loaded -= 1;
  loadout.firedTick = tick;
  const index = loadout.shots;
  loadout.shots += 1;
  const heat = heatPerShot(spec);
  const alert = alertRadius(spec);
  const range = rangeOf(spec, loadout.aiming);
  if (spec.cls === 'melee') return { spec, rays: [], projectile: undefined, heat, alert, range };

  const rng = rngFor(seed, tick, Subsystem.Weapons, index);
  const cone = spreadOf(spec, loadout.aiming, loadout.recoil);
  loadout.recoil = Math.min(MAX_RECOIL, loadout.recoil + spec.recoil);
  const muzzleX = player.x + cos(aim) * MUZZLE_REACH;
  const muzzleY = player.y + sin(aim) * MUZZLE_REACH;
  const muzzleH = player.height + MUZZLE_HEIGHT;

  const flight = spec.projectile;
  if (flight !== undefined) {
    const yaw = aim + rng.range(-cone, cone);
    const pitch = flight.pitch + climb + rng.range(-cone, cone) * PITCH_SHARE;
    const flat = cos(pitch) * flight.speed;
    const projectile: ProjectileState = {
      weapon: spec.id,
      x: muzzleX,
      y: muzzleY,
      h: muzzleH,
      vx: cos(yaw) * flat,
      vy: sin(yaw) * flat,
      vh: sin(pitch) * flight.speed,
      thrownTick: tick,
    };
    return { spec, rays: [], projectile, heat, alert, range };
  }

  const rays: ShotRay[] = [];
  for (let i = 0; i < spec.pellets; i++) {
    const yaw = aim + rng.range(-cone, cone);
    const pitch = climb + rng.range(-cone, cone) * PITCH_SHARE;
    const flat = cos(pitch);
    rays.push({
      x: muzzleX,
      y: muzzleY,
      h: muzzleH,
      dx: cos(yaw) * flat,
      dy: sin(yaw) * flat,
      dh: sin(pitch),
    });
  }
  return { spec, rays, projectile: undefined, heat, alert, range };
}

/**
 * True where a swing of this weapon reaches a target: `gap` metres clear of the
 * player, at `bearing` radians from the map's `+x` axis. A swing is an arc
 * rather than a line, so anything inside the half-angle the weapon sweeps is
 * hit and anything behind the player is not.
 */
export function swingReaches(spec: WeaponSpec, heading: number, gap: number, bearing: number): boolean {
  if (gap > spec.reach) return false;
  let delta = (bearing - heading) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  return Math.abs(delta) <= spec.arc;
}

/**
 * Fly a projectile for one tick. Gravity pulls down everything but a rocket,
 * which flies the line it was launched on. The caller looks for what the step
 * ran into: the flight is a straight step between two places, so a ray over
 * that step is what it hit.
 */
export function stepProjectile(p: ProjectileState): void {
  const spec = weaponOf(p.weapon).projectile;
  if (spec !== undefined && spec.gravity) p.vh -= GRAVITY / TICK_RATE;
  p.x += p.vx / TICK_RATE;
  p.y += p.vy / TICK_RATE;
  p.h += p.vh / TICK_RATE;
}

/**
 * How much of its speed a projectile that does not go off on impact keeps when
 * it bounces, across the surface and into it. A grenade thrown at a wall drops
 * at the foot of it rather than coming back at the thrower.
 */
export const BOUNCE = 0.35;
const BOUNCE_DAMP = 0.7;

/**
 * Bounce a projectile off a surface with the given unit normal, in map axes
 * with `nh` up. The speed into the surface is reflected and mostly lost, and
 * the speed across it is dragged back: what is left is a grenade rolling in the
 * gutter.
 */
export function bounceProjectile(p: ProjectileState, nx: number, nh: number, ny: number): void {
  const into = p.vx * nx + p.vh * nh + p.vy * ny;
  p.vx = (p.vx - (1 + BOUNCE) * into * nx) * BOUNCE_DAMP;
  p.vh = (p.vh - (1 + BOUNCE) * into * nh) * BOUNCE_DAMP;
  p.vy = (p.vy - (1 + BOUNCE) * into * ny) * BOUNCE_DAMP;
}

/**
 * True where a projectile's fuse has burned through, or where it has been in
 * the air so long that it is never coming down on anything: a Molotov thrown
 * off a cliff goes off wherever it has got to rather than flying for ever.
 */
export function projectileDue(p: ProjectileState, tick: number): boolean {
  const spec = weaponOf(p.weapon).projectile;
  const age = tick - p.thrownTick;
  if (spec !== undefined && spec.fuse >= 0 && age >= spec.fuse) return true;
  return age >= PROJECTILE_LIFE;
}

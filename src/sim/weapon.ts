/**
 * The arsenal of spec section 11.6: the table, the ammunition and the firing
 * model.
 *
 * This holds four things and nothing else: the numbers one weapon is made of,
 * the table of every weapon the spec lists, what the player is carrying, and
 * the pure rules of one tick of firing. Nothing here touches Rapier or the DOM,
 * so the whole model can be read and tested headless. `physics.ts` is the
 * Rapier half: it casts the rays, sweeps the melee arcs and flies the thrown
 * things through the world.
 *
 * Ammunition is per calibre and shared across every weapon of that calibre, as
 * the spec asks. A magazine is therefore two numbers: the rounds in it, which
 * belong to the weapon, and the rounds behind it, which belong to the calibre.
 * A reload moves rounds from the pool into the magazine, so emptying a Glock
 * and reloading a Beretta draws on the same 9×19.
 *
 * Every roll comes from `rngFor(seed, tick, Subsystem.Weapons, shot)`, so the
 * same trigger pull at the same tick of the same seed throws its pellets the
 * same way. The shot counter is part of the record, which is what keeps a
 * replay in step with the session it replays.
 *
 * Attachments, weapon shops and faction arsenals are the rest of spec section
 * 11.6 and are not here yet: this is the table, the ammunition and the act of
 * firing. What a weapon looks like is `src/render`, and it is the issue after
 * this one.
 */
import { rngFor, Subsystem } from '../core/rng.ts';
import { TICK_RATE } from './clock.ts';
import type { InputFrame } from './input.ts';
import type { PlayerState } from './on-foot.ts';

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
}

/** Fields every row shares, so a row says only what makes it different. */
const BLANK = {
  pellets: 1,
  penetration: 0.25,
  automatic: false,
  reach: 0,
  arc: 0,
  effect: 'none' as WeaponEffect,
  concealed: false,
  projectile: undefined,
} as const;

/** One melee row: a swing has no magazine, no pool and no range but its reach. */
function melee(
  id: WeaponId,
  name: string,
  damage: number,
  rpm: number,
  reach: number,
  arc: number,
  effect: WeaponEffect,
  concealed: boolean,
  automatic = false,
): WeaponSpec {
  return {
    ...BLANK,
    id,
    name,
    cls: 'melee',
    calibre: undefined,
    capacity: 0,
    rpm,
    automatic,
    spread: 0,
    recoil: 0,
    reloadTicks: 0,
    damage,
    range: 0,
    penetration: 0.08,
    reach,
    arc,
    effect,
    concealed,
  };
}

/** One fired row: everything the row below leaves out comes from {@link BLANK}. */
function gun(row: {
  id: WeaponId;
  name: string;
  cls: WeaponClass;
  calibre: Calibre;
  capacity: number;
  rpm: number;
  spread: number;
  recoil: number;
  reloadTicks: number;
  damage: number;
  range: number;
  pellets?: number;
  penetration?: number;
  automatic?: boolean;
  effect?: WeaponEffect;
  concealed?: boolean;
  projectile?: ProjectileSpec;
}): WeaponSpec {
  return { ...BLANK, ...row };
}

/**
 * One thrown row. A thrown weapon holds one in the hand and the rest in the
 * pool, so the reload is the second it takes to pull the next one out.
 */
function thrown(row: {
  id: WeaponId;
  name: string;
  calibre: Calibre;
  damage: number;
  effect: WeaponEffect;
  projectile: ProjectileSpec;
}): WeaponSpec {
  return {
    ...BLANK,
    cls: 'thrown',
    capacity: 1,
    rpm: 60,
    spread: 0.04,
    recoil: 0,
    reloadTicks: 36,
    range: 0,
    penetration: 1,
    concealed: true,
    ...row,
  };
}

/** Ticks a grenade's fuse burns: long enough to be thrown, short enough to be feared. */
const GRENADE_FUSE = 180;

/**
 * The arsenal of spec section 11.6, row by row. The calibres are the real ones,
 * the capacities and the rates of fire are the real ones, and the damage,
 * spread, recoil and reload are tuned for a game played from 60 m above the
 * street. Nothing else in the project should carry these numbers.
 */
export const ARSENAL: Record<WeaponId, WeaponSpec> = {
  // Melee: silent, no ammunition. A heavy weapon staggers and a blade bleeds.
  fists: melee('fists', 'Fists', 8, 100, 1.1, 0.7, 'none', true),
  'brass-knuckles': melee('brass-knuckles', 'Brass knuckles', 15, 100, 1.1, 0.7, 'stagger', true),
  'baseball-bat': melee('baseball-bat', 'Baseball bat', 24, 60, 1.7, 1, 'stagger', false),
  crowbar: melee('crowbar', 'Crowbar', 26, 55, 1.5, 0.9, 'stagger', false),
  machete: melee('machete', 'Machete', 32, 70, 1.5, 1.1, 'bleed', false),
  katana: melee('katana', 'Katana', 38, 75, 1.8, 1.2, 'bleed', false),
  switchblade: melee('switchblade', 'Switchblade', 18, 140, 1, 0.5, 'bleed', true),
  'combat-knife': melee('combat-knife', 'Combat knife', 22, 120, 1.1, 0.6, 'bleed', true),
  'golf-club': melee('golf-club', 'Golf club', 20, 65, 1.8, 1, 'stagger', false),
  chainsaw: melee('chainsaw', 'Chainsaw', 45, 240, 1.4, 0.8, 'bleed', false, true),

  // Pistols: concealed, fast to draw, and the one class a driver can use.
  'glock-17': gun({
    id: 'glock-17',
    name: 'Glock 17',
    cls: 'pistol',
    calibre: '9×19',
    capacity: 17,
    rpm: 400,
    spread: 0.035,
    recoil: 0.012,
    reloadTicks: 96,
    damage: 22,
    range: 60,
    concealed: true,
  }),
  'beretta-92fs': gun({
    id: 'beretta-92fs',
    name: 'Beretta 92FS',
    cls: 'pistol',
    calibre: '9×19',
    capacity: 15,
    rpm: 380,
    spread: 0.033,
    recoil: 0.013,
    reloadTicks: 102,
    damage: 23,
    range: 60,
    concealed: true,
  }),
  'colt-m1911': gun({
    id: 'colt-m1911',
    name: 'Colt M1911',
    cls: 'pistol',
    calibre: '.45 ACP',
    capacity: 7,
    rpm: 330,
    spread: 0.038,
    recoil: 0.021,
    reloadTicks: 108,
    damage: 31,
    range: 55,
    penetration: 0.35,
    concealed: true,
  }),
  'sig-p226': gun({
    id: 'sig-p226',
    name: 'SIG P226',
    cls: 'pistol',
    calibre: '9×19',
    capacity: 15,
    rpm: 390,
    spread: 0.03,
    recoil: 0.012,
    reloadTicks: 96,
    damage: 23,
    range: 62,
    concealed: true,
  }),
  'model-29': gun({
    id: 'model-29',
    name: 'S&W Model 29',
    cls: 'pistol',
    calibre: '.44 Magnum',
    capacity: 6,
    rpm: 180,
    spread: 0.04,
    recoil: 0.045,
    // A revolver is loaded round by round, so it is the slowest reload of the class.
    reloadTicks: 180,
    damage: 52,
    range: 70,
    penetration: 0.7,
    concealed: true,
  }),
  'desert-eagle': gun({
    id: 'desert-eagle',
    name: 'Desert Eagle',
    cls: 'pistol',
    calibre: '.50 AE',
    capacity: 7,
    rpm: 220,
    spread: 0.045,
    recoil: 0.055,
    reloadTicks: 126,
    damage: 58,
    range: 70,
    penetration: 0.9,
    concealed: true,
  }),

  // SMGs: high rate, wide spread, the drive-by staple.
  uzi: gun({
    id: 'uzi',
    name: 'Uzi',
    cls: 'smg',
    calibre: '9×19',
    capacity: 32,
    rpm: 600,
    spread: 0.075,
    recoil: 0.01,
    reloadTicks: 120,
    damage: 20,
    range: 45,
    automatic: true,
    concealed: true,
  }),
  'mac-10': gun({
    id: 'mac-10',
    name: 'MAC-10',
    cls: 'smg',
    calibre: '.45 ACP',
    capacity: 30,
    rpm: 1100,
    spread: 0.11,
    recoil: 0.013,
    reloadTicks: 120,
    damage: 26,
    range: 35,
    penetration: 0.35,
    automatic: true,
    concealed: true,
  }),
  mp5: gun({
    id: 'mp5',
    name: 'H&K MP5',
    cls: 'smg',
    calibre: '9×19',
    capacity: 30,
    rpm: 800,
    spread: 0.05,
    recoil: 0.008,
    reloadTicks: 132,
    damage: 22,
    range: 55,
    automatic: true,
  }),
  'tec-9': gun({
    id: 'tec-9',
    name: 'TEC-9',
    cls: 'smg',
    calibre: '9×19',
    capacity: 32,
    rpm: 1000,
    spread: 0.095,
    recoil: 0.011,
    reloadTicks: 120,
    damage: 20,
    range: 40,
    automatic: true,
    concealed: true,
  }),

  // Shotguns: devastating close, useless at range, and they wreck car doors.
  'remington-870': gun({
    id: 'remington-870',
    name: 'Remington 870',
    cls: 'shotgun',
    calibre: '12 gauge',
    capacity: 6,
    rpm: 70,
    spread: 0.1,
    recoil: 0.05,
    // A pump gun is fed shell by shell: the reload is the whole tube.
    reloadTicks: 240,
    damage: 13,
    range: 22,
    pellets: 8,
    penetration: 1.4,
  }),
  'mossberg-500': gun({
    id: 'mossberg-500',
    name: 'Mossberg 500',
    cls: 'shotgun',
    calibre: '12 gauge',
    capacity: 6,
    rpm: 75,
    spread: 0.105,
    recoil: 0.05,
    reloadTicks: 234,
    damage: 13,
    range: 22,
    pellets: 8,
    penetration: 1.4,
  }),
  'sawn-off': gun({
    id: 'sawn-off',
    name: 'Sawn-off double barrel',
    cls: 'shotgun',
    calibre: '12 gauge',
    capacity: 2,
    rpm: 200,
    spread: 0.16,
    recoil: 0.07,
    reloadTicks: 150,
    damage: 15,
    range: 16,
    pellets: 9,
    penetration: 1.5,
    concealed: true,
  }),
  'spas-12': gun({
    id: 'spas-12',
    name: 'SPAS-12',
    cls: 'shotgun',
    calibre: '12 gauge',
    capacity: 8,
    rpm: 180,
    spread: 0.09,
    recoil: 0.045,
    reloadTicks: 270,
    damage: 12,
    range: 25,
    pellets: 8,
    penetration: 1.4,
  }),

  // Rifles: accurate at a distance, and they go through a car body.
  'ak-47': gun({
    id: 'ak-47',
    name: 'AK-47',
    cls: 'rifle',
    calibre: '7.62×39',
    capacity: 30,
    rpm: 600,
    spread: 0.045,
    recoil: 0.022,
    reloadTicks: 150,
    damage: 34,
    range: 90,
    penetration: 1.2,
    automatic: true,
  }),
  m4a1: gun({
    id: 'm4a1',
    name: 'M4A1',
    cls: 'rifle',
    calibre: '5.56×45',
    capacity: 30,
    rpm: 800,
    spread: 0.035,
    recoil: 0.015,
    reloadTicks: 144,
    damage: 29,
    range: 95,
    penetration: 1.1,
    automatic: true,
  }),
  'fn-fal': gun({
    id: 'fn-fal',
    name: 'FN FAL',
    cls: 'rifle',
    calibre: '7.62×51',
    capacity: 20,
    rpm: 700,
    spread: 0.04,
    recoil: 0.028,
    reloadTicks: 156,
    damage: 38,
    range: 100,
    penetration: 1.3,
    automatic: true,
  }),
  'mini-14': gun({
    id: 'mini-14',
    name: 'Ruger Mini-14',
    cls: 'rifle',
    calibre: '5.56×45',
    capacity: 20,
    rpm: 450,
    spread: 0.022,
    recoil: 0.018,
    reloadTicks: 144,
    damage: 32,
    range: 110,
    penetration: 1.1,
  }),

  // Precision: scoped, and the Barrett takes an engine out.
  'remington-700': gun({
    id: 'remington-700',
    name: 'Remington 700',
    cls: 'precision',
    calibre: '.308',
    capacity: 5,
    rpm: 40,
    spread: 0.004,
    recoil: 0.05,
    reloadTicks: 186,
    damage: 85,
    range: 160,
    penetration: 1.5,
  }),
  'barrett-m82': gun({
    id: 'barrett-m82',
    name: 'Barrett M82',
    cls: 'precision',
    calibre: '.50 BMG',
    capacity: 10,
    rpm: 60,
    spread: 0.006,
    recoil: 0.09,
    reloadTicks: 240,
    damage: 120,
    range: 220,
    penetration: 2.6,
    effect: 'engine',
  }),

  // Heavy: rare, faction-only or robbed, and heavy heat on sight.
  m249: gun({
    id: 'm249',
    name: 'M249',
    cls: 'heavy',
    calibre: '5.56×45',
    capacity: 100,
    rpm: 850,
    spread: 0.06,
    recoil: 0.014,
    reloadTicks: 420,
    damage: 31,
    range: 100,
    penetration: 1.2,
    automatic: true,
  }),
  'rpg-7': gun({
    id: 'rpg-7',
    name: 'RPG-7',
    cls: 'heavy',
    calibre: 'rocket',
    capacity: 1,
    rpm: 20,
    spread: 0.01,
    recoil: 0.1,
    reloadTicks: 300,
    damage: 150,
    range: 0,
    penetration: 3,
    effect: 'blast',
    // A rocket flies its own line: flat, fast, and it goes off on contact.
    projectile: { speed: 80, pitch: 0, fuse: -1, burstOnImpact: true, gravity: false, blastRadius: 9 },
  }),
  m79: gun({
    id: 'm79',
    name: 'M79 grenade launcher',
    cls: 'heavy',
    calibre: '40 mm',
    capacity: 1,
    rpm: 25,
    spread: 0.02,
    recoil: 0.08,
    reloadTicks: 210,
    damage: 110,
    range: 0,
    penetration: 2,
    effect: 'blast',
    projectile: { speed: 45, pitch: 0.22, fuse: -1, burstOnImpact: true, gravity: true, blastRadius: 7 },
  }),
  flamethrower: gun({
    id: 'flamethrower',
    name: 'Flamethrower',
    cls: 'heavy',
    calibre: 'fuel',
    capacity: 200,
    rpm: 600,
    spread: 0.12,
    recoil: 0.002,
    reloadTicks: 300,
    damage: 9,
    range: 12,
    penetration: 0.3,
    automatic: true,
    effect: 'fire',
  }),

  // Thrown: a Molotov starts fires, and fire spreads (spec section 11.3).
  grenade: thrown({
    id: 'grenade',
    name: 'Fragmentation grenade',
    calibre: 'grenade',
    damage: 95,
    effect: 'blast',
    projectile: { speed: 16, pitch: 0.35, fuse: GRENADE_FUSE, burstOnImpact: false, gravity: true, blastRadius: 8 },
  }),
  molotov: thrown({
    id: 'molotov',
    name: 'Molotov cocktail',
    calibre: 'molotov',
    damage: 40,
    effect: 'fire',
    projectile: { speed: 15, pitch: 0.35, fuse: -1, burstOnImpact: true, gravity: true, blastRadius: 4 },
  }),
  'pipe-bomb': thrown({
    id: 'pipe-bomb',
    name: 'Pipe bomb',
    calibre: 'pipe bomb',
    damage: 110,
    effect: 'blast',
    projectile: { speed: 14, pitch: 0.35, fuse: 240, burstOnImpact: false, gravity: true, blastRadius: 7 },
  }),
  'smoke-grenade': thrown({
    id: 'smoke-grenade',
    name: 'Smoke grenade',
    calibre: 'smoke',
    damage: 0,
    effect: 'smoke',
    projectile: { speed: 15, pitch: 0.35, fuse: 150, burstOnImpact: false, gravity: true, blastRadius: 6 },
  }),
  'tear-gas': thrown({
    id: 'tear-gas',
    name: 'Tear gas',
    calibre: 'tear gas',
    damage: 12,
    effect: 'gas',
    projectile: { speed: 15, pitch: 0.35, fuse: 150, burstOnImpact: false, gravity: true, blastRadius: 7 },
  }),
};

/** Every weapon, in picker order: class by class, and within a class as listed. */
export const WEAPON_IDS: readonly WeaponId[] = [
  'fists',
  'brass-knuckles',
  'baseball-bat',
  'crowbar',
  'machete',
  'katana',
  'switchblade',
  'combat-knife',
  'golf-club',
  'chainsaw',
  'glock-17',
  'beretta-92fs',
  'colt-m1911',
  'sig-p226',
  'model-29',
  'desert-eagle',
  'uzi',
  'mac-10',
  'mp5',
  'tec-9',
  'remington-870',
  'mossberg-500',
  'sawn-off',
  'spas-12',
  'ak-47',
  'm4a1',
  'fn-fal',
  'mini-14',
  'remington-700',
  'barrett-m82',
  'm249',
  'rpg-7',
  'm79',
  'flamethrower',
  'grenade',
  'molotov',
  'pipe-bomb',
  'smoke-grenade',
  'tear-gas',
];

/** What a player always has, and what a session starts with. */
export const DEFAULT_WEAPON: WeaponId = 'fists';

/** The row of the arsenal a weapon is. */
export function weaponOf(id: WeaponId): WeaponSpec {
  return ARSENAL[id];
}

/** Magazines of spare ammunition a weapon comes with when it is given out. */
export const SPARE_MAGAZINES = 3;

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

/** How much of the spread is spent up and down rather than left and right. */
const PITCH_SHARE = 0.5;

/**
 * Heat one shot raises (spec sections 11.6, 14). A concealed weapon draws less
 * than a long gun in the open, and melee draws none at all, because the spec
 * calls it silent.
 */
export const SHOT_HEAT_CONCEALED = 0.15;
export const SHOT_HEAT_OPEN = 0.4;

/**
 * How much of a vehicle one point of damage takes off it, once the round's
 * penetration is counted (spec section 11.6). A shotgun blast at a door is
 * about a third of the car, so the door gives way in three; a pistol is a
 * scratch, and a rocket is most of the car at once.
 */
export const VEHICLE_SHARE_PER_POINT = 0.002;

/** Ticks a projectile may fly before it is given up on, wherever it has got to. */
export const PROJECTILE_LIFE = 600;

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
  return spec.concealed ? SHOT_HEAT_CONCEALED : SHOT_HEAT_OPEN;
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

/** One weapon the player is carrying, and the rounds in its magazine. */
export interface WeaponSlot {
  id: WeaponId;
  /** Rounds in the magazine. Always 0 on a melee weapon. */
  loaded: number;
}

/**
 * What the player is carrying, as the record holds it: the weapons, the pools
 * behind them and the state of the one in their hands. Plain numbers, like
 * everything else in the state.
 */
export interface LoadoutState {
  /** The weapons carried, in the order the cycle key walks them. */
  slots: WeaponSlot[];
  /** Which slot is in their hands, an index into {@link LoadoutState.slots}. */
  current: number;
  /** Rounds held per calibre, shared by every weapon that takes it. */
  ammo: Record<Calibre, number>;
  /** The tick the weapon in hand last fired, or -1 before its first shot. */
  firedTick: number;
  /** The tick the reload finishes, or -1 while nothing is being reloaded. */
  reloadTick: number;
  /** Radians of recoil still standing, which widens the next shot. */
  recoil: number;
  /** True while the player is aiming rather than firing from the hip. */
  aiming: boolean;
  /** Shots fired this session. It keys the random stream of each one. */
  shots: number;
  /** The keys that were down last tick, so a press acts once rather than every tick. */
  held: { fire: boolean; reload: boolean; cycle: boolean };
}

/** An empty pool of every calibre. */
function emptyAmmo(): Record<Calibre, number> {
  const ammo = {} as Record<Calibre, number>;
  for (const calibre of CALIBRES) ammo[calibre] = 0;
  return ammo;
}

/** A player carrying their fists and nothing else, which is how a session starts. */
export function createLoadout(): LoadoutState {
  return {
    slots: [{ id: DEFAULT_WEAPON, loaded: 0 }],
    current: 0,
    ammo: emptyAmmo(),
    firedTick: -1,
    reloadTick: -1,
    recoil: 0,
    aiming: false,
    shots: 0,
    held: { fire: false, reload: false, cycle: false },
  };
}

/** The slot in the player's hands. */
export function currentSlot(loadout: LoadoutState): WeaponSlot {
  const slot = loadout.slots[loadout.current] ?? (loadout.slots[0] as WeaponSlot);
  return slot;
}

/** The weapon in the player's hands. */
export function currentWeapon(loadout: LoadoutState): WeaponSpec {
  return weaponOf(currentSlot(loadout).id);
}

/** The pool a weapon draws on. A melee weapon needs none, so it has none. */
export function poolOf(loadout: LoadoutState, spec: WeaponSpec): number {
  return spec.calibre === undefined ? 0 : loadout.ammo[spec.calibre];
}

/**
 * Put rounds into a calibre's pool, up to what a player can carry. Answers how
 * many went in, so a pickup can say what was left behind.
 */
export function addAmmo(loadout: LoadoutState, calibre: Calibre, rounds: number): number {
  const room = AMMO_CAP[calibre] - loadout.ammo[calibre];
  const taken = Math.max(0, Math.min(room, Math.floor(rounds)));
  loadout.ammo[calibre] += taken;
  return taken;
}

/**
 * Give the player a weapon and select it. A weapon picked up comes loaded, with
 * {@link SPARE_MAGAZINES} magazines behind it; one they already carry only
 * brings the ammunition. This is what a weapon shop, a dropped weapon and the
 * debug picker all come to.
 */
export function giveWeapon(loadout: LoadoutState, id: WeaponId, spare = SPARE_MAGAZINES): void {
  const spec = weaponOf(id);
  let index = loadout.slots.findIndex((slot) => slot.id === id);
  if (index < 0) {
    loadout.slots.push({ id, loaded: spec.capacity });
    index = loadout.slots.length - 1;
  }
  if (spec.calibre !== undefined) addAmmo(loadout, spec.calibre, spec.capacity * spare);
  select(loadout, index);
}

/** Put a weapon the player carries into their hands. Answers false where they do not carry it. */
export function selectWeapon(loadout: LoadoutState, id: WeaponId): boolean {
  const index = loadout.slots.findIndex((slot) => slot.id === id);
  if (index < 0) return false;
  select(loadout, index);
  return true;
}

/** Walk the carried weapons by `step`, wrapping round in both directions. */
export function cycleWeapon(loadout: LoadoutState, step: number): void {
  const count = loadout.slots.length;
  const next = (((loadout.current + step) % count) + count) % count;
  select(loadout, next);
}

/**
 * Take a slot into the hands. A weapon swapped for another drops the reload
 * that was running and the recoil that was standing with it: what is in the
 * hands now is a fresh weapon.
 */
function select(loadout: LoadoutState, index: number): void {
  loadout.current = index;
  loadout.reloadTick = -1;
  loadout.firedTick = -1;
  loadout.recoil = 0;
}

/** True while a reload is running. */
export function reloading(loadout: LoadoutState): boolean {
  return loadout.reloadTick >= 0;
}

/**
 * Start a reload. It takes the weapon's own time, and it is refused where there
 * is nothing to reload: a full magazine, an empty pool, a melee weapon, or a
 * reload already running.
 */
export function beginReload(loadout: LoadoutState, tick: number): boolean {
  if (reloading(loadout)) return false;
  const slot = currentSlot(loadout);
  const spec = weaponOf(slot.id);
  if (spec.capacity === 0 || spec.calibre === undefined) return false;
  if (slot.loaded >= spec.capacity) return false;
  if (loadout.ammo[spec.calibre] <= 0) return false;
  loadout.reloadTick = tick + spec.reloadTicks;
  return true;
}

/**
 * Finish a reload that has come due: the pool fills the magazine, as far as the
 * pool goes. This is the one place rounds move from the calibre to the weapon.
 */
function finishReload(loadout: LoadoutState, tick: number): void {
  if (!reloading(loadout) || tick < loadout.reloadTick) return;
  loadout.reloadTick = -1;
  const slot = currentSlot(loadout);
  const spec = weaponOf(slot.id);
  if (spec.calibre === undefined) return;
  const taken = Math.min(spec.capacity - slot.loaded, loadout.ammo[spec.calibre]);
  slot.loaded += taken;
  loadout.ammo[spec.calibre] -= taken;
}

/**
 * The half-angle of the cone a shot leaves in, in radians. Aiming narrows it to
 * {@link AIM_TIGHTEN} of the hip-fired cone, and the recoil still standing from
 * the last shots widens it again (spec sections 11.5, 11.6).
 */
export function spreadOf(spec: WeaponSpec, aiming: boolean, recoil: number): number {
  return spec.spread * (aiming ? AIM_TIGHTEN : 1) + recoil;
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
 */
export function stepWeapons(
  loadout: LoadoutState,
  input: InputFrame,
  player: PlayerState,
  seed: number,
  tick: number,
): Shot | undefined {
  loadout.aiming = input.aim;
  if (loadout.firedTick < 0 || tick - loadout.firedTick >= RECOIL_SETTLE) {
    loadout.recoil = Math.max(0, loadout.recoil - RECOIL_RECOVERY / TICK_RATE);
  }
  finishReload(loadout, tick);

  const cycled = input.cycle && !loadout.held.cycle;
  loadout.held.cycle = input.cycle;
  if (cycled) cycleWeapon(loadout, 1);

  const asked = input.reload && !loadout.held.reload;
  loadout.held.reload = input.reload;
  if (asked) beginReload(loadout, tick);

  const spec = currentWeapon(loadout);
  const pulled = input.fire && (spec.automatic || !loadout.held.fire);
  loadout.held.fire = input.fire;
  if (!pulled) return undefined;
  return fire(loadout, spec, player, seed, tick);
}

/** Spend a round and answer what it threw, or undefined where the weapon would not fire. */
function fire(
  loadout: LoadoutState,
  spec: WeaponSpec,
  player: PlayerState,
  seed: number,
  tick: number,
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
  if (spec.cls === 'melee') return { spec, rays: [], projectile: undefined, heat };

  const rng = rngFor(seed, tick, Subsystem.Weapons, index);
  const cone = spreadOf(spec, loadout.aiming, loadout.recoil);
  loadout.recoil = Math.min(MAX_RECOIL, loadout.recoil + spec.recoil);
  const muzzleX = player.x + Math.cos(player.heading) * MUZZLE_REACH;
  const muzzleY = player.y + Math.sin(player.heading) * MUZZLE_REACH;
  const muzzleH = player.height + MUZZLE_HEIGHT;

  const flight = spec.projectile;
  if (flight !== undefined) {
    const yaw = player.heading + rng.range(-cone, cone);
    const pitch = flight.pitch + rng.range(-cone, cone) * PITCH_SHARE;
    const flat = Math.cos(pitch) * flight.speed;
    const projectile: ProjectileState = {
      weapon: spec.id,
      x: muzzleX,
      y: muzzleY,
      h: muzzleH,
      vx: Math.cos(yaw) * flat,
      vy: Math.sin(yaw) * flat,
      vh: Math.sin(pitch) * flight.speed,
      thrownTick: tick,
    };
    return { spec, rays: [], projectile, heat };
  }

  const rays: ShotRay[] = [];
  for (let i = 0; i < spec.pellets; i++) {
    const yaw = player.heading + rng.range(-cone, cone);
    const pitch = rng.range(-cone, cone) * PITCH_SHARE;
    const flat = Math.cos(pitch);
    rays.push({
      x: muzzleX,
      y: muzzleY,
      h: muzzleH,
      dx: Math.cos(yaw) * flat,
      dy: Math.sin(yaw) * flat,
      dh: Math.sin(pitch),
    });
  }
  return { spec, rays, projectile: undefined, heat };
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
export const BOUNCE_DAMP = 0.7;

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

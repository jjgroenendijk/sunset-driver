/**
 * The arsenal of spec section 11.6, row by row: every weapon the spec lists,
 * with the calibre, capacity, rate of fire, damage, spread, recoil and reload
 * of each. Nothing else in the project should carry these numbers.
 *
 * What a row is made of, and what firing one does, is `weapon.ts`.
 */
import type { Calibre, ProjectileSpec, WeaponClass, WeaponEffect, WeaponId, WeaponSpec } from './weapon.ts';

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
  suppressed: false,
  sight: 1,
  hipSpread: 1,
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
    spread: 0.14,
    recoil: 0.002,
    reloadTicks: 300,
    // A stream rather than a round: three tongues of it a tick of fuel, each
    // cast on its own, so the fire fills a cone and not a line.
    damage: 4,
    range: 12,
    pellets: 3,
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

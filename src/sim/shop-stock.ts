/**
 * What a shop sells and what it costs (spec section 16.1).
 *
 * One row of a counter is a {@link ShopOffer}: a line, a price, and what
 * buying it does to the record. `shop.ts` is what puts the player inside the
 * shop and takes their money; this says what they may spend it on.
 *
 * A price is derived from the row it is a price for rather than written into a
 * second table beside the arsenal: a weapon costs what its licence and its
 * damage say, and a round costs what the pool a player may carry of it says, so
 * a rocket is dear because six of them is a full pool. The arsenal keeps the
 * only copy of those numbers (`arsenal.ts`), and nothing here may hold a
 * second one.
 *
 * A weapon shop stocks a few weapons and not the whole arsenal: which few is a
 * pure function of the seed and the shop, so the same shop of the same seed
 * always has the same counter, and the panel a player buys off is the panel the
 * record replays.
 *
 * Pure: it reads the record and writes the record, and takes no wall-clock.
 */
import { spread } from '../core/math.ts';
import { genRng, Subsystem } from '../core/rng.ts';
import { OUTFITS } from './character.ts';
import { createDamageState } from './damage.ts';
import { heal, MAX_HEALTH } from './on-foot.ts';
import type { ShopPlace } from './shop.ts';
import type { SimState } from './simulation.ts';
import {
  AMMO_CAP,
  addAmmo,
  currentSlot,
  fitAttachment,
  fitsOf,
  giveWeapon,
  weaponOf,
  WEAPON_IDS,
  type Attachment,
  type Calibre,
  type WeaponClass,
  type WeaponId,
  type WeaponSpec,
} from './weapon.ts';

/** One row of a counter. */
export interface ShopOffer {
  /** The line the panel shows, without the price. */
  label: string;
  /** Dollars it costs. */
  price: number;
  /**
   * Do the trade and say what happened, in the words the panel shows. The
   * money is taken by `shop.ts` before this is called, so a row that cannot be
   * taken is never offered.
   */
  take: (state: SimState) => string;
}

/** Dollars every price is rounded to, so no counter asks for $137. */
const STEP = 5;

/**
 * The licence a weapon's class needs (spec section 16.1). A shop sells every
 * class at or below the licence it holds over the counter; the classes above it
 * are the back room, which charges {@link BACK_ROOM} times the price. Nothing
 * is licensed for the heavy weapons and the thrown ones, so those are only ever
 * sold out of a back room.
 */
const CLASS_LICENCE: Readonly<Record<WeaponClass, number>> = Object.freeze({
  melee: 1,
  shotgun: 1,
  pistol: 2,
  smg: 2,
  rifle: 3,
  precision: 3,
  heavy: 4,
  thrown: 4,
});

/** How much more the back room charges for what the shop is not licensed to sell. */
export const BACK_ROOM = 2;

/** Weapons a shop shows over the counter, and behind it. */
export const COUNTER_ROWS = 4;
export const BACK_ROOM_ROWS = 2;

/** The base price of a weapon of each licence, before its own damage moves it. */
const LICENCE_PRICE: readonly number[] = [0, 150, 500, 1400, 3200];

/** Dollars a 9×19 round costs. Every other calibre is priced against it. */
const ROUND_BASE = 1;

/** What each attachment costs fitted (spec section 11.6). */
const ATTACHMENT_PRICE: Readonly<Record<Attachment, number>> = Object.freeze({
  suppressor: 900,
  'extended-mag': 250,
  optic: 600,
  laser: 350,
  foregrip: 200,
});

/** Dollars a vehicle written off costs to rebuild. A dented one pays its share. */
const REPAIR_FULL = 1200;

/** Dollars a respray costs, whatever the vehicle (spec section 16.1). */
const RESPRAY = 400;

/** Dollars a meal costs, and dollars a point of health costs at a clinic. */
const MEAL = 15;
const TREATMENT_PER_POINT = 5;

/** Dollars a change of clothes costs (spec section 16.1). */
const OUTFIT = 120;

/** Stars of heat a change of clothes sheds: the recognition the old clothes carried. */
export const CLOTHES_HEAT = 1;

/**
 * The colours a workshop resprays a vehicle in. Each one is a colour a police
 * radio would call differently, which is what makes a respray worth the money.
 */
export const RESPRAY_PAINTS: readonly { label: string; colour: number }[] = [
  { label: 'Black', colour: 0x1b1b20 },
  { label: 'White', colour: 0xe8e8ec },
  { label: 'Sand', colour: 0xc8a96a },
  { label: 'Ocean', colour: 0x2f5d86 },
  { label: 'Crimson', colour: 0xa32b28 },
];

/** The rows of the counter of the shop the player is standing in. */
export function offersOf(state: SimState, place: ShopPlace): ShopOffer[] {
  switch (place.kind) {
    case 'weapons':
      return weaponOffers(state, place);
    case 'workshop':
      return workshopOffers(state);
    case 'convenience':
      return mealOffers(state);
    case 'clothing':
      return clothesOffers(state);
    case 'clinic':
      return clinicOffers(state);
    // The broker sells the safehouses of spec section 16.3, which have not
    // landed: the shop is open and its counter is empty until they do.
    case 'broker':
      return [];
  }
}

/** The licence a weapon needs to be sold over a counter. */
export function licenceOf(spec: WeaponSpec): number {
  return CLASS_LICENCE[spec.cls];
}

/** What a weapon costs: its licence sets the price and its own damage moves it. */
export function weaponPrice(spec: WeaponSpec): number {
  const base = LICENCE_PRICE[licenceOf(spec)] ?? 0;
  return round(base * (0.6 + spec.damage / 60) * (spec.automatic ? 1.3 : 1));
}

/**
 * What one round of a calibre costs. The pool a player may carry is what says
 * how rare the round is, so a rocket costs forty times what a 9×19 does.
 */
export function roundPrice(calibre: Calibre): number {
  return Math.max(1, Math.round((ROUND_BASE * AMMO_CAP['9×19']) / AMMO_CAP[calibre]));
}

/**
 * The weapons one shop has, over the counter and in the back room. They are
 * spread down the list of what it may sell rather than taken in a run, so a
 * counter carries a pistol and a shotgun and not four pistols.
 */
export function stockOf(seed: number, place: ShopPlace): { counter: WeaponId[]; back: WeaponId[] } {
  const rng = genRng(seed, Subsystem.ShopStock, place.id);
  return {
    counter: pick(sellable((licence) => licence <= place.licence), COUNTER_ROWS, rng.nextU32()),
    back: pick(sellable((licence) => licence > place.licence), BACK_ROOM_ROWS, rng.nextU32()),
  };
}

/** The weapons whose licence passes a test, in the arsenal's own order. */
function sellable(wanted: (licence: number) => boolean): WeaponId[] {
  // Fists are what a player starts with, so no shop sells them.
  return WEAPON_IDS.filter((id) => id !== 'fists' && wanted(licenceOf(weaponOf(id))));
}

function pick(ids: readonly WeaponId[], rows: number, offset: number): WeaponId[] {
  return spread(ids.length, rows, offset % Math.max(1, ids.length)).map((at) => ids[at] as WeaponId);
}

/**
 * The counter of a weapon shop: the weapons it holds, a magazine for the weapon
 * in the player's hands, and an attachment that fits it (spec section 16.1).
 */
function weaponOffers(state: SimState, place: ShopPlace): ShopOffer[] {
  const stock = stockOf(state.seed, place);
  const rows: ShopOffer[] = [];
  for (const id of stock.counter) rows.push(weaponRow(id, 1));
  for (const id of stock.back) rows.push(weaponRow(id, BACK_ROOM));
  const slot = currentSlot(state.loadout);
  const spec = weaponOf(slot.id);
  const calibre = spec.calibre;
  if (calibre !== undefined) {
    const rounds = Math.max(1, spec.capacity);
    const room = AMMO_CAP[calibre] - state.loadout.ammo[calibre];
    if (room > 0) {
      rows.push({
        label: `${rounds} × ${calibre}`,
        price: round(rounds * roundPrice(calibre)),
        take: (s) => `${addAmmo(s.loadout, calibre, rounds)} rounds of ${calibre}.`,
      });
    }
  }
  const attachment = fitsOf(spec).find((fit) => !slot.attachments.includes(fit));
  if (attachment !== undefined) {
    rows.push({
      label: `${attachment} for the ${spec.name}`,
      price: ATTACHMENT_PRICE[attachment],
      take: (s) => {
        fitAttachment(s.loadout, spec.id, attachment);
        return `${attachment} fitted to the ${spec.name}.`;
      },
    });
  }
  return rows;
}

/** One weapon on a counter, at the counter's price or the back room's. */
function weaponRow(id: WeaponId, premium: number): ShopOffer {
  const spec = weaponOf(id);
  return {
    label: premium > 1 ? `${spec.name} · back room` : spec.name,
    price: round(weaponPrice(spec) * premium),
    take: (state) => {
      giveWeapon(state.loadout, id);
      return `${spec.name}, loaded.`;
    },
  };
}

/**
 * The counter of a workshop: the repair and the resprays of spec section 16.1.
 * It works on the vehicle of the record, which is the one the player arrived
 * in and left at the door — the record carries one vehicle, and that is it.
 */
function workshopOffers(state: SimState): ShopOffer[] {
  const rows: ShopOffer[] = [];
  const damage = state.vehicle.damage;
  if (damage.stage !== 'intact' || damage.integrity < 1) {
    rows.push({
      label: 'Repair',
      price: Math.max(STEP, round((1 - damage.integrity) * REPAIR_FULL)),
      take: (s) => {
        s.vehicle.damage = createDamageState();
        return 'The panels are straight and the engine is clean.';
      },
    });
  }
  for (const paint of RESPRAY_PAINTS) {
    if (paint.colour === state.vehicle.paint) continue;
    rows.push({
      label: `Respray · ${paint.label}`,
      price: RESPRAY,
      take: (s) => {
        s.vehicle.paint = paint.colour;
        // A respray is what sheds the heat a described car carries (spec
        // section 16.1): the radio is looking for the colour it was.
        s.heat = 0;
        return `Resprayed ${paint.label.toLowerCase()}. Nobody is looking for this car.`;
      },
    });
  }
  return rows;
}

/** The counter of a convenience store: food, which is health (spec section 11.5). */
function mealOffers(state: SimState): ShopOffer[] {
  if (state.player.health >= MAX_HEALTH) return [];
  return [
    {
      label: 'Meal',
      price: MEAL,
      take: (s) => {
        heal(s.player, 'food');
        return `Health ${Math.round(s.player.health)}.`;
      },
    },
  ];
}

/**
 * The counter of a clothing shop: the outfits the player is not wearing. A
 * change of clothes sheds a star of recognition (spec section 16.1).
 */
function clothesOffers(state: SimState): ShopOffer[] {
  const rows: ShopOffer[] = [];
  for (let i = 0; i < OUTFITS.length; i++) {
    if (i === state.character.outfit) continue;
    const outfit = OUTFITS[i] as (typeof OUTFITS)[number];
    rows.push({
      label: outfit.label,
      price: OUTFIT,
      take: (s) => {
        s.character.outfit = i;
        s.heat = Math.max(0, s.heat - CLOTHES_HEAT);
        return `${outfit.label}. The description on the radio is of somebody else.`;
      },
    });
  }
  return rows;
}

/** The counter of a clinic: treatment, which is health by the point (spec section 16.1). */
function clinicOffers(state: SimState): ShopOffer[] {
  const missing = MAX_HEALTH - state.player.health;
  if (missing <= 0) return [];
  return [
    {
      label: 'Treatment',
      price: Math.max(STEP, round(missing * TREATMENT_PER_POINT)),
      take: (s) => {
        heal(s.player, 'clinic');
        return `Health ${Math.round(s.player.health)}.`;
      },
    },
  ];
}

/** A price, rounded to the step a counter asks in. */
function round(price: number): number {
  return Math.round(price / STEP) * STEP;
}

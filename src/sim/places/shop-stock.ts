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
import { hypot } from '../../core/libm.ts';
import { spread } from '../../core/math.ts';
import { genRng, Subsystem } from '../../core/rng.ts';
import { OUTFITS } from '../player/character.ts';
import { createDamageState } from '../vehicles/damage.ts';
import { heal, healBy, MAX_HEALTH } from '../player/on-foot.ts';
import { buySafehouse, ownedAt, type SafehousePlace } from './safehouse.ts';
import type { ShopPlace } from './shop.ts';
import { CARE, FOODS, RESPRAY_PAINTS, weaponFacts, type PropId, type ShopFact, type ShopLook } from './shop-goods.ts';
import type { SimState } from '../simulation.ts';
import { menuOf } from './venue-menu.ts';
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
} from '../weapons/weapon.ts';

/** One row of a counter. */
export interface ShopOffer {
  /** The line the panel shows, without the price. */
  label: string;
  /** Dollars it costs. */
  price: number;
  /** The heading the row is listed under, such as the back room or the ammunition. */
  group: string;
  /** What the panel's preview draws for the row. */
  look: ShopLook;
  /** One line about the row, under its name on the panel's card. */
  blurb: string;
  /** The numbers the card lists for the row. */
  facts: ShopFact[];
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
export const COUNTER_ROWS = 6;
export const BACK_ROOM_ROWS = 3;

/**
 * The most doors one broker lists. A broker has the keys to the whole city,
 * and a list of every door would be a list nobody reads to the end.
 */
const BROKER_ROWS = 12;

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

/** Dollars a point of health costs in full treatment at a clinic. */
const TREATMENT_PER_POINT = 5;

/** Dollars a change of clothes costs (spec section 16.1). */
const OUTFIT = 120;

/** Stars of heat a change of clothes sheds: the recognition the old clothes carried. */
export const CLOTHES_HEAT = 1;

export { RESPRAY_PAINTS };

/**
 * The rows of the counter of the shop the player is standing in. `homes` is the
 * city's properties, which only the broker reads (spec section 16.3).
 */
export function offersOf(state: SimState, place: ShopPlace, homes: readonly SafehousePlace[] = []): ShopOffer[] {
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
    case 'broker':
      return brokerOffers(state, place, homes);
    case 'cafe':
    case 'bar':
      return venueOffers(state, place);
  }
}

/**
 * The counter of a café or a bar: its own menu (`venue-menu.ts`). Unlike the
 * store it serves a player who is not hurt, since a drink at the bar is what
 * the room is for; the health comes only to one who is.
 */
function venueOffers(state: SimState, place: ShopPlace): ShopOffer[] {
  const menu = menuOf(state.seed, place.id, place.kind === 'bar', place.wealth, place.title);
  return menu.map((item) => ({
    label: item.label,
    price: item.price,
    group: item.group,
    look: { kind: 'prop', prop: item.prop, colour: item.colour },
    blurb: item.blurb,
    facts: [{ label: 'Health', text: `+${item.health}`, bar: item.health / MAX_HEALTH }],
    take: (s) => {
      if (s.player.health >= MAX_HEALTH) return `${item.label}. You enjoy it.`;
      healBy(s.player, item.health);
      return `${item.label}. Health ${Math.round(s.player.health)}.`;
    },
  }));
}

/**
 * The counter of a property broker: the safehouses of spec section 16.3 that
 * are still for sale, the nearest to this office first. A broker has the keys
 * to the whole city, but a counter lists {@link BROKER_ROWS} of them, so what
 * one office sells is the doors round it. A player who wants a door across the city walks
 * into the broker there, which is why the list is by distance and not by price.
 */
function brokerOffers(state: SimState, place: ShopPlace, homes: readonly SafehousePlace[]): ShopOffer[] {
  const forSale = homes.filter((home) => ownedAt(state, home.id) === undefined);
  const away = (home: SafehousePlace): number => hypot(home.x - place.x, home.y - place.y);
  // The ids break a tie, so two doors at the same distance are always listed in
  // the same order and the row a key buys is the row the record replays.
  const sorted = [...forSale].sort((a, b) => away(a) - away(b) || a.id - b.id);
  return sorted.slice(0, BROKER_ROWS).map((home) => ({
    label: home.name,
    price: home.price,
    group: 'For sale',
    look: { kind: 'prop', prop: 'house', colour: 0xc8a96a },
    blurb: 'The keys, the stash and the garage behind the door.',
    facts: [{ label: 'Distance', text: `${Math.round(away(home) / 10) * 10} m` }],
    take: (s) => buySafehouse(s, home),
  }));
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
 * The counter of a weapon shop: the weapons it holds, a magazine for every
 * weapon the player carries that has room in its pool, and each attachment the
 * weapon in their hands takes and does not have yet (spec section 16.1).
 */
function weaponOffers(state: SimState, place: ShopPlace): ShopOffer[] {
  const stock = stockOf(state.seed, place);
  const rows: ShopOffer[] = [];
  for (const id of stock.counter) rows.push(weaponRow(id, 1));
  for (const id of stock.back) rows.push(weaponRow(id, BACK_ROOM));
  // One row per calibre, for the first weapon carried that fires it, so a
  // pistol and an SMG that share 9×19 do not sell the same box twice.
  const calibres: Calibre[] = [];
  for (const slot of state.loadout.slots) {
    const spec = weaponOf(slot.id);
    const calibre = spec.calibre;
    if (calibre === undefined || calibres.includes(calibre)) continue;
    calibres.push(calibre);
    if (AMMO_CAP[calibre] - state.loadout.ammo[calibre] > 0) rows.push(ammoRow(spec, calibre, state));
  }
  const slot = currentSlot(state.loadout);
  const spec = weaponOf(slot.id);
  for (const attachment of fitsOf(spec)) {
    if (slot.attachments.includes(attachment)) continue;
    rows.push({
      label: `${ATTACHMENT_NAME[attachment]} for the ${spec.name}`,
      price: ATTACHMENT_PRICE[attachment],
      group: 'Attachments',
      look: { kind: 'weapon', id: spec.id, attachments: [...slot.attachments, attachment] },
      blurb: ATTACHMENT_BLURB[attachment],
      facts: [{ label: 'Fits', text: spec.name }],
      take: (s) => {
        fitAttachment(s.loadout, spec.id, attachment);
        return `${ATTACHMENT_NAME[attachment]} fitted to the ${spec.name}.`;
      },
    });
  }
  return rows;
}

/** What a counter calls each attachment. */
const ATTACHMENT_NAME: Readonly<Record<Attachment, string>> = Object.freeze({
  suppressor: 'Suppressor',
  'extended-mag': 'Extended magazine',
  optic: 'Optic',
  laser: 'Laser',
  foregrip: 'Foregrip',
});

/** What the card says an attachment does (spec section 11.6). */
const ATTACHMENT_BLURB: Readonly<Record<Attachment, string>> = Object.freeze({
  suppressor: 'Quieter shots: less heat, and fewer people hear them.',
  'extended-mag': 'More rounds before a reload.',
  optic: 'A tighter shot when aiming.',
  laser: 'A tighter shot from the hip.',
  foregrip: 'Less climb from each shot.',
});

/** A magazine's worth of rounds for a weapon the player carries. */
function ammoRow(spec: WeaponSpec, calibre: Calibre, state: SimState): ShopOffer {
  const rounds = Math.max(1, spec.capacity);
  const held = state.loadout.ammo[calibre];
  return {
    label: `${rounds} × ${calibre}`,
    price: round(rounds * roundPrice(calibre)),
    group: 'Ammunition',
    look: { kind: 'prop', prop: 'ammo', colour: 0xc19a53 },
    blurb: `A magazine's worth for the ${spec.name}.`,
    facts: [
      { label: 'Carrying', text: `${held} of ${AMMO_CAP[calibre]}`, bar: held / AMMO_CAP[calibre] },
      { label: 'Per round', text: `$${roundPrice(calibre)}` },
    ],
    take: (s) => `${addAmmo(s.loadout, calibre, rounds)} rounds of ${calibre}.`,
  };
}

/** One weapon on a counter, at the counter's price or the back room's. */
function weaponRow(id: WeaponId, premium: number): ShopOffer {
  const spec = weaponOf(id);
  return {
    label: premium > 1 ? `${spec.name} · back room` : spec.name,
    price: round(weaponPrice(spec) * premium),
    group: premium > 1 ? 'Back room' : 'Over the counter',
    look: { kind: 'weapon', id, attachments: [] },
    blurb: premium > 1 ? 'Not on the licence. It costs double and nobody wrote it down.' : 'Sold loaded, with spares.',
    facts: weaponFacts(spec),
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
  const vehicle = state.vehicle;
  const damage = vehicle.damage;
  if (damage.stage !== 'intact' || damage.integrity < 1) {
    rows.push({
      label: 'Repair',
      price: Math.max(STEP, round((1 - damage.integrity) * REPAIR_FULL)),
      group: 'Service',
      look: { kind: 'prop', prop: 'wrench', colour: 0x9aa0a6 },
      blurb: 'Straight panels and a clean engine.',
      facts: [{ label: 'Condition', text: `${Math.round(damage.integrity * 100)}%`, bar: damage.integrity }],
      take: (s) => {
        s.vehicle.damage = createDamageState();
        return 'The panels are straight and the engine is clean.';
      },
    });
  }
  for (const paint of RESPRAY_PAINTS) {
    if (paint.colour === vehicle.paint) continue;
    rows.push({
      label: `Respray · ${paint.label}`,
      price: RESPRAY,
      group: 'Respray',
      look: { kind: 'vehicle', cls: vehicle.cls, paint: paint.colour },
      blurb: 'A new colour, and the police radio loses the car.',
      facts: [{ label: 'Heat', text: 'cleared' }],
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

/** The counter of a convenience store: food and drink, which is health (spec section 11.5). */
function mealOffers(state: SimState): ShopOffer[] {
  if (state.player.health >= MAX_HEALTH) return [];
  return FOODS.map((food) => ({
    label: food.label,
    price: food.price,
    group: 'Food and drink',
    look: { kind: 'prop', prop: food.prop, colour: food.colour },
    blurb: food.blurb,
    facts: [{ label: 'Health', text: `+${food.health}`, bar: food.health / MAX_HEALTH }],
    take: (s) => {
      healBy(s.player, food.health);
      return `${food.label}. Health ${Math.round(s.player.health)}.`;
    },
  }));
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
      group: 'Outfits',
      look: { kind: 'outfit', outfit: i },
      blurb: 'A change of clothes, and the description on the radio is out of date.',
      facts: [{ label: 'Heat', text: `−${CLOTHES_HEAT} star` }],
      take: (s) => {
        s.character.outfit = i;
        s.heat = Math.max(0, s.heat - CLOTHES_HEAT);
        return `${outfit.label}. The description on the radio is of somebody else.`;
      },
    });
  }
  return rows;
}

/**
 * What the clinic hands over the counter for nothing (spec section 19). The
 * needle exchange is part of the clinic, and what it gives out is the same
 * harm-reduction content the radio reads and the posters carry: what the thing
 * is, what it does, and nothing else. It is free because it is free, and the
 * counter asks no name because the exchange asks no name.
 *
 * Taking one changes no state. There is no overdose in the simulation for a
 * kit to reverse, and inventing one to justify the row would be the lecture
 * spec section 19 forbids: the information is the thing the player leaves with.
 */
const CLINIC_SUPPLIES: readonly { label: string; said: string; prop: PropId; colour: number }[] = [
  {
    label: 'Naloxone kit',
    said: 'Two doses and the card that says how. It reverses an opioid overdose and it keeps in a glovebox.',
    prop: 'naloxone',
    colour: 0xe45a3c,
  },
  {
    label: 'Fentanyl test strips',
    said: 'Ten strips. Fentanyl turns up in more than dope now, and a strip is how you know before you use.',
    prop: 'strips',
    colour: 0x3f7fbf,
  },
  {
    label: 'Clean works',
    said: 'A week of works and a bin for the old ones. No name asked, no number kept, every day of the week.',
    prop: 'works',
    colour: 0xd8a544,
  },
];

/**
 * The counter of a clinic: care, which is health (spec section 16.1), and the
 * free supplies of the needle exchange above, which are there whether the
 * player is hurt or not. Full treatment is priced by the point; the lighter
 * care is offered only where it heals less than all that is missing.
 */
function clinicOffers(state: SimState): ShopOffer[] {
  const rows: ShopOffer[] = [];
  const missing = MAX_HEALTH - state.player.health;
  if (missing > 0) {
    for (const care of CARE) {
      const full = care.health === 0;
      if (!full && care.health >= missing) continue;
      const gives = full ? missing : care.health;
      rows.push({
        label: care.label,
        price: full ? Math.max(STEP, round(missing * TREATMENT_PER_POINT)) : care.price,
        group: 'Care',
        look: { kind: 'prop', prop: care.prop, colour: care.colour },
        blurb: care.blurb,
        facts: [{ label: 'Health', text: `+${Math.round(gives)}`, bar: gives / MAX_HEALTH }],
        take: (s) => {
          if (full) heal(s.player, 'clinic');
          else healBy(s.player, care.health);
          return `Health ${Math.round(s.player.health)}.`;
        },
      });
    }
  }
  for (const supply of CLINIC_SUPPLIES) {
    rows.push({
      label: supply.label,
      price: 0,
      group: 'Needle exchange',
      look: { kind: 'prop', prop: supply.prop, colour: supply.colour },
      blurb: 'Free. No name asked.',
      facts: [],
      take: () => supply.said,
    });
  }
  return rows;
}

/** A price, rounded to the step a counter asks in. */
function round(price: number): number {
  return Math.round(price / STEP) * STEP;
}

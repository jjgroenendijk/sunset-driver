/**
 * The goods of the shop counters (spec section 16.1), and how each row is
 * shown: the tables of what a convenience store, a clinic and a workshop sell,
 * the look the panel's turning preview draws, and the facts its card lists.
 *
 * `shop-stock.ts` builds the rows of a counter from these tables and says what
 * buying a row does. This file holds only data and the words about it, so the
 * panel can describe a row without knowing how the row changes the record.
 *
 * Pure: plain data, no state.
 */
import type { VehicleClass } from './vehicle.ts';
import { WEAPON_IDS, weaponOf, type Attachment, type WeaponId, type WeaponSpec } from './weapon.ts';

/** A thing the preview can draw that is neither a weapon, a vehicle nor clothes. */
export type PropId =
  | 'ammo'
  | 'coffee'
  | 'soda'
  | 'donut'
  | 'energy'
  | 'hotdog'
  | 'sandwich'
  | 'pizza'
  | 'noodles'
  | 'burger'
  | 'bandage'
  | 'medkit'
  | 'treatment'
  | 'naloxone'
  | 'strips'
  | 'works'
  | 'house'
  | 'wrench';

/** What the preview of a row draws. */
export type ShopLook =
  | { kind: 'weapon'; id: WeaponId; attachments: readonly Attachment[] }
  | { kind: 'vehicle'; cls: VehicleClass; paint: number }
  | { kind: 'outfit'; outfit: number }
  | { kind: 'prop'; prop: PropId; colour: number };

/**
 * One line of the card beside the preview. `bar` is where the fact stands
 * from 0 to 1 against the rest of its kind, and is drawn as a gauge.
 */
export interface ShopFact {
  label: string;
  text: string;
  bar?: number;
}

/** One good of a food or care counter: its name, price, the health it gives, and the look. */
export interface Good {
  label: string;
  price: number;
  health: number;
  prop: PropId;
  colour: number;
  blurb: string;
}

/**
 * What a convenience store sells, cheapest first. Each good is health (spec
 * section 11.5), and a dearer good gives more of it for the dollar.
 */
export const FOODS: readonly Good[] = [
  { label: 'Coffee', price: 5, health: 8, prop: 'coffee', colour: 0xf2ede6, blurb: 'Black, hot, and strong enough.' },
  { label: 'Cola', price: 5, health: 8, prop: 'soda', colour: 0xc8302a, blurb: 'A cold can from the back of the fridge.' },
  { label: 'Glazed donut', price: 5, health: 10, prop: 'donut', colour: 0xe890b0, blurb: 'Pink icing. Sprinkles.' },
  { label: 'Energy drink', price: 10, health: 18, prop: 'energy', colour: 0x5ad13c, blurb: 'Tastes of batteries.' },
  { label: 'Hot dog', price: 10, health: 22, prop: 'hotdog', colour: 0xc8763a, blurb: 'Mustard and onions.' },
  { label: 'Club sandwich', price: 15, health: 32, prop: 'sandwich', colour: 0xe0c080, blurb: 'Three layers.' },
  { label: 'Pizza slice', price: 15, health: 40, prop: 'pizza', colour: 0xe0a040, blurb: 'Pepperoni, still warm.' },
  { label: 'Noodle box', price: 20, health: 50, prop: 'noodles', colour: 0xf2ede6, blurb: 'Chilli oil and spring onion.' },
  { label: 'Burger meal', price: 25, health: 65, prop: 'burger', colour: 0xa0602a, blurb: 'A double, fries, a drink.' },
];

/**
 * The care a clinic sells, lightest first. The last row is full treatment,
 * whose price is set by what is missing (`TREATMENT_PER_POINT` in
 * `shop-stock.ts`); its `price` and `health` here are not read.
 */
export const CARE: readonly Good[] = [
  { label: 'Bandages', price: 75, health: 25, prop: 'bandage', colour: 0xf2ede6, blurb: 'Clean dressings.' },
  { label: 'First aid', price: 175, health: 50, prop: 'medkit', colour: 0xc8302a, blurb: 'Stitches and a sling.' },
  { label: 'Treatment', price: 0, health: 0, prop: 'treatment', colour: 0x3f7fbf, blurb: 'A doctor sees you now.' },
];

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
  { label: 'Silver', colour: 0xb8bcc2 },
  { label: 'Gunmetal', colour: 0x4a4f57 },
  { label: 'Sunset orange', colour: 0xe0702a },
  { label: 'Taxi yellow', colour: 0xf2c230 },
  { label: 'Lime', colour: 0x8cc63f },
  { label: 'Racing green', colour: 0x1f4d32 },
  { label: 'Sky blue', colour: 0x7fb8e0 },
  { label: 'Royal purple', colour: 0x5b3a8c },
  { label: 'Hot pink', colour: 0xe0508f },
  { label: 'Chocolate', colour: 0x5a3a28 },
];

/** The highest of each weapon number the arsenal holds, which the gauges are drawn against. */
const TOP = topOf(WEAPON_IDS.map((id) => weaponOf(id)));

function topOf(specs: readonly WeaponSpec[]): { damage: number; rpm: number; capacity: number; range: number } {
  const top = { damage: 1, rpm: 1, capacity: 1, range: 1 };
  for (const spec of specs) {
    top.damage = Math.max(top.damage, spec.damage * spec.pellets);
    top.rpm = Math.max(top.rpm, spec.rpm);
    top.capacity = Math.max(top.capacity, spec.capacity);
    top.range = Math.max(top.range, spec.range);
  }
  return top;
}

/** What the card says of a weapon: its class, and a gauge each for what one does. */
export function weaponFacts(spec: WeaponSpec): ShopFact[] {
  const hit = spec.damage * spec.pellets;
  const facts: ShopFact[] = [{ label: 'Class', text: spec.cls }];
  if (spec.calibre !== undefined) facts.push({ label: 'Calibre', text: spec.calibre });
  facts.push({ label: 'Damage', text: `${Math.round(hit)}`, bar: gauge(hit, TOP.damage) });
  facts.push({ label: 'Rate', text: `${spec.rpm} rpm`, bar: gauge(spec.rpm, TOP.rpm) });
  if (spec.capacity > 0) {
    facts.push({ label: 'Magazine', text: `${spec.capacity}`, bar: gauge(spec.capacity, TOP.capacity) });
  }
  if (spec.range > 0) facts.push({ label: 'Range', text: `${spec.range} m`, bar: gauge(spec.range, TOP.range) });
  else facts.push({ label: 'Reach', text: `${spec.reach} m` });
  if (spec.automatic) facts.push({ label: 'Action', text: 'automatic' });
  if (spec.concealed) facts.push({ label: 'Carry', text: 'concealed' });
  return facts;
}

/**
 * A gauge that shows a small number as more than a sliver: the square root
 * spreads the bottom of a range that runs from a knife to a rocket.
 */
function gauge(value: number, top: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, value) / top));
}

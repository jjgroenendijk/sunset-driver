/**
 * The menus of the cafés and the bars (spec section 16.1).
 *
 * A convenience store sells the same shelf everywhere. A café or a bar does
 * not: each one picks its own menu from the tables below, a few rows of each
 * section, and prices it by the wealth of its district. A dive bar in the
 * docks sells a lager for less than a cocktail bar in the core charges for
 * the same glass. Each one also pours a drink of its own, named after it.
 *
 * Food and drink is health (spec section 11.5), as at the store, but a café
 * or a bar serves a player who is not hurt as well: sitting down with a drink
 * is what the room is for.
 *
 * Pure: the seed and the shop give the menu, so the counter a player buys off
 * is the counter the record replays.
 */
import { genRng, Subsystem, type Rng } from '../../core/rng.ts';
import type { PropId } from './shop-goods.ts';

/** One dish or drink a venue may sell. `price` is a mid-city price before the district moves it. */
interface MenuItem {
  label: string;
  price: number;
  health: number;
  prop: PropId;
  colour: number;
  blurb: string;
}

/** One section of a menu: its heading, how many rows a venue takes of it, and the rows to choose from. */
export interface MenuSection {
  group: string;
  least: number;
  most: number;
  items: readonly MenuItem[];
}

/** One row of a venue's menu, priced for its district. */
export interface MenuRow extends MenuItem {
  group: string;
}

const COFFEE: readonly MenuItem[] = [
  { label: 'Espresso', price: 3, health: 5, prop: 'coffee', colour: 0xf2ede6, blurb: 'One short shot, thick crema.' },
  { label: 'Americano', price: 4, health: 6, prop: 'coffee', colour: 0xf2ede6, blurb: 'Espresso, hot water, no fuss.' },
  { label: 'Flat white', price: 5, health: 7, prop: 'coffee', colour: 0xe8dcc8, blurb: 'Silky milk over a double shot.' },
  { label: 'Cappuccino', price: 5, health: 7, prop: 'coffee', colour: 0xe0c8a8, blurb: 'Foam, cocoa dust, a biscuit.' },
  { label: 'Latte', price: 5, health: 7, prop: 'coffee', colour: 0xd8c0a0, blurb: 'A tall glass, mostly milk.' },
  { label: 'Cortado', price: 4, health: 6, prop: 'coffee', colour: 0xc8a888, blurb: 'Half coffee, half milk.' },
  { label: 'Mocha', price: 6, health: 9, prop: 'coffee', colour: 0x8a5a3a, blurb: 'Chocolate and coffee, whipped cream.' },
  { label: 'Iced latte', price: 6, health: 8, prop: 'cocktail', colour: 0xd8c0a0, blurb: 'Cold milk, ice, a double shot.' },
  { label: 'Cold brew', price: 6, health: 8, prop: 'cocktail', colour: 0x5a3a28, blurb: 'Steeped all night.' },
];

const TEA: readonly MenuItem[] = [
  { label: 'Green tea', price: 4, health: 6, prop: 'tea', colour: 0x9ac070, blurb: 'Loose leaf, in a small pot.' },
  { label: 'Mint tea', price: 4, health: 6, prop: 'tea', colour: 0x6ab080, blurb: 'Fresh leaves in a glass.' },
  { label: 'Chai latte', price: 5, health: 8, prop: 'coffee', colour: 0xd0a070, blurb: 'Cinnamon, cardamom, milk.' },
  { label: 'Matcha latte', price: 6, health: 8, prop: 'coffee', colour: 0x8cc06a, blurb: 'Bright green and earthy.' },
  { label: 'Hot chocolate', price: 5, health: 9, prop: 'coffee', colour: 0x6a4028, blurb: 'Thick, with marshmallows.' },
  { label: 'Orange juice', price: 5, health: 10, prop: 'cocktail', colour: 0xf0a030, blurb: 'Squeezed while you wait.' },
  { label: 'Lemonade', price: 4, health: 7, prop: 'cocktail', colour: 0xf0e070, blurb: 'Homemade, not too sweet.' },
  { label: 'Berry smoothie', price: 7, health: 14, prop: 'cocktail', colour: 0xb03a70, blurb: 'Berries, banana, yoghurt.' },
];

const BAKERY: readonly MenuItem[] = [
  { label: 'Croissant', price: 3, health: 10, prop: 'pastry', colour: 0xd9a45a, blurb: 'Buttery, still flaking.' },
  { label: 'Pain au chocolat', price: 4, health: 11, prop: 'pastry', colour: 0xc08040, blurb: 'Two bars of dark chocolate.' },
  { label: 'Cinnamon bun', price: 4, health: 12, prop: 'pastry', colour: 0xb07038, blurb: 'Sticky, with a sugar glaze.' },
  { label: 'Banana bread', price: 4, health: 12, prop: 'cake', colour: 0xa06a38, blurb: 'A thick slice, toasted.' },
  { label: 'Blueberry muffin', price: 4, health: 11, prop: 'cake', colour: 0x5a4a90, blurb: 'Bursting with berries.' },
  { label: 'Almond croissant', price: 5, health: 13, prop: 'pastry', colour: 0xe0c090, blurb: 'Filled and baked twice.' },
];

const CAKES: readonly MenuItem[] = [
  { label: 'Cheesecake', price: 6, health: 15, prop: 'cake', colour: 0xf0e0c0, blurb: 'New York style, berry sauce.' },
  { label: 'Carrot cake', price: 6, health: 15, prop: 'cake', colour: 0xd08040, blurb: 'Walnuts and cream cheese.' },
  { label: 'Brownie', price: 4, health: 12, prop: 'cake', colour: 0x4a2a1a, blurb: 'Fudgy in the middle.' },
  { label: 'Lemon tart', price: 5, health: 12, prop: 'cake', colour: 0xf0d040, blurb: 'Sharp and sweet.' },
  { label: 'Chocolate cake', price: 6, health: 16, prop: 'cake', colour: 0x5a3020, blurb: 'Three layers, dark ganache.' },
];

const KITCHEN: readonly MenuItem[] = [
  { label: 'Avocado toast', price: 9, health: 25, prop: 'sandwich', colour: 0x8cb050, blurb: 'Sourdough, chilli, lime.' },
  { label: 'Bagel', price: 7, health: 20, prop: 'donut', colour: 0xd0a060, blurb: 'Cream cheese and salmon.' },
  { label: 'Ham and cheese toastie', price: 7, health: 22, prop: 'sandwich', colour: 0xe0b060, blurb: 'Pressed until it melts.' },
  { label: 'Soup of the day', price: 8, health: 26, prop: 'noodles', colour: 0xd07040, blurb: 'With bread and butter.' },
  { label: 'Quiche', price: 8, health: 24, prop: 'cake', colour: 0xe0c070, blurb: 'Spinach and feta, a side salad.' },
  { label: 'Breakfast plate', price: 12, health: 40, prop: 'burger', colour: 0xc08040, blurb: 'Eggs, beans, toast, all of it.' },
];

const BEER: readonly MenuItem[] = [
  { label: 'Lager', price: 5, health: 4, prop: 'beer', colour: 0xe8c040, blurb: 'Cold, on tap.' },
  { label: 'Pale ale', price: 6, health: 4, prop: 'beer', colour: 0xd89830, blurb: 'Hoppy and bright.' },
  { label: 'IPA', price: 7, health: 4, prop: 'beer', colour: 0xd08020, blurb: 'Bitter, from a local brewery.' },
  { label: 'Stout', price: 6, health: 5, prop: 'beer', colour: 0x2a1a10, blurb: 'Black, with a cream head.' },
  { label: 'Wheat beer', price: 6, health: 4, prop: 'beer', colour: 0xf0d070, blurb: 'Cloudy, with a slice of orange.' },
  { label: 'Cider', price: 6, health: 4, prop: 'beer', colour: 0xe0b050, blurb: 'Dry apple, over ice.' },
  { label: 'Pilsner', price: 5, health: 4, prop: 'beer', colour: 0xf0d850, blurb: 'Crisp, from a bottle.' },
];

const WINE: readonly MenuItem[] = [
  { label: 'House red', price: 7, health: 4, prop: 'wine', colour: 0x7a1a28, blurb: 'A generous glass.' },
  { label: 'House white', price: 7, health: 4, prop: 'wine', colour: 0xf0e0a0, blurb: 'Chilled and dry.' },
  { label: 'Rosé', price: 7, health: 4, prop: 'wine', colour: 0xf0a0a0, blurb: 'Pale pink, very cold.' },
  { label: 'Prosecco', price: 8, health: 4, prop: 'wine', colour: 0xf0e8b0, blurb: 'Bubbles in a tall flute.' },
];

const COCKTAILS: readonly MenuItem[] = [
  { label: 'Mojito', price: 10, health: 5, prop: 'cocktail', colour: 0xc0e0a0, blurb: 'Rum, lime, mint, soda.' },
  { label: 'Margarita', price: 10, health: 5, prop: 'cocktail', colour: 0xe0f0a0, blurb: 'Tequila, lime, a salted rim.' },
  { label: 'Negroni', price: 11, health: 5, prop: 'cocktail', colour: 0xc03020, blurb: 'Gin, vermouth, bitter orange.' },
  { label: 'Old fashioned', price: 12, health: 5, prop: 'spirit', colour: 0xc07020, blurb: 'Bourbon, sugar, bitters.' },
  { label: 'Piña colada', price: 11, health: 6, prop: 'cocktail', colour: 0xf8f0d8, blurb: 'Rum, pineapple, coconut.' },
  { label: 'Daiquiri', price: 10, health: 5, prop: 'cocktail', colour: 0xf0a0b0, blurb: 'Strawberry, blended with ice.' },
  { label: 'Espresso martini', price: 12, health: 6, prop: 'cocktail', colour: 0x3a2418, blurb: 'Vodka, coffee, three beans.' },
  { label: 'Dark and stormy', price: 10, health: 5, prop: 'cocktail', colour: 0x8a5028, blurb: 'Dark rum and ginger beer.' },
];

const SPIRITS: readonly MenuItem[] = [
  { label: 'Whisky', price: 8, health: 3, prop: 'spirit', colour: 0xc08030, blurb: 'Neat, or with one ice cube.' },
  { label: 'Dark rum', price: 7, health: 3, prop: 'spirit', colour: 0x8a4a20, blurb: 'Spiced, from the islands.' },
  { label: 'Tequila', price: 6, health: 3, prop: 'shot', colour: 0xf0e0b0, blurb: 'Salt, a shot, a slice of lime.' },
  { label: 'Gin and tonic', price: 9, health: 4, prop: 'cocktail', colour: 0xe0f0f0, blurb: 'Plenty of ice, a twist.' },
  { label: 'Vodka soda', price: 8, health: 3, prop: 'cocktail', colour: 0xf0f8f8, blurb: 'Clean and cold.' },
];

const BAR_FOOD: readonly MenuItem[] = [
  { label: 'Salted peanuts', price: 3, health: 8, prop: 'snack', colour: 0xc89050, blurb: 'A bowl for the table.' },
  { label: 'Olives', price: 4, health: 8, prop: 'snack', colour: 0x607a30, blurb: 'Green and black, with garlic.' },
  { label: 'Fries', price: 5, health: 18, prop: 'snack', colour: 0xf0c050, blurb: 'Crisp, with mayonnaise.' },
  { label: 'Nachos', price: 9, health: 28, prop: 'snack', colour: 0xf0b030, blurb: 'Cheese, jalapeños, salsa.' },
  { label: 'Chicken wings', price: 10, health: 32, prop: 'snack', colour: 0xc05020, blurb: 'Hot sauce and blue cheese.' },
  { label: 'Sliders', price: 11, health: 38, prop: 'burger', colour: 0xa0602a, blurb: 'Three small burgers.' },
];

const SOFT: readonly MenuItem[] = [
  { label: 'Cola', price: 3, health: 6, prop: 'soda', colour: 0xc8302a, blurb: 'From the gun, with ice.' },
  { label: 'Ginger beer', price: 4, health: 6, prop: 'soda', colour: 0xd8b060, blurb: 'Sharp and fizzy.' },
  { label: 'Soda and lime', price: 3, health: 5, prop: 'cocktail', colour: 0xe0f0c0, blurb: 'For the driver.' },
];

/** A café's menu: coffee first, then the rest of the drinks, then the food. */
export const CAFE_MENU: readonly MenuSection[] = [
  { group: 'Coffee', least: 3, most: 6, items: COFFEE },
  { group: 'Tea and more', least: 2, most: 4, items: TEA },
  { group: 'Bakery', least: 2, most: 4, items: BAKERY },
  { group: 'Cakes', least: 1, most: 3, items: CAKES },
  { group: 'Kitchen', least: 0, most: 3, items: KITCHEN },
];

/** A bar's menu: the drinks, then something to eat with them. */
export const BAR_MENU: readonly MenuSection[] = [
  { group: 'On tap', least: 2, most: 5, items: BEER },
  { group: 'Wine', least: 0, most: 3, items: WINE },
  { group: 'Cocktails', least: 1, most: 5, items: COCKTAILS },
  { group: 'Spirits', least: 1, most: 3, items: SPIRITS },
  { group: 'Bar food', least: 1, most: 4, items: BAR_FOOD },
  { group: 'Soft drinks', least: 1, most: 2, items: SOFT },
];

/** What a venue charges against the mid-city price: a poor district's and a rich one's. */
const CHEAPEST = 0.7;
const DEAREST = 1.7;

/** How far a venue strays from its district's price, either way. */
const WHIM = 0.15;

/** What the house drink of a café and of a bar is built on. */
const HOUSE_CAFE: MenuItem = {
  label: 'house blend',
  price: 6,
  health: 9,
  prop: 'coffee',
  colour: 0xc89060,
  blurb: 'Their own roast. They will tell you about it.',
};
const HOUSE_BAR: MenuItem = {
  label: 'special',
  price: 12,
  health: 6,
  prop: 'cocktail',
  colour: 0xe05a8a,
  blurb: 'Nobody will say what is in it.',
};

/**
 * The menu of one café or bar: a few rows of each section, dealt from the seed
 * and the shop, in the order the sections run, and the house's own drink
 * first. `name` is the venue's own, which the house drink is called after.
 */
export function menuOf(seed: number, shopId: number, bar: boolean, wealth: number, name: string): MenuRow[] {
  const rng = genRng(seed, Subsystem.Venues, shopId + 0x10000);
  const scale = (CHEAPEST + (DEAREST - CHEAPEST) * Math.max(0, Math.min(1, wealth))) * (1 + (rng.float() * 2 - 1) * WHIM);
  const house = bar ? HOUSE_BAR : HOUSE_CAFE;
  const rows: MenuRow[] = [{ ...house, label: `${name} ${house.label}`, group: 'House', price: priced(house.price, scale) }];
  for (const section of bar ? BAR_MENU : CAFE_MENU) {
    for (const item of dealt(rng, section)) rows.push({ ...item, group: section.group, price: priced(item.price, scale) });
  }
  return rows;
}

/** The rows a venue takes of one section, in the section's own order. */
function dealt(rng: Rng, section: MenuSection): MenuItem[] {
  const most = Math.min(section.most, section.items.length);
  const count = section.least + Math.floor(rng.float() * (most - section.least + 1));
  const order = section.items.map((_, i) => i);
  rng.shuffle(order);
  const kept = order.slice(0, count).sort((a, b) => a - b);
  return kept.map((i) => section.items[i] as MenuItem);
}

/** A price moved by the venue's scale, in whole dollars and never under one. */
function priced(price: number, scale: number): number {
  return Math.max(1, Math.round(price * scale));
}

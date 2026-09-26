/**
 * The names of the cafés and the bars (spec section 16.1).
 *
 * A convenience store is the store and a clinic is the clinic, but a place to
 * eat and drink is known by its own name: "The Rusty Anchor", "Café Lune".
 * The name is dealt from the seed and the shop, so the same café of the same
 * city always has the same name, and the counter's panel and the map both say
 * it.
 *
 * Pure: the seed and the shop's id give the name, nothing else.
 */
import { genRng, Subsystem, type Rng } from '../../core/rng.ts';
import type { ShopKind } from './shops.ts';

const ADJECTIVES = [
  'Rusty', 'Golden', 'Blue', 'Salty', 'Lucky', 'Crooked', 'Velvet', 'Silver', 'Red', 'Sleepy',
  'Copper', 'Wild', 'Little', 'Painted', 'Hidden', 'Neon', 'Black', 'Green', 'Honest', 'Last',
];

const BAR_NOUNS = [
  'Anchor', 'Parrot', 'Lantern', 'Fox', 'Crow', 'Palm', 'Tide', 'Barrel', 'Compass', 'Moon',
  'Harbour', 'Pelican', 'Lion', 'Wheel', 'Flamingo', 'Pier', 'Coyote', 'Shark', 'Owl', 'Rooster',
];

const CAFE_NOUNS = [
  'Bean', 'Cup', 'Kettle', 'Spoon', 'Crumb', 'Pot', 'Mill', 'Leaf', 'Loaf', 'Sparrow',
  'Morning', 'Window', 'Corner', 'Garden', 'Porch', 'Lemon', 'Fig', 'Almond', 'Biscuit', 'Daisy',
];

const WORDS = [
  'Lune', 'Soleil', 'Roma', 'Havana', 'Lisbon', 'Tokyo', 'Oslo', 'Nova', 'Paloma', 'Aurora',
  'Bonita', 'Marina', 'Vesper', 'Cielo', 'Mocha', 'Luxe', 'Tango', 'Riviera', 'Oasis', 'Brava',
];

const OWNERS = [
  "Rosa's", "Marco's", "Lou's", "Dot's", "Frankie's", "Mae's", "Sal's", "Hank's", "Nina's", "Vic's",
  "Ruby's", "Otto's", "June's", "Benny's", "Iris's", "Gus's", "Lola's", "Ray's", "Pearl's", "Ziggy's",
];

/** The name of a café or a bar, and undefined for every other trade. */
export function venueName(seed: number, shopId: number, kind: ShopKind): string | undefined {
  if (kind !== 'cafe' && kind !== 'bar') return undefined;
  const rng = genRng(seed, Subsystem.Venues, shopId);
  return kind === 'cafe' ? cafeName(rng) : barName(rng);
}

function cafeName(rng: Rng): string {
  switch (Math.floor(rng.float() * 5)) {
    case 0:
      return `Café ${rng.pick(WORDS)}`;
    case 1:
      return `${rng.pick(WORDS)} Coffee`;
    case 2:
      return `The ${rng.pick(ADJECTIVES)} ${rng.pick(CAFE_NOUNS)}`;
    case 3:
      return `${rng.pick(OWNERS)} Kitchen`;
    default:
      return `${rng.pick(CAFE_NOUNS)} & ${rng.pick(CAFE_NOUNS)}`;
  }
}

function barName(rng: Rng): string {
  switch (Math.floor(rng.float() * 5)) {
    case 0:
      return `The ${rng.pick(ADJECTIVES)} ${rng.pick(BAR_NOUNS)}`;
    case 1:
      return `${rng.pick(OWNERS)} Bar`;
    case 2:
      return `Bar ${rng.pick(WORDS)}`;
    case 3:
      return `${rng.pick(WORDS)} Lounge`;
    default:
      return `The ${rng.pick(BAR_NOUNS)} & ${rng.pick(BAR_NOUNS)}`;
  }
}

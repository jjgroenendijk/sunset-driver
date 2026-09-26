/**
 * The goods of the contraband trade (spec section 16.2): what each one is, what
 * it is worth before a district moves it, and who trades it at home.
 *
 * The prices are in `contraband.ts`; this is only the list. The record stores a
 * holding per good in the order of {@link GOOD_IDS}, so a new good changes the
 * shape of a save and raises `SAVE_VERSION`.
 *
 * The goods stand in three groups, and the panel draws them under those
 * headings in this order. Inside a group they run cheapest first. Across the
 * list the prices are a ladder of about twice a step, so a run of the cheapest
 * is worth carrying early and the dearest is a session's savings.
 *
 * The home culture follows the faction table of spec section 17.1: the Docklands
 * smuggle, the Syndicate trades counterfeits, the Bratva runs the chop shops,
 * Los Reyes the street distribution. The Crew and Unit 13 keep no home good.
 */
import type { Culture } from '../../world/types.ts';

/** The goods of the trade. The record stores a holding per row, in this order. */
export const GOOD_IDS = [
  'cigarettes',
  'liquor',
  'cigars',
  'handbags',
  'counterfeits',
  'phones',
  'parts',
  'jewellery',
  'paintings',
  'weed',
  'pills',
  'powder',
] as const;
export type GoodId = (typeof GOOD_IDS)[number];

/** The headings the panel groups the goods under, in the order it draws them. */
export const GOOD_GROUPS = ['Smokes and drink', 'Fakes and stolen goods', 'Street pharmacy'] as const;
type GoodGroup = (typeof GOOD_GROUPS)[number];

/** One line of the trade. */
export interface Good {
  id: GoodId;
  /** What the panel calls it. */
  name: string;
  /** The heading it stands under on the panel. */
  group: GoodGroup;
  /** One line about it, for the card of the panel. */
  blurb: string;
  /** Dollars a unit costs in a district that neither makes it nor wants it. */
  base: number;
  /**
   * How far the drift and the shocks move this good, 0..1. A carton of
   * cigarettes is worth much the same all week; a street drug is not.
   */
  volatility: number;
  /**
   * How much a rich district pays over a poor one, as a share of the base
   * price each way. Negative for the goods the poorest streets buy most.
   */
  wealth: number;
  /** How much a crowded district pays over an empty one, the same way. */
  density: number;
  /**
   * The culture that trades this good at home (spec section 17.1). Its own
   * district is where the good is plentiful, so that is where it is cheap.
   * `none` makes it cheap in the districts no faction holds.
   */
  home: Culture;
}

/** The twelve goods, in the order of {@link GOOD_IDS}. */
export const GOODS: readonly Good[] = Object.freeze([
  {
    id: 'cigarettes', name: 'Untaxed cigarettes', group: 'Smokes and drink', base: 45,
    volatility: 0.25, wealth: -0.15, density: 0.1, home: 'irish',
    blurb: 'Cartons off a ship that never docked. Every corner smokes.',
  },
  {
    id: 'liquor', name: 'Bootleg liquor', group: 'Smokes and drink', base: 120,
    volatility: 0.35, wealth: 0.1, density: 0.15, home: 'italian',
    blurb: 'Good labels on bottles filled in a basement.',
  },
  {
    id: 'cigars', name: 'Cuban cigars', group: 'Smokes and drink', base: 210,
    volatility: 0.3, wealth: 0.45, density: 0, home: 'latin',
    blurb: 'Hand rolled, and nobody asks which island. The rich pay most.',
  },
  {
    id: 'handbags', name: 'Knock-off handbags', group: 'Fakes and stolen goods', base: 150,
    volatility: 0.3, wealth: 0.15, density: 0.25, home: 'chinese',
    blurb: 'The stitching is almost right. Sells where the crowd is.',
  },
  {
    id: 'counterfeits', name: 'Counterfeit watches', group: 'Fakes and stolen goods', base: 260,
    volatility: 0.4, wealth: 0.3, density: 0, home: 'chinese',
    blurb: 'Swiss on the dial, somewhere else inside.',
  },
  {
    id: 'phones', name: 'Stolen phones', group: 'Fakes and stolen goods', base: 340,
    volatility: 0.45, wealth: 0.2, density: 0.2, home: 'none',
    blurb: 'Wiped, unlocked and boxed again.',
  },
  {
    id: 'parts', name: 'Chop-shop parts', group: 'Fakes and stolen goods', base: 520,
    volatility: 0.3, wealth: -0.1, density: -0.1, home: 'east-european',
    blurb: 'Engines and doors from cars that are still reported missing.',
  },
  {
    id: 'jewellery', name: 'Hot jewellery', group: 'Fakes and stolen goods', base: 1100,
    volatility: 0.5, wealth: 0.5, density: 0, home: 'irish',
    blurb: 'Rings and chains from a job on the waterfront.',
  },
  {
    id: 'paintings', name: 'Stolen paintings', group: 'Fakes and stolen goods', base: 3200,
    volatility: 0.7, wealth: 0.6, density: -0.05, home: 'italian',
    blurb: 'Cut from the frame. Only the richest streets have a buyer.',
  },
  {
    id: 'weed', name: 'Cannabis', group: 'Street pharmacy', base: 70,
    volatility: 0.3, wealth: -0.05, density: 0.2, home: 'beach',
    blurb: 'Grown behind the dunes and sold by the bag.',
  },
  {
    id: 'pills', name: 'Prescription pills', group: 'Street pharmacy', base: 900,
    volatility: 0.5, wealth: 0.2, density: 0.1, home: 'outlaw',
    blurb: 'Bottles with somebody else’s name on them.',
  },
  {
    id: 'powder', name: 'Cocaine', group: 'Street pharmacy', base: 1800,
    volatility: 0.6, wealth: 0.35, density: 0.05, home: 'latin',
    blurb: 'Pressed bricks. The price swings hardest of all.',
  },
] as const);

/** The row a good stands on, or -1 for a name no good carries. */
export function goodIndex(id: GoodId): number {
  return GOOD_IDS.indexOf(id);
}

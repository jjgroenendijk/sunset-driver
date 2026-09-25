/**
 * Dealing with a dealer (spec section 16.2).
 *
 * `contraband.ts` says what a good is worth in a district and `dealer.ts` where
 * the dealers are standing; this is the player doing business with one. A deal
 * is opened on the interact key from the pavement beside a pitch, the way a
 * shop door is opened, and the panel's buttons, `Enter` or the number keys
 * then buy and sell.
 *
 * A trade is all or nothing on purpose. A buy takes as many units as the money
 * and the room allow, and a sale is the whole holding: the sell button, or
 * `Enter` or a number key with the sprint key held. Two keys are the whole loop of the trade — buy the cheap good
 * here, drive across town, sell it there — and a player never counts units into
 * a keyboard.
 *
 * What the record carries is the stash and what was paid for it, and nothing
 * about the prices: those are a function of the seed and the tick
 * (`contraband.ts`), so a save loaded a week later meets the market it left.
 *
 * Pure: it reads the record and writes the record, and takes no wall-clock.
 */
import { hypot } from '../core/libm.ts';
import { clamp } from '../core/math.ts';
import { GOODS } from './contraband.ts';
import { priceAt, standingPrice, GLUT, SPIKE } from './contraband.ts';
import { dealerAt, dealRefusal, pitchOf, DEALER_REACH, type DealerPlace } from './dealer.ts';
import { factionForCulture, shiftStanding, standingOf } from './faction.ts';
import type { InputFrame } from './input.ts';
import { reachesVehicle } from './on-foot.ts';
import type { SimState } from './simulation.ts';
import { specOf } from './vehicle.ts';

/**
 * Units of contraband a player may carry at once. A safehouse keeps five times
 * as many and an arrest cannot reach them (spec sections 16.3, 11.7), which is
 * what makes the drive home worth the trip.
 */
export const STASH_UNITS = 80;

/** The share a dealer keeps between what they sell at and what they pay. */
const CUT = 0.08;

/** How far a dealer's opinion of the player may move that cut, each way. */
const CUT_FAVOUR = 0.06;

/** Metres past the pitch a player may drift before the deal is over. */
const DEAL_MARGIN = 2;

/** How far one trade moves the standing of the faction whose corner it was made on. */
const TRADE_STANDING = 0.01;

/** What the player is carrying and who they are dealing with (spec section 16.2). */
export interface MarketState {
  /** Units held of each good, in the order of `GOODS`. */
  stash: number[];
  /** Dollars paid for the units held, per good, so a sale can say what it made. */
  paid: number[];
  /** The dealer the player is doing business with, or null out on the street. */
  deal: DealState | null;
}

/** The deal the player has open, as the record carries it. */
interface DealState {
  /** Index into the world's dealers of the one they are dealing with. */
  dealer: number;
  /** The tick the deal was opened on. */
  started: number;
  /** What the last trade said, in the words the panel shows. Empty before the first. */
  said: string;
}

/** One line of the trading panel: a good, what it costs here, and what the player holds. */
export interface TradeRow {
  /** The row the good stands on, which is also the number key that trades it. */
  good: number;
  name: string;
  /** Dollars a unit, buying. */
  buy: number;
  /** Dollars a unit, selling. */
  sell: number;
  /** Units the player is carrying. */
  held: number;
  /** Units they could buy here now, which the money and the room both hold down. */
  room: number;
  /** Dollars paid for the units held, over all of them. */
  paid: number;
  /** What the good costs in this district on an ordinary day, which `mood` is measured against. */
  standing: number;
  /** 'spike' where the street is paying over the odds, 'glut' where it is not, else ''. */
  mood: string;
}

export function createMarketState(): MarketState {
  return { stash: GOODS.map(() => 0), paid: GOODS.map(() => 0), deal: null };
}

/** Units the player is carrying, over every good. */
export function carrying(market: MarketState): number {
  let total = 0;
  for (const units of market.stash) total += units;
  return total;
}

/** The dealer the player has a deal open with, or undefined while they have none. */
export function dealing(state: SimState, dealers: readonly DealerPlace[]): DealerPlace | undefined {
  const deal = state.market.deal;
  return deal === null ? undefined : dealers[deal.dealer];
}

/**
 * How well a dealer thinks of the player, -1..1 (spec section 17.3). It is what
 * moves their cut, so standing with a faction is worth money on the corners it
 * holds. A dealer works a district, and a district's culture says which faction
 * runs it (`faction.ts`); one in nobody's district has no opinion, so they deal
 * at the standing cut whatever the player has been doing elsewhere.
 */
export function favourOf(state: SimState, dealer: DealerPlace): number {
  const faction = factionForCulture(dealer.district.culture);
  return faction < 0 ? 0 : standingOf(state, faction);
}

/**
 * Deal with the faction whose district this is (spec section 17.3). Business is
 * how a stranger becomes a name, so every trade moves the standing a hair —
 * and, through `shiftStanding`, moves their rivals' the other way. It is small
 * on purpose: a reputation is built over a session of driving, not over one
 * sale.
 */
function credit(state: SimState, dealer: DealerPlace): void {
  const faction = factionForCulture(dealer.district.culture);
  if (faction >= 0) shiftStanding(state, faction, TRADE_STANDING);
}

/** Dollars a unit costs from this dealer on this tick. */
function buyPrice(state: SimState, dealer: DealerPlace, good: number): number {
  return priceAt(state.seed, state.tick, dealer.district, good);
}

/** Dollars a unit this dealer pays: the price of the moment, less their cut. */
export function sellPrice(state: SimState, dealer: DealerPlace, good: number): number {
  const cut = clamp(CUT - favourOf(state, dealer) * CUT_FAVOUR, 0, 1);
  return Math.max(1, Math.round(buyPrice(state, dealer, good) * (1 - cut)));
}

/** The counter of the dealer the player is with: nothing at all while they are with none. */
export function tradeRows(state: SimState, dealers: readonly DealerPlace[]): TradeRow[] {
  const dealer = dealing(state, dealers);
  if (dealer === undefined) return [];
  const room = STASH_UNITS - carrying(state.market);
  const rows: TradeRow[] = [];
  for (let good = 0; good < GOODS.length; good++) {
    const buy = buyPrice(state, dealer, good);
    const standing = standingPrice(state.seed, dealer.district, good);
    rows.push({
      good,
      name: (GOODS[good]?.name ?? ''),
      buy,
      sell: sellPrice(state, dealer, good),
      held: state.market.stash[good] ?? 0,
      room: Math.max(0, Math.min(room, Math.floor(state.money / buy))),
      paid: state.market.paid[good] ?? 0,
      standing,
      mood: buy >= standing * SPIKE ? 'spike' : buy <= standing * GLUT ? 'glut' : '',
    });
  }
  return rows;
}

/**
 * Advance the market by one tick, after the shops and before the physics.
 *
 * It opens a deal on the interact key at a pitch, trades the row the input
 * frame names, and closes the deal when the player presses the key again, walks
 * off the corner or brings the police with them. Nothing here moves the player,
 * so unlike a shop door it has nothing to tell the physics.
 */
export function stepMarket(state: SimState, input: InputFrame, dealers: readonly DealerPlace[]): void {
  const p = state.player;
  // A lock, a shop counter and a front door all hold the interact key before
  // this does (spec sections 11.4, 16.1, 16.3), and a player inside a shop or
  // standing on their own step is not on a corner.
  if (state.theft !== null || state.shop !== null || state.property.visit !== null) {
    state.market.deal = null;
    return;
  }
  const pressed = input.interact && !p.held.interact;
  const deal = state.market.deal;
  if (deal !== null) {
    const dealer = dealers[deal.dealer];
    if (dealer === undefined) {
      state.market.deal = null;
      return;
    }
    if (pressed) {
      // The press is spent here, so the car at the kerb does not open on it.
      p.held.interact = true;
      state.market.deal = null;
      return;
    }
    const pitch = pitchOf(dealer, state.tick);
    const away = hypot(pitch.x - p.x, pitch.y - p.y);
    if (away > DEALER_REACH + DEAL_MARGIN || dealRefusal(state, dealer) !== null) {
      state.market.deal = null;
      return;
    }
    const row = Math.trunc(input.trade);
    if (row > 0) buy(state, dealer, row - 1);
    else if (row < 0) sell(state, dealer, -row - 1);
    return;
  }
  if (!pressed || p.driving) return;
  // The vehicle has the key first (spec section 11.2), as it does at a shop
  // door: a dealer stands on the pavement the player parks against.
  if (reachesVehicle(p, state.vehicle, specOf(state.vehicle.cls))) return;
  const at = dealerAt(dealers, state);
  if (dealers[at] === undefined || dealRefusal(state, dealers[at]) !== null) return;
  p.held.interact = true;
  state.market.deal = { dealer: at, started: state.tick, said: '' };
}

/** Buy as many units as the money and the room allow. */
function buy(state: SimState, dealer: DealerPlace, good: number): void {
  const deal = state.market.deal;
  const spec = GOODS[good];
  if (deal === null || spec === undefined) return;
  const room = STASH_UNITS - carrying(state.market);
  if (room <= 0) {
    deal.said = 'You cannot carry any more.';
    return;
  }
  const price = buyPrice(state, dealer, good);
  const units = Math.min(room, Math.floor(state.money / price));
  if (units <= 0) {
    deal.said = 'Not enough money.';
    return;
  }
  const cost = units * price;
  state.money -= cost;
  state.market.stash[good] = (state.market.stash[good] ?? 0) + units;
  state.market.paid[good] = (state.market.paid[good] ?? 0) + cost;
  credit(state, dealer);
  deal.said = `Bought ${units} × ${spec.name} at ${dollars(price)}.`;
}

/** Sell the whole holding of one good. */
function sell(state: SimState, dealer: DealerPlace, good: number): void {
  const deal = state.market.deal;
  const spec = GOODS[good];
  if (deal === null || spec === undefined) return;
  const held = state.market.stash[good] ?? 0;
  if (held <= 0) {
    deal.said = `You have no ${spec.name.toLowerCase()} to sell.`;
    return;
  }
  const price = sellPrice(state, dealer, good);
  const take = held * price;
  const profit = take - (state.market.paid[good] ?? 0);
  state.money += take;
  state.market.stash[good] = 0;
  state.market.paid[good] = 0;
  credit(state, dealer);
  const made = profit >= 0 ? `Up ${dollars(profit)}.` : `Down ${dollars(-profit)}.`;
  deal.said = `Sold ${held} × ${spec.name} for ${dollars(take)}. ${made}`;
}

/**
 * Dollars, in groups of three. `toLocaleString` would read the machine's own
 * locale, and two machines would then write two different records.
 */
export function dollars(amount: number): string {
  const digits = String(Math.round(Math.abs(amount)));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return `${amount < 0 ? '-$' : '$'}${out}`;
}

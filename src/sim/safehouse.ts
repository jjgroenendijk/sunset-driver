/**
 * Safehouses: the properties a player buys, and what each one holds (spec
 * section 16.3).
 *
 * One property stands in each district that has a street to stand on. It is
 * placed the way a dealer's corner is (`dealer.ts`): a point round the
 * district's site, snapped to the nearest road, so the front door is on a
 * pavement a player can walk up to. Nothing is built for it, because a
 * safehouse is a door and a record and not a room: the player stands at the
 * door and the panel opens there, as a deal opens on a corner.
 *
 * The property broker of spec section 16.1 is the only place one is sold, and
 * the price is the district's: a door in a rich, busy district costs three
 * times what the same door costs on the edge of the city.
 *
 * What a safehouse provides is the spec's four. The respawn point is
 * {@link activeHome}, which `respawn.ts` reads. The stash is a second, larger
 * store of contraband that a death or an arrest never touches, so the drive
 * home is what makes a good run safe. The garage keeps cars. Saving is the
 * pause menu's, which saves anywhere (spec section 16.4), so nothing here
 * repeats it.
 *
 * The garage is an exchange, and that is forced by the record: it carries one
 * vehicle and no way to say a player has none (`simulation.ts`). Taking a car
 * out therefore puts the one the record holds into the slot it came from, so
 * the number of cars a garage keeps never changes. A property comes with its
 * cars, which is what gives the garage something to exchange on the day it is
 * bought.
 *
 * Pure: it reads the record and writes the record, and takes no wall-clock.
 */
import { genRng, Subsystem } from '../core/rng.ts';
import { cos, hypot, sin } from '../core/libm.ts';
import type { District } from '../world/types.ts';
import { GOODS } from './contraband.ts';
import { HANGAR_AIRCRAFT } from './hangar.ts';
import type { InputFrame } from './input.ts';
import { carrying, STASH_UNITS } from './market.ts';
import { reachesVehicle, type Place } from './on-foot.ts';
import type { SimState } from './simulation.ts';
import { createVehicleState, specOf, type VehicleClass, type VehicleState } from './vehicle.ts';

/** Metres of a front door a player on foot may open it from: the reach of a shop door. */
export const SAFEHOUSE_REACH = 4;

/** Metres past the reach a player may drift before the door shuts behind them. */
const DOOR_MARGIN = 2;

/** Metres out of the door a car taken out of the garage stands. */
const CAR_STEP = 5;

/** Units of contraband one safehouse keeps, which is well over what a player carries. */
export const HOME_UNITS = 400;

/** Metres from the middle of a district the property is looked for, and the most it may end up at. */
const DOOR_NEAR = 60;
const DOOR_FAR = 200;
const DOOR_LIMIT = 300;

/** Doors tried round a district before it is left without a property. */
const DOOR_TRIES = 5;

/** Dollars a property costs in the poorest, emptiest district there is. */
const PRICE_BASE = 9000;

/** How much of that price the district's wealth and its crowd add, at the top of each. */
const PRICE_WEALTH = 1.6;
const PRICE_DENSITY = 0.5;

/** Dollars a price is rounded to, so no broker asks for $12,347. */
const PRICE_STEP = 500;

/** The wealth from which a property comes with two garage slots rather than one. */
const GARAGE_RICH = 0.6;

/** The cars a property comes with: what somebody keeps at home, and no bus or boat. */
const GARAGE_CLASSES: readonly VehicleClass[] = ['compact', 'saloon', 'sports', 'van', 'motorcycle', 'offroad'];

/** A property, as the broker sells it and the map marks it. */
export interface SafehousePlace extends Place {
  /** Its own id, which is also where it stands in the list the game builds. */
  id: number;
  /** The district it stands in: the price and the name are both read off it. */
  district: District;
  /** What the panel, the broker's counter and the map call it. */
  name: string;
  /** Dollars the broker asks for it. */
  price: number;
  /** Cars its garage keeps, which never changes once it is bought. */
  slots: number;
  /**
   * Set on the hangar of `hangar.ts`: the apron its aircraft is brought out
   * onto. A house stands its car at the kerb outside the door instead.
   */
  hangar?: Place;
}

/** A safehouse the player owns, and what is in it. */
export interface OwnedSafehouse {
  /** The id of the {@link SafehousePlace} this is the contents of. */
  id: number;
  /** Units of each good kept here, in the order of `GOODS`. */
  stash: number[];
  /** Dollars paid for those units, per good, so a later sale can still say what it made. */
  paid: number[];
  /** The cars in the garage. Taking one out puts the car the record holds in its place. */
  garage: VehicleState[];
}

/** The safehouse the player has the door open at, as the record carries it. */
export interface HomeVisit {
  /** Index into the game's safehouses of the one they are standing in. */
  safehouse: number;
  /** The tick they opened the door on. */
  started: number;
  /** What the last thing they did said, in the words the panel shows. Empty before the first. */
  said: string;
}

/** The property of spec section 16.3, as the record carries it. */
export interface PropertyState {
  /** The safehouses bought, in the order they were bought. */
  owned: OwnedSafehouse[];
  /** The id of the one the player comes back to, or -1 before the first is bought. */
  active: number;
  /** The one whose door is open, or null out on the street. */
  visit: HomeVisit | null;
}

/** One row of the panel at a front door. */
export interface HomeOffer {
  /** The line the panel shows. Nothing here costs money, so no row carries a price. */
  label: string;
  /** Do it, and say what happened in the words the panel shows. */
  take: (state: SimState) => string;
  /** True on the row that brings a car out, which the game stands on the ground outside. */
  fetch?: true;
}

export function createPropertyState(): PropertyState {
  return { owned: [], active: -1, visit: null };
}

/** Dollars a property costs in a district: its wealth and its crowd both add to it. */
export function priceOf(district: District): number {
  const raw = PRICE_BASE * (1 + district.wealth * PRICE_WEALTH) * (1 + district.density * PRICE_DENSITY);
  return Math.round(raw / PRICE_STEP) * PRICE_STEP;
}

/**
 * The properties of a world: one per district that has a street to put a door
 * on. `snap` puts a point on the nearest road and answers nothing where there
 * is no road near it, exactly as the dealers take it, so a simulation test can
 * stand a property on a bare hillside of its own.
 */
export function safehousePlaces(
  seed: number,
  districts: readonly District[],
  snap: (x: number, y: number) => Place | undefined,
): SafehousePlace[] {
  const places: SafehousePlace[] = [];
  for (const district of districts) {
    const rng = genRng(seed, Subsystem.Safehouses, district.id);
    const turn = rng.range(0, Math.PI * 2);
    for (let i = 0; i < DOOR_TRIES; i++) {
      const angle = turn + (i / DOOR_TRIES) * Math.PI * 2;
      const away = rng.range(DOOR_NEAR, DOOR_FAR);
      const place = snap(district.x + cos(angle) * away, district.y + sin(angle) * away);
      if (place === undefined) continue;
      if (hypot(place.x - district.x, place.y - district.y) > DOOR_LIMIT) continue;
      places.push({
        id: places.length,
        district,
        name: `Safehouse · ${district.name}`,
        price: priceOf(district),
        slots: district.wealth >= GARAGE_RICH ? 2 : 1,
        x: place.x,
        y: place.y,
        heading: place.heading,
      });
      break;
    }
  }
  return places;
}

/** The front door the player is standing at, or -1. The nearest one answers, as a shop door does. */
export function safehouseAt(places: readonly SafehousePlace[], state: SimState): number {
  let at = -1;
  let near = SAFEHOUSE_REACH;
  for (let i = 0; i < places.length; i++) {
    const place = places[i] as SafehousePlace;
    const away = hypot(place.x - state.player.x, place.y - state.player.y);
    if (away > near) continue;
    near = away;
    at = i;
  }
  return at;
}

/** What the player owns of a property, or undefined where it is not theirs. */
export function ownedAt(state: SimState, id: number): OwnedSafehouse | undefined {
  return state.property.owned.find((owned) => owned.id === id);
}

/** The safehouse the player comes back to, or undefined before they have bought one. */
export function activeHome(state: SimState, places: readonly SafehousePlace[]): SafehousePlace | undefined {
  const active = state.property.active;
  return active < 0 ? undefined : places.find((place) => place.id === active);
}

/** The safehouse whose door is open, or undefined while the player is out on the street. */
export function visitingHome(state: SimState, places: readonly SafehousePlace[]): SafehousePlace | undefined {
  const visit = state.property.visit;
  return visit === null ? undefined : places[visit.safehouse];
}

/**
 * Buy a property. The money is taken by the broker's counter before this is
 * called (`shop-stock.ts`), as every shop row's is. The first one bought
 * becomes the place the player comes back to, because a player who has just
 * bought a home has no other.
 */
export function buySafehouse(state: SimState, place: SafehousePlace): string {
  const garage: VehicleState[] = [];
  for (let slot = 0; slot < place.slots; slot++) garage.push(houseCar(state.seed, place, slot));
  state.property.owned.push({ id: place.id, stash: GOODS.map(() => 0), paid: GOODS.map(() => 0), garage });
  if (state.property.active < 0) state.property.active = place.id;
  return `${place.name} is yours. The keys are on the hook.`;
}

/**
 * The car a property comes with. It is a function of the seed and the property,
 * so the same house of the same city always has the same car in its garage, and
 * a richer district keeps a better one.
 */
function houseCar(seed: number, place: SafehousePlace, slot: number): VehicleState {
  const rng = genRng(seed, Subsystem.Safehouses, place.id * GARAGE_CLASSES.length + slot);
  const best = GARAGE_CLASSES.length - 1;
  const top = Math.min(best, Math.floor(place.district.wealth * GARAGE_CLASSES.length));
  // A hangar keeps an aircraft (`hangar.ts`). The draw is made either way, so
  // a house's car does not change with whether the map has a hangar.
  const drawn = GARAGE_CLASSES[rng.int(0, top)] as VehicleClass;
  const cls = place.hangar === undefined ? drawn : HANGAR_AIRCRAFT;
  const car = createVehicleState(specOf(cls));
  // A car out of your own garage is a car you have the keys to (spec section 11.4).
  car.hotwired = true;
  return car;
}

/** Units held over every good of a stash. */
export function unitsOf(stash: readonly number[]): number {
  let total = 0;
  for (const units of stash) total += units;
  return total;
}

/**
 * The rows of the panel at a front door: the respawn point, the stash and the
 * garage. A door that is not the player's opens no panel, so this answers with
 * nothing for one.
 */
export function homeOffers(state: SimState, place: SafehousePlace): HomeOffer[] {
  const owned = ownedAt(state, place.id);
  if (owned === undefined) return [];
  const rows: HomeOffer[] = [];
  if (state.property.active !== place.id) {
    rows.push({
      label: 'Make this your home',
      take: (s) => {
        s.property.active = place.id;
        return 'You come back here now.';
      },
    });
  }
  const carried = carrying(state.market);
  const kept = unitsOf(owned.stash);
  if (carried > 0 && kept < HOME_UNITS) {
    rows.push({ label: `Stash what you are carrying · ${carried} units`, take: (s) => move(s, place, true) });
  }
  if (kept > 0 && carried < STASH_UNITS) {
    rows.push({ label: `Take the stash · ${kept} units`, take: (s) => move(s, place, false) });
  }
  for (let slot = 0; slot < owned.garage.length; slot++) {
    const car = owned.garage[slot] as VehicleState;
    rows.push({ label: `Bring the ${specOf(car.cls).name} out`, take: (s) => fetchCar(s, place, slot), fetch: true });
  }
  return rows;
}

/**
 * Move contraband between what the player carries and what the house keeps.
 * Whatever does not fit stays where it was, and what was paid for a good moves
 * with it in proportion, so a sale still says what the run made.
 */
function move(state: SimState, place: SafehousePlace, home: boolean): string {
  const owned = ownedAt(state, place.id);
  if (owned === undefined) return '';
  const from = home ? state.market : owned;
  const to = home ? owned : state.market;
  let room = (home ? HOME_UNITS : STASH_UNITS) - unitsOf(to.stash);
  let moved = 0;
  for (let good = 0; good < GOODS.length; good++) {
    const held = from.stash[good] ?? 0;
    const units = Math.min(held, room);
    if (units <= 0) continue;
    const paid = Math.round(((from.paid[good] ?? 0) * units) / held);
    from.stash[good] = held - units;
    from.paid[good] = (from.paid[good] ?? 0) - paid;
    to.stash[good] = (to.stash[good] ?? 0) + units;
    to.paid[good] = (to.paid[good] ?? 0) + paid;
    room -= units;
    moved += units;
  }
  if (moved === 0) return 'There is no room for it.';
  return home ? `${moved} units are under the floor.` : `${moved} units are in your hands.`;
}

/**
 * Take a car out of the garage. The car the record holds goes into the slot it
 * came out of, wherever it was standing: the record carries one vehicle, so a
 * garage can only ever be an exchange.
 */
function fetchCar(state: SimState, place: SafehousePlace, slot: number): string {
  const owned = ownedAt(state, place.id);
  const car = owned?.garage[slot];
  if (owned === undefined || car === undefined) return '';
  const was = state.vehicle;
  owned.garage[slot] = JSON.parse(JSON.stringify(was)) as VehicleState;
  state.vehicle = car;
  // An attempt at the lock of the car this one replaces means nothing, as it
  // means nothing to the debug picker (spec section 11.4), and nor does a door
  // of it half open.
  state.theft = null;
  state.boarding = null;
  return `The ${specOf(car.cls).name} is outside. The ${specOf(was.cls).name} is put away.`;
}

/** Where a car taken out of the garage is stood: out of the door, facing the street, or a hangar's apron. */
function carPlace(place: SafehousePlace): Place {
  if (place.hangar !== undefined) return place.hangar;
  return {
    x: place.x + cos(place.heading) * CAR_STEP,
    y: place.y + sin(place.heading) * CAR_STEP,
    heading: place.heading,
  };
}

/**
 * Advance the safehouses by one tick, after the shops and before the market.
 *
 * It opens the door the interact key is pressed at, does the row the input
 * frame names, and shuts the door behind a player who presses the key again or
 * walks off the step. It answers with the place a car taken out of the garage
 * is to be stood on the ground, and null on every other tick: the record says
 * which car it is, and not how high the ground under it stands.
 */
export function stepHome(state: SimState, input: InputFrame, places: readonly SafehousePlace[]): Place | null {
  const p = state.player;
  // A lock and a shop counter both hold the interact key first (spec sections
  // 11.4, 16.1), and a player inside a shop is not on their own step. Nor is
  // one halfway into their car.
  if (state.theft !== null || state.shop !== null || state.boarding !== null) {
    state.property.visit = null;
    return null;
  }
  const pressed = input.interact && !p.held.interact;
  const visit = state.property.visit;
  if (visit !== null) {
    const place = places[visit.safehouse];
    if (place === undefined) {
      state.property.visit = null;
      return null;
    }
    if (pressed) {
      // The press is spent here, so the car at the kerb does not open on it.
      p.held.interact = true;
      state.property.visit = null;
      return null;
    }
    if (p.driving || hypot(place.x - p.x, place.y - p.y) > SAFEHOUSE_REACH + DOOR_MARGIN) {
      state.property.visit = null;
      return null;
    }
    const row = Math.trunc(input.buy);
    return row >= 1 ? use(state, place, row - 1) : null;
  }
  if (!pressed || p.driving) return null;
  // The vehicle has the key first (spec section 11.2), as it does at a shop door.
  if (reachesVehicle(p, state.vehicle, specOf(state.vehicle.cls))) return null;
  const at = safehouseAt(places, state);
  const place = places[at];
  if (place === undefined || ownedAt(state, place.id) === undefined) return null;
  p.held.interact = true;
  state.property.visit = { safehouse: at, started: state.tick, said: '' };
  return null;
}

/** Do one row of the panel. A row that is not there leaves the record as it was. */
function use(state: SimState, place: SafehousePlace, row: number): Place | null {
  const visit = state.property.visit;
  const offer = homeOffers(state, place)[row];
  if (visit === null || offer === undefined) return null;
  visit.said = offer.take(state);
  return offer.fetch === true ? carPlace(place) : null;
}

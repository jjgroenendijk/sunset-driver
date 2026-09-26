import { beforeAll, describe, expect, it } from 'vitest';
import { seedFromString } from '../../src/core/rng.ts';
import { goodIndex, GOODS } from '../../src/sim/crime/contraband.ts';
import type { InputFrame } from '../../src/sim/input.ts';
import { carrying, STASH_UNITS } from '../../src/sim/crime/market.ts';
import type { Place } from '../../src/sim/player/on-foot.ts';
import { initPhysics, SimPhysics, type Ground } from '../../src/sim/physics/physics.ts';
import { ARREST_BRIBE, HOSPITAL_FEE } from '../../src/sim/player/respawn.ts';
import { createSave, saveFromText, saveToText } from '../../src/sim/save.ts';
import {
  buySafehouse,
  homeOffers,
  HOME_UNITS,
  ownedAt,
  priceOf,
  safehousePlaces,
  unitsOf,
  type SafehousePlace,
} from '../../src/sim/places/safehouse.ts';
import { shopPlaces, shopOffers, type ShopPlace } from '../../src/sim/places/shop.ts';
import { createSimState, type SimState } from '../../src/sim/simulation.ts';
import type { Shop } from '../../src/world/city/shops.ts';
import type { Culture, District } from '../../src/world/types.ts';
import { stableJson } from '../support/helpers.ts';
import { drive, hills, start, type Session } from '../support/sim-harness.ts';

const POWDER = goodIndex('powder');

function district(id: number, wealth: number, culture: Culture = 'none'): District {
  return { id, name: `D${id}`, zone: 'inner', x: id * 400, y: 0, density: 0.4, wealth, culture };
}

/**
 * Two properties well clear of the spawn and of each other: a cheap door in a
 * poor district and a dear one in a rich district with two garage slots.
 */
const HOMES: readonly SafehousePlace[] = [
  {
    id: 0,
    district: district(0, 0.1),
    name: 'Safehouse · D0',
    price: priceOf(district(0, 0.1)),
    slots: 1,
    x: 200,
    y: 0,
    heading: 0,
  },
  {
    id: 1,
    district: district(1, 0.9),
    name: 'Safehouse · D1',
    price: priceOf(district(1, 0.9)),
    slots: 2,
    x: 600,
    y: 0,
    heading: Math.PI / 2,
  },
];

/** A property broker far enough from either door that the two panels never overlap. */
const BROKER: readonly ShopPlace[] = shopPlaces(
  [{ id: 0, kind: 'broker', building: 0, district: 0, x: -300, y: 0, facing: Math.PI / 2, width: 10, depth: 12, licence: 1 }] as Shop[],
  [{ name: 'D0' }],
);

function city(): Ground {
  return { ...hills(), safehouses: HOMES, shops: BROKER };
}

/** Put the player on foot at a place and let the tick see them there. */
function standAt(session: Session, place: Place): void {
  session.state.player.driving = false;
  session.state.player.x = place.x;
  session.state.player.y = place.y;
  session.physics.stand(session.state);
  drive(session, 1);
}

/** One press of the interact key: a tick with it down, off an edge the last tick left clear. */
function press(session: Session, input: Partial<InputFrame> = {}): void {
  drive(session, 1, { ...input, interact: false });
  drive(session, 1, { ...input, interact: true });
}

/** Walk up to a front door and open it. */
function goHome(session: Session, at: number): SafehousePlace {
  const place = HOMES[at] as SafehousePlace;
  standAt(session, place);
  press(session);
  return place;
}

/** The row a label stands on, counted from 1 as the number keys are. */
function rowOf(state: SimState, place: SafehousePlace, match: string): number {
  return homeOffers(state, place).findIndex((offer) => offer.label.includes(match)) + 1;
}

/** Use one row of the panel at a door. */
function use(session: Session, row: number): void {
  drive(session, 1, { buy: row });
}

/**
 * The safehouses of spec section 16.3, played in the Rapier loop: buying one at
 * a broker, the stash and the garage behind its door, and the respawn of spec
 * section 11.7 that makes it the place the player comes back to.
 */
describe('safehouses', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('prices a property by its district, and puts one door on each district that has a street', () => {
    const districts = [district(0, 0.1), district(1, 0.9), district(2, 0.5)];
    // The third district is bare ground: no point round its site snaps to a
    // road, so it gets no property at all.
    const snap = (x: number, y: number): Place | undefined =>
      (Math.hypot(x - 800, y) < 260 ? undefined : { x, y, heading: 0 });
    const places = safehousePlaces(11, districts, snap);
    expect(places.map((place) => place.district.id)).toEqual([0, 1]);
    expect(places[0]?.id).toBe(0);
    expect(places[1]?.id).toBe(1);
    // A door in a rich district costs more and comes with the second garage slot.
    expect(priceOf(district(1, 0.9))).toBeGreaterThan(priceOf(district(0, 0.1)));
    expect(places[1]?.slots).toBe(2);
    expect(places[0]?.slots).toBe(1);
    // Every door stands on a street of its own district.
    for (const place of places) expect(Math.hypot(place.x - place.district.x, place.y - place.district.y)).toBeLessThan(300);
    // The same seed builds the same city.
    expect(stableJson(safehousePlaces(11, districts, snap))).toBe(stableJson(places));
  });

  it('sells the properties at a broker, nearest that office first, and refuses a door twice', () => {
    const session = start(city());
    const { state } = session;
    standAt(session, BROKER[0] as ShopPlace);
    press(session);
    expect(state.shop).not.toBeNull();
    const rows = shopOffers(state, BROKER, HOMES);
    expect(rows.map((row) => row.label)).toEqual(['Safehouse · D0', 'Safehouse · D1']);
    expect(rows[0]?.price).toBe(HOMES[0]?.price);
    state.money = (HOMES[0] as SafehousePlace).price;
    use(session, 1);
    expect(state.money).toBe(0);
    expect(ownedAt(state, 0)).toBeDefined();
    // The first one bought is where the player comes back, and it comes with a car.
    expect(state.property.active).toBe(0);
    expect(ownedAt(state, 0)?.garage).toHaveLength(1);
    // A door already sold is off the counter.
    expect(shopOffers(state, BROKER, HOMES).map((row) => row.label)).toEqual(['Safehouse · D1']);
    session.physics.dispose();
  });

  it('opens its own door and not anybody else’s', () => {
    const session = start(city());
    const { state } = session;
    goHome(session, 0);
    expect(state.property.visit).toBeNull();
    buySafehouse(state, HOMES[0] as SafehousePlace);
    goHome(session, 0);
    expect(state.property.visit?.safehouse).toBe(0);
    // A press of the same key shuts it again.
    press(session);
    expect(state.property.visit).toBeNull();
    session.physics.dispose();
  });

  it('keeps the contraband a player stashes, and hands it back', () => {
    const session = start(city());
    const { state } = session;
    buySafehouse(state, HOMES[0] as SafehousePlace);
    state.market.stash[POWDER] = 40;
    state.market.paid[POWDER] = 4000;
    const place = goHome(session, 0);
    use(session, rowOf(state, place, 'Stash'));
    expect(carrying(state.market)).toBe(0);
    expect(ownedAt(state, 0)?.stash[POWDER]).toBe(40);
    expect(ownedAt(state, 0)?.paid[POWDER]).toBe(4000);
    use(session, rowOf(state, place, 'Take the stash'));
    expect(state.market.stash[POWDER]).toBe(40);
    expect(state.market.paid[POWDER]).toBe(4000);
    expect(unitsOf(ownedAt(state, 0)?.stash ?? [])).toBe(0);
    session.physics.dispose();
  });

  it('takes back only what the player can carry, and what was paid for it in proportion', () => {
    const session = start(city());
    const { state } = session;
    buySafehouse(state, HOMES[0] as SafehousePlace);
    const owned = ownedAt(state, 0);
    if (owned === undefined) throw new Error('the safehouse was not bought');
    owned.stash[POWDER] = HOME_UNITS;
    owned.paid[POWDER] = HOME_UNITS * 100;
    const place = goHome(session, 0);
    use(session, rowOf(state, place, 'Take the stash'));
    expect(carrying(state.market)).toBe(STASH_UNITS);
    expect(state.market.paid[POWDER]).toBe(STASH_UNITS * 100);
    expect(owned.stash[POWDER]).toBe(HOME_UNITS - STASH_UNITS);
    expect(owned.paid[POWDER]).toBe((HOME_UNITS - STASH_UNITS) * 100);
    session.physics.dispose();
  });

  it('exchanges the car at the door for the one in the garage', () => {
    const session = start(city());
    const { state } = session;
    buySafehouse(state, HOMES[0] as SafehousePlace);
    const owned = ownedAt(state, 0);
    if (owned === undefined) throw new Error('the safehouse was not bought');
    const kept = owned.garage[0]?.cls;
    const drove = state.vehicle.cls;
    state.vehicle.paint = 0x123456;
    const place = goHome(session, 0);
    use(session, rowOf(state, place, 'Bring the'));
    expect(state.vehicle.cls).toBe(kept);
    // The car the player arrived in is what the garage now holds, paint and all.
    expect(owned.garage).toHaveLength(1);
    expect(owned.garage[0]?.cls).toBe(drove);
    expect(owned.garage[0]?.paint).toBe(0x123456);
    // The car out of the garage stands on the ground outside the door.
    expect(Math.hypot(state.vehicle.x - place.x, state.vehicle.z - place.y)).toBeLessThan(8);
    expect(state.vehicle.y).toBeGreaterThan(hills().heightAt(state.vehicle.x, state.vehicle.z));
    expect(state.vehicle.hotwired).toBe(true);
    session.physics.dispose();
  });

  it('brings a dead player back at the safehouse with the stash under the floor', () => {
    const session = start(city());
    const { state } = session;
    state.money = HOSPITAL_FEE;
    buySafehouse(state, HOMES[1] as SafehousePlace);
    const owned = ownedAt(state, 1);
    if (owned === undefined) throw new Error('the safehouse was not bought');
    owned.stash[POWDER] = 25;
    state.player.health = 0;
    drive(session, 1);
    expect(state.player.x).toBe((HOMES[1] as SafehousePlace).x);
    expect(state.player.y).toBe((HOMES[1] as SafehousePlace).y);
    expect(state.money).toBe(0);
    expect(ownedAt(state, 1)?.stash[POWDER]).toBe(25);
    session.physics.dispose();
  });

  it('comes back at whichever safehouse the player made their home', () => {
    const session = start(city());
    const { state } = session;
    buySafehouse(state, HOMES[0] as SafehousePlace);
    buySafehouse(state, HOMES[1] as SafehousePlace);
    expect(state.property.active).toBe(0);
    const place = goHome(session, 1);
    use(session, rowOf(state, place, 'Make this your home'));
    expect(state.property.active).toBe(1);
    state.player.health = 0;
    drive(session, 1);
    expect(state.player.x).toBe(place.x);
    session.physics.dispose();
  });

  it('lets an arrest take what is in the hands and never what is under the floor', () => {
    const session = start(city());
    const { state } = session;
    state.money = ARREST_BRIBE;
    buySafehouse(state, HOMES[0] as SafehousePlace);
    const owned = ownedAt(state, 0);
    if (owned === undefined) throw new Error('the safehouse was not bought');
    owned.stash[POWDER] = 30;
    owned.paid[POWDER] = 3000;
    state.market.stash[POWDER] = 12;
    state.market.paid[POWDER] = 1200;
    state.arrested = true;
    drive(session, 1);
    expect(carrying(state.market)).toBe(0);
    expect(state.market.paid[POWDER]).toBe(0);
    expect(owned.stash[POWDER]).toBe(30);
    expect(owned.paid[POWDER]).toBe(3000);
    expect(state.money).toBe(0);
    session.physics.dispose();
  });

  it('leaves the stash alone when the player dies', () => {
    const session = start(city());
    const { state } = session;
    state.market.stash[POWDER] = 9;
    state.player.health = 0;
    drive(session, 1);
    expect(state.market.stash[POWDER]).toBe(9);
    session.physics.dispose();
  });

  it('saves the safehouses, their stashes and their garages', () => {
    const seed = 'a house of my own';
    const state = createSimState(seedFromString(seed));
    buySafehouse(state, HOMES[1] as SafehousePlace);
    const owned = ownedAt(state, 1);
    if (owned === undefined) throw new Error('the safehouse was not bought');
    owned.stash[POWDER] = 17;
    const back = saveFromText(saveToText(createSave(seed, state)));
    expect(back.state.property.active).toBe(1);
    expect(back.state.property.owned).toHaveLength(1);
    expect(back.state.property.owned[0]?.stash[POWDER]).toBe(17);
    expect(back.state.property.owned[0]?.stash).toHaveLength(GOODS.length);
    expect(back.state.property.owned[0]?.garage).toHaveLength(2);
    expect(back.state.property.owned[0]?.garage[0]?.cls).toBe(owned.garage[0]?.cls);
  });

  it('replays a purchase and a garage exchange to identical state', () => {
    const run = (): SimState => {
      const state = createSimState(5);
      const ground = city();
      const physics = new SimPhysics(ground, state);
      physics.spawn(state, 0, 0, 0);
      const session: Session = { state, physics, ground };
      state.money = 100000;
      standAt(session, BROKER[0] as ShopPlace);
      press(session);
      use(session, 1);
      const place = goHome(session, 0);
      use(session, rowOf(state, place, 'Bring the'));
      drive(session, 60, { throttle: 1 });
      physics.dispose();
      return state;
    };
    const first = run();
    expect(first.property.owned).toHaveLength(1);
    expect(stableJson(run())).toBe(stableJson(first));
  });
});

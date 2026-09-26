import { beforeAll, describe, expect, it } from 'vitest';
import type { InputFrame } from '../../../src/sim/input.ts';
import { travelRefusal } from '../../../src/sim/transit/metro.ts';
import { MAX_HEALTH } from '../../../src/sim/player/on-foot.ts';
import { initPhysics, type Ground } from '../../../src/sim/physics/physics.ts';
import { shopOffers, shopPlaces, shopRefusal, DOOR_REACH, type ShopPlace } from '../../../src/sim/places/shop.ts';
import { CLOTHES_HEAT, RESPRAY_PAINTS } from '../../../src/sim/places/shop-stock.ts';
import { specOf } from '../../../src/sim/vehicles/vehicle.ts';
import { currentWeapon } from '../../../src/sim/weapons/weapon.ts';
import type { Shop, ShopKind } from '../../../src/world/city/shops.ts';
import { drive, finishBoarding, hills, start, type Session } from '../../support/sim-harness.ts';

/** One shop of each trade, a hundred metres apart along the hillside, clear of the spawn. */
const KINDS: readonly ShopKind[] = ['weapons', 'workshop', 'convenience', 'clothing', 'clinic', 'broker'];

const SHOPS: readonly Shop[] = KINDS.map((kind, i) => ({
  id: i,
  kind,
  building: i,
  district: 0,
  x: (i + 1) * 100,
  y: 0,
  // The front faces +y, so the room lies behind the door at -y.
  facing: Math.PI / 2,
  width: 10,
  depth: 12,
  licence: 3,
}));

const PLACES: readonly ShopPlace[] = shopPlaces(SHOPS, [{ name: 'Old Town' }]);

function served(): Ground {
  return { ...hills(), shops: PLACES };
}

/** The place of one trade, which the tests name rather than counting. */
function placeOf(kind: ShopKind): ShopPlace {
  return PLACES[KINDS.indexOf(kind)] as ShopPlace;
}

/** Put the player on foot at a shop door and let the tick see them there. */
function atDoor(session: Session, kind: ShopKind): ShopPlace {
  const place = placeOf(kind);
  session.state.player.driving = false;
  session.state.player.x = place.x;
  session.state.player.y = place.y;
  session.physics.stand(session.state);
  drive(session, 1);
  return place;
}

/**
 * One press of the interact key: a tick with it down, off an edge the last tick
 * left clear. A car door it opens is let shut again.
 */
function press(session: Session, input: Partial<InputFrame> = {}): void {
  drive(session, 1, { ...input, interact: false });
  drive(session, 1, { ...input, interact: true });
  finishBoarding(session);
}

/** Walk into a shop and answer with the place walked into. */
function enter(session: Session, kind: ShopKind): ShopPlace {
  const place = atDoor(session, kind);
  press(session);
  return place;
}

/** Buy row `row` of the counter, counted from 1. */
function buy(session: Session, row: number): void {
  drive(session, 1, { buy: row });
}

/**
 * The shops of spec section 16.1, played in the Rapier loop: the door, what
 * each trade sells, and the two things that keep a player out.
 */
describe('shops', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('opens the door on the interact key and puts the player inside the room', () => {
    const session = start(served());
    const place = enter(session, 'convenience');
    expect(session.state.shop?.shop).toBe(KINDS.indexOf('convenience'));
    const p = session.state.player;
    expect(p.x).toBeCloseTo(place.room.x, 3);
    expect(p.y).toBeCloseTo(place.room.y, 3);
    // Standing on the floor of the room, not in the air over it.
    expect(p.height).toBeCloseTo(hills().heightAt(p.x, p.y), 1);
    session.physics.dispose();
  });

  it('leaves on the key again, back on the pavement outside the door', () => {
    const session = start(served());
    const place = enter(session, 'convenience');
    press(session);
    expect(session.state.shop).toBeNull();
    expect(Math.hypot(session.state.player.x - place.x, session.state.player.y - place.y)).toBeLessThan(DOOR_REACH);
    session.physics.dispose();
  });

  it('leaves the shop a player walks out of', () => {
    const session = start(served());
    enter(session, 'convenience');
    // Walk out through the door, which is at +y of the room: the forward axis
    // walks toward -y, so this is the axis the other way.
    drive(session, 180, { throttle: -1 });
    expect(session.state.shop).toBeNull();
    session.physics.dispose();
  });

  it('does not open to a player in a vehicle', () => {
    // A session starts behind the wheel, so the car is driven to the door: the
    // record of a driving player says where the vehicle is.
    const session = start(served());
    const place = placeOf('convenience');
    session.physics.spawn(session.state, place.x, place.y, 0);
    drive(session, 1);
    expect(session.state.player.driving).toBe(true);
    expect(shopRefusal(session.state, place)).toBe('Not with a vehicle.');
    press(session);
    // The press took them out of the car (spec section 11.2); it did not open
    // the shop in front of them.
    expect(session.state.player.driving).toBe(false);
    expect(session.state.shop).toBeNull();
    session.physics.dispose();
  });

  it('shuts the counters the police are watching, and keeps the respray open', () => {
    const session = start(served());
    session.state.heat = 2;
    atDoor(session, 'convenience');
    press(session);
    expect(session.state.shop).toBeNull();
    expect(shopRefusal(session.state, placeOf('clinic'))).toBe('Not while the police want you.');
    // The two trades that sell a way out of being wanted still open.
    for (const kind of ['workshop', 'clothing'] as const) {
      expect(shopRefusal(session.state, placeOf(kind))).toBeNull();
    }
    enter(session, 'workshop');
    expect(session.state.shop).not.toBeNull();
    session.physics.dispose();
  });

  it('leaves the interact key to the vehicle when the shop refuses it', () => {
    const session = start(served());
    const place = atDoor(session, 'convenience');
    session.state.heat = 1;
    // The car is put down beside the player, so the press that the shop turns
    // down is the press that opens its door.
    session.physics.spawn(session.state, place.x, place.y, 0);
    press(session);
    expect(session.state.shop).toBeNull();
    expect(session.state.player.driving).toBe(true);
    session.physics.dispose();
  });

  it('sells a weapon off the counter and takes the money for it', () => {
    const session = start(served());
    session.state.money = 5000;
    const place = enter(session, 'weapons');
    const offer = shopOffers(session.state, PLACES)[0];
    expect(offer).toBeDefined();
    const before = session.state.money;
    buy(session, 1);
    expect(session.state.money).toBe(before - (offer?.price ?? 0));
    expect(currentWeapon(session.state.loadout).name).toBe(offer?.label);
    expect(session.state.shop?.said).toContain('loaded');
    // The counter of a licensed shop holds the back room's rows too, dearer
    // than anything it may sell over the counter.
    const rows = shopOffers(session.state, PLACES);
    expect(rows.some((row) => row.label.includes('back room'))).toBe(true);
    expect(place.licence).toBe(3);
    session.physics.dispose();
  });

  it('refuses a row the player cannot afford and says so', () => {
    const session = start(served());
    session.state.money = 0;
    enter(session, 'weapons');
    buy(session, 1);
    expect(session.state.money).toBe(0);
    expect(session.state.shop?.said).toBe('Not enough money.');
    expect(currentWeapon(session.state.loadout).id).toBe('fists');
    session.physics.dispose();
  });

  it('repairs a vehicle and resprays it, which sheds the heat the old paint carried', () => {
    const session = start(served());
    session.state.money = 5000;
    session.state.vehicle.damage.integrity = 0.4;
    session.state.vehicle.damage.stage = 'smoking';
    session.state.heat = 3;
    enter(session, 'workshop');
    const rows = shopOffers(session.state, PLACES);
    expect(rows[0]?.label).toBe('Repair');
    buy(session, 1);
    expect(session.state.vehicle.damage.integrity).toBe(1);
    expect(session.state.vehicle.damage.stage).toBe('intact');
    // The heat is the respray's to shed, not the repair's.
    expect(session.state.heat).toBe(3);
    const paint = session.state.vehicle.paint;
    const respray = shopOffers(session.state, PLACES).findIndex((row) => row.label.startsWith('Respray'));
    expect(respray).toBeGreaterThanOrEqual(0);
    buy(session, respray + 1);
    expect(session.state.vehicle.paint).not.toBe(paint);
    expect(RESPRAY_PAINTS.some((colour) => colour.colour === session.state.vehicle.paint)).toBe(true);
    expect(session.state.heat).toBe(0);
    session.physics.dispose();
  });

  it('starts a vehicle in the colour of its own row of the roster', () => {
    const session = start(served());
    expect(session.state.vehicle.paint).toBe(specOf(session.state.vehicle.cls).paint);
    session.physics.dispose();
  });

  it('sells food at a store and treatment at a clinic', () => {
    const session = start(served());
    session.state.money = 5000;
    session.state.player.health = 20;
    enter(session, 'convenience');
    buy(session, 1);
    expect(session.state.player.health).toBeGreaterThan(20);
    expect(session.state.player.health).toBeLessThan(MAX_HEALTH);
    press(session);
    enter(session, 'clinic');
    // The lighter care is listed first; full treatment is the row that heals all.
    const treatment = shopOffers(session.state, PLACES).findIndex((offer) => offer.label === 'Treatment');
    expect(treatment).toBeGreaterThan(0);
    buy(session, treatment + 1);
    expect(session.state.player.health).toBe(MAX_HEALTH);
    // There is nothing left to sell a player who needs none of it, but the
    // exchange of spec section 19 gives out the same things whatever their
    // health, and gives them out free.
    expect(shopOffers(session.state, PLACES).map((offer) => offer.price)).toEqual([0, 0, 0]);
    session.physics.dispose();
  });

  it('sells a change of clothes, which sheds a star of recognition', () => {
    const session = start(served());
    session.state.money = 5000;
    session.state.heat = 2;
    const worn = session.state.character.outfit;
    enter(session, 'clothing');
    buy(session, 1);
    expect(session.state.character.outfit).not.toBe(worn);
    expect(session.state.heat).toBe(2 - CLOTHES_HEAT);
    session.physics.dispose();
  });

  it('opens the broker, whose properties are the safehouses still to come', () => {
    const session = start(served());
    enter(session, 'broker');
    expect(session.state.shop).not.toBeNull();
    expect(shopOffers(session.state, PLACES)).toEqual([]);
    session.physics.dispose();
  });

  it('leaves the interact key to a vehicle within reach of the player', () => {
    const session = start(served());
    const place = atDoor(session, 'convenience');
    // The car left beside the player takes the press: its door is reached from
    // a metre and the shop from four, so the nearer thing wins.
    session.physics.spawn(session.state, place.x, place.y, 0);
    press(session);
    expect(session.state.player.driving).toBe(true);
    expect(session.state.shop).toBeNull();
    press(session);
    expect(session.state.player.driving).toBe(false);
    expect(session.state.shop).toBeNull();
    // A few steps from the car the door is the player's again. They walk in
    // through it, which is the way the room lies from the door.
    drive(session, 90, { throttle: 1 });
    press(session);
    expect(session.state.shop).not.toBeNull();
    session.physics.dispose();
  });

  it('leaves the key to a lock an attempt is already running on', () => {
    const session = start(served());
    const place = atDoor(session, 'convenience');
    // A locked vehicle beside the player: the press starts on its lock (spec
    // section 11.4), and the presses after it are the lock's until it opens.
    session.physics.spawn(session.state, place.x, place.y, 0, 'sports');
    press(session);
    expect(session.state.theft).not.toBeNull();
    press(session);
    expect(session.state.theft).not.toBeNull();
    expect(session.state.shop).toBeNull();
    session.physics.dispose();
  });

  it('is left behind by a death or an arrest', () => {
    const session = start(served());
    enter(session, 'convenience');
    session.state.arrested = true;
    drive(session, 2);
    expect(session.state.respawn?.cause).toBe('arrest');
    expect(session.state.shop).toBeNull();
    session.physics.dispose();
  });

  it('keeps the number keys to the counter while the player is inside a shop', () => {
    const session = start(served());
    enter(session, 'convenience');
    expect(travelRefusal(session.state)).toBe('Not from inside a shop.');
    session.physics.dispose();
  });

  it('names every shop for its trade and its district', () => {
    expect(placeOf('weapons').name).toBe('Gun shop · Old Town');
    expect(placeOf('broker').name).toBe('Property broker · Old Town');
  });
});

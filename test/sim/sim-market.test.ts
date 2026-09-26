import { beforeAll, describe, expect, it } from 'vitest';
import { goodIndex, GOODS } from '../../src/sim/crime/contraband.ts';
import { dealRefusal, pitchOf, type DealerPlace } from '../../src/sim/crime/dealer.ts';
import type { InputFrame } from '../../src/sim/input.ts';
import { carrying, STASH_UNITS, tradeRows } from '../../src/sim/crime/market.ts';
import { initPhysics, type Ground } from '../../src/sim/physics/physics.ts';
import { createSave, restoreSimState, saveFromText, saveToText, SaveError } from '../../src/sim/save.ts';
import { createSimState, type SimState } from '../../src/sim/simulation.ts';
import type { Culture, District } from '../../src/world/types.ts';
import { drive, hills, start, type Session } from '../support/sim-harness.ts';

/** The row the goods stand on, which is also the key that trades them. */
const POWDER = goodIndex('powder');

/**
 * Two districts a hundred and fifty metres apart, and as far apart in what they
 * pay: the barrio that the powder comes through, and the rich district that
 * buys it. The trade of spec section 16.2 is the difference between them.
 */
function district(id: number, wealth: number, culture: Culture): District {
  return { id, name: `D${id}`, zone: 'inner', x: id * 150, y: 0, density: 0.5, wealth, culture };
}

const DEALERS: readonly DealerPlace[] = [
  { district: district(0, 0.1, 'latin'), name: 'Dealer · D0', pitches: [{ x: 150, y: 0, heading: 0 }] },
  { district: district(1, 0.95, 'none'), name: 'Dealer · D1', pitches: [{ x: 300, y: 0, heading: 0 }] },
];

function streets(): Ground {
  return { ...hills(), dealers: DEALERS };
}

/** Put the player on foot at a dealer's corner and let the tick see them there. */
function atPitch(session: Session, at: number): void {
  const pitch = pitchOf(DEALERS[at] as DealerPlace, session.state.tick);
  session.state.player.driving = false;
  session.state.player.x = pitch.x;
  session.state.player.y = pitch.y;
  session.physics.stand(session.state);
  drive(session, 1);
}

/** One press of the interact key: a tick with it down, off an edge the last tick left clear. */
function press(session: Session, input: Partial<InputFrame> = {}): void {
  drive(session, 1, { ...input, interact: false });
  drive(session, 1, { ...input, interact: true });
}

/** Walk up to a dealer and open the deal. */
function deal(session: Session, at: number): void {
  atPitch(session, at);
  press(session);
}

/** Trade one row: the good counted from 1 to buy, the same number negative to sell. */
function trade(session: Session, row: number): void {
  drive(session, 1, { trade: row });
}

/**
 * The contraband market of spec section 16.2, played in the Rapier loop: the
 * corner, the deal, and the money made by carrying a good across the city.
 */
describe('the contraband market', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('opens a deal on the interact key at a corner, and shuts it on the key again', () => {
    const session = start(streets());
    deal(session, 0);
    expect(session.state.market.deal?.dealer).toBe(0);
    press(session);
    expect(session.state.market.deal).toBeNull();
    session.physics.dispose();
  });

  it('is over when the player walks off the corner', () => {
    const session = start(streets());
    deal(session, 0);
    drive(session, 240, { throttle: 1, sprint: true });
    expect(session.state.market.deal).toBeNull();
    session.physics.dispose();
  });

  it('will not deal with a driver, or with the police behind them', () => {
    const session = start(streets());
    const pitch = pitchOf(DEALERS[0] as DealerPlace, session.state.tick);
    session.physics.spawn(session.state, pitch.x, pitch.y, 0);
    drive(session, 1);
    expect(dealRefusal(session.state)).toBe('Not from a vehicle.');
    press(session);
    expect(session.state.market.deal).toBeNull();
    // Out of the car, but wanted: the corner is empty by the time they reach it.
    session.state.heat = 2;
    atPitch(session, 0);
    expect(dealRefusal(session.state)).toBe('Not while the police want you.');
    press(session);
    expect(session.state.market.deal).toBeNull();
    session.physics.dispose();
  });

  it('breaks off a deal the police arrive in the middle of', () => {
    const session = start(streets());
    deal(session, 0);
    expect(session.state.market.deal).not.toBeNull();
    session.state.heat = 1;
    drive(session, 1);
    expect(session.state.market.deal).toBeNull();
    session.physics.dispose();
  });

  it('buys low in one district and sells high in another', () => {
    const session = start(streets());
    session.state.money = 5000;
    deal(session, 0);
    const rows = tradeRows(session.state, DEALERS);
    expect(rows).toHaveLength(GOODS.length);
    const row = rows[POWDER];
    expect(row?.room).toBeGreaterThan(0);
    trade(session, POWDER + 1);
    const held = session.state.market.stash[POWDER] ?? 0;
    expect(held).toBe(row?.room);
    expect(session.state.money).toBe(5000 - held * (row?.buy ?? 0));
    expect(session.state.market.deal?.said).toContain('Bought');

    // Across town, where the money is. The same units are worth more there.
    deal(session, 1);
    const away = tradeRows(session.state, DEALERS)[POWDER];
    expect(away?.sell ?? 0).toBeGreaterThan(row?.buy ?? 0);
    trade(session, -(POWDER + 1));
    expect(session.state.market.stash[POWDER]).toBe(0);
    expect(session.state.money).toBeGreaterThan(5000);
    expect(session.state.market.deal?.said).toContain('Up $');
    session.physics.dispose();
  });

  it('takes no more than the money and the carrying allow, and says which stopped it', () => {
    const session = start(streets());
    session.state.money = 0;
    deal(session, 0);
    trade(session, POWDER + 1);
    expect(session.state.market.deal?.said).toBe('Not enough money.');
    expect(carrying(session.state.market)).toBe(0);
    // Money enough for more than a person can carry: the carrying is the limit.
    session.state.money = 10_000_000;
    trade(session, 1);
    expect(carrying(session.state.market)).toBe(STASH_UNITS);
    trade(session, 2);
    expect(session.state.market.deal?.said).toBe('You cannot carry any more.');
    session.physics.dispose();
  });

  it('says so rather than paying out for a good the player is not carrying', () => {
    const session = start(streets());
    const before = session.state.money;
    deal(session, 0);
    trade(session, -(POWDER + 1));
    expect(session.state.money).toBe(before);
    expect(session.state.market.deal?.said).toContain('no cocaine');
    session.physics.dispose();
  });

  it('carries the stash through a save and out the other side', () => {
    const session = start(streets());
    session.state.money = 5000;
    deal(session, 0);
    trade(session, POWDER + 1);
    const saved = saveFromText(saveToText(createSave('1', session.state)));
    const loaded = createSimState(session.state.seed);
    restoreSimState(loaded, saved);
    expect(loaded.market).toEqual(session.state.market);
    expect(loaded.money).toBe(session.state.money);
    session.physics.dispose();
  });

  it('refuses a save whose stash is not the one this game trades', () => {
    const state = createSimState(1);
    state.market.stash = [1, 2];
    expect(() => saveFromText(saveToText(createSave('1', state)))).toThrow(SaveError);
  });

  it('replays a recorded stream into the same money and the same stash', () => {
    const inputs: Partial<InputFrame>[] = [{}, { interact: true }, { trade: POWDER + 1 }, {}, { trade: -(POWDER + 1) }];
    const run = (): SimState => {
      const session = start(streets());
      session.state.money = 5000;
      atPitch(session, 0);
      for (const input of inputs) drive(session, 1, input);
      const state = session.state;
      session.physics.dispose();
      return state;
    };
    const once = run();
    const again = run();
    expect(again.money).toBe(once.money);
    expect(again.market).toEqual(once.market);
    // The stream did buy something, or the two runs agree about nothing.
    expect(once.money).not.toBe(5000);
  });
});

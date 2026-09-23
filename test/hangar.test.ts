import { describe, expect, it } from 'vitest';
import { airsideAt } from '../src/sim/airside.ts';
import { HANGAR_AIRCRAFT, HANGAR_PRICE, hangarPlaces } from '../src/sim/hangar.ts';
import { buySafehouse, homeOffers, ownedAt } from '../src/sim/safehouse.ts';
import { createSimState } from '../src/sim/simulation.ts';
import type { Airfield, District } from '../src/world/types.ts';

/**
 * The hangar of spec section 16.3: a property at the airport that keeps one
 * aircraft, sold and used as every other safehouse is.
 */

const AIRPORT: Airfield = {
  id: 0,
  kind: 'airport',
  x: 1000,
  y: -500,
  heading: 0.4,
  halfU: 500,
  halfV: 150,
  level: 10,
  gate: { x: 1000, y: -280 },
  road: 0,
  parts: [
    { kind: 'runway', u: 0, v: -100, halfU: 450, halfV: 20, height: 0 },
    { kind: 'taxiway', u: 0, v: -35, halfU: 410, halfV: 10, height: 0 },
    { kind: 'apron', u: 0, v: 25, halfU: 400, halfV: 50, height: 0 },
    { kind: 'hangar', u: 300, v: 27.5, halfU: 25, halfV: 32.5, height: 16 },
  ],
  stands: [],
};

const DISTRICTS: District[] = [
  { id: 0, name: 'Far', zone: 'inner', x: -2000, y: 0, density: 0.5, wealth: 0.5, culture: 'none' },
  { id: 1, name: 'Near', zone: 'outskirts', x: 900, y: -300, density: 0.2, wealth: 0.3, culture: 'none' },
];

describe('the hangar (spec section 16.3)', () => {
  it('stands its door on the landside, and brings its aircraft out on the apron', () => {
    const [hangar] = hangarPlaces([AIRPORT], DISTRICTS, 5);
    if (hangar === undefined) throw new Error('the airport has no hangar');
    expect(hangar.id).toBe(5);
    expect(hangar.name).toBe('Hangar · Near');
    expect(hangar.price).toBe(HANGAR_PRICE);
    expect(hangar.slots).toBe(1);
    expect(airsideAt([AIRPORT], hangar.x, hangar.y)).toBeUndefined();
    const yard = hangar.hangar;
    if (yard === undefined) throw new Error('the hangar has no apron');
    expect(airsideAt([AIRPORT], yard.x, yard.y)).toBe('airside');
  });

  it('has no hangar on a map whose airport has none', () => {
    expect(hangarPlaces([{ ...AIRPORT, parts: [] }], DISTRICTS, 0)).toEqual([]);
    expect(hangarPlaces([], DISTRICTS, 0)).toEqual([]);
  });

  it('comes with an aircraft, which the panel brings out in exchange for the car', () => {
    const [hangar] = hangarPlaces([AIRPORT], DISTRICTS, 0);
    if (hangar === undefined) throw new Error('the airport has no hangar');
    const state = createSimState(11);
    buySafehouse(state, hangar);
    const owned = ownedAt(state, hangar.id);
    expect(owned?.garage.map((v) => v.cls)).toEqual([HANGAR_AIRCRAFT]);
    const fetch = homeOffers(state, hangar).find((row) => row.fetch === true);
    if (fetch === undefined) throw new Error('the panel offers no aircraft');
    const car = state.vehicle.cls;
    fetch.take(state);
    expect(state.vehicle.cls).toBe(HANGAR_AIRCRAFT);
    expect(owned?.garage.map((v) => v.cls)).toEqual([car]);
  });
});

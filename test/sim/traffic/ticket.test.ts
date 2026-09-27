import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../../../src/sim/clock.ts';
import { EmergencyServices } from '../../../src/sim/city/emergency.ts';
import type { DistrictAt } from '../../../src/sim/police/police.ts';
import { createSimState, type SimState } from '../../../src/sim/simulation.ts';
import { FINE, ParkingWardens, TICKET_AFTER, TOW_AFTER, WARDEN_EVERY } from '../../../src/sim/traffic/ticket.ts';
import { stepTowing } from '../../../src/sim/traffic/tow.ts';
import type { PromotedVehicle } from '../../../src/sim/traffic/traffic.ts';
import { swapInto } from '../../../src/sim/vehicles/steal.ts';
import { createVehicleState, specOf } from '../../../src/sim/vehicles/vehicle.ts';
import { TIERS } from '../../../src/world/roads/tiers.ts';
import { gridTrafficRoads } from '../../support/traffic-grid.ts';

/** The grid of `traffic-grid.ts`: a street runs along y = 120 and crosses another at x = 120. */
const roads = gridTrafficRoads();
const downtown: DistrictAt = () => ({ zone: 'core', wealth: 1 });
const street = TIERS.street;
const PAVEMENT = 120 + street.width / 2 + street.verge + street.pavement / 2;

/** A session on foot with the player's own car left at `(x, y)`. */
function session(x: number, y: number): { state: SimState; car: PromotedVehicle } {
  const state = createSimState(3);
  state.player.driving = false;
  state.player.x = x + 20;
  state.player.y = y;
  const car: PromotedVehicle = { id: 7, paint: 0x2255aa, vehicle: createVehicleState(specOf('saloon'), x, y, 0, 0), left: true };
  state.traffic.promoted.push(car);
  // On the wardens' cadence, so a look falls on the first tick.
  state.tick = 0;
  return { state, car };
}

describe('parking tickets (spec section 20.2)', () => {
  const wardens = new ParkingWardens(roads);

  it('knows a pavement and a crossing from a lane, a bay and open ground', () => {
    expect(wardens.offenceAt(60, PAVEMENT)).toBe('pavement');
    expect(wardens.offenceAt(60, 240 - PAVEMENT)).toBe('pavement');
    expect(wardens.offenceAt(120, 120)).toBe('crossing');
    // In the lane, at the kerb of the parking strip, and out in the open.
    expect(wardens.offenceAt(60, 120 + 2)).toBeUndefined();
    expect(wardens.offenceAt(60, 120 + street.width / 2 - street.parking / 2)).toBeUndefined();
    expect(wardens.offenceAt(60, 60)).toBeUndefined();
  });

  it('tickets a car left on the pavement once it has stood there long enough, and fines the player', () => {
    const { state, car } = session(60, PAVEMENT);
    const money = state.money;
    for (; state.tick <= TICKET_AFTER + WARDEN_EVERY; state.tick++) wardens.step(state);
    expect(car.ticket).toBeGreaterThanOrEqual(TICKET_AFTER);
    expect(state.money).toBe(money - FINE);
    // One ticket, not one a look.
    for (let i = 0; i < 10 * WARDEN_EVERY; i++, state.tick++) wardens.step(state);
    expect(state.money).toBe(money - FINE);
  });

  it('never tickets a car left in the road or off it', () => {
    for (const [x, y] of [[60, 122], [60, 60]] as const) {
      const { state, car } = session(x, y);
      for (; state.tick <= 3 * TICKET_AFTER; state.tick++) wardens.step(state);
      expect(car.ticket, `${x}, ${y}`).toBeUndefined();
    }
  });

  it('forgets the time a car stood once it moves, and the ticket once the player takes it back', () => {
    const { state, car } = session(60, PAVEMENT);
    for (; state.tick < TICKET_AFTER - WARDEN_EVERY; state.tick++) wardens.step(state);
    car.vehicle.vx = 3;
    for (let i = 0; i < WARDEN_EVERY; i++, state.tick++) wardens.step(state);
    car.vehicle.vx = 0;
    for (let i = 0; i < 2 * WARDEN_EVERY; i++, state.tick++) wardens.step(state);
    expect(car.ticket).toBeUndefined();
    car.ticket = state.tick;
    car.offence = state.tick;
    swapInto(state, car.id);
    expect(car.ticket).toBeUndefined();
    expect(car.offence).toBeUndefined();
  });

  it('sends a truck for a ticketed car still standing there, which takes it away', () => {
    const { state } = session(60, PAVEMENT);
    const service = new EmergencyServices(roads, downtown);
    const until = TICKET_AFTER + TOW_AFTER + 120 * TICK_RATE;
    let hooked = false;
    for (; state.tick < until && !hooked; state.tick++) {
      stepTowing(state);
      service.step(state);
      hooked = state.emergency.units.some((unit) => unit.load?.id === 7);
    }
    expect(hooked, 'no truck took the car').toBe(true);
    expect(state.traffic.promoted).toEqual([]);
  });
});

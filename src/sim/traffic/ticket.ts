/**
 * Parking tickets (spec section 20.2): a car left where it should not be is
 * ticketed, and towed if it stays there.
 *
 * The car that matters is the player's own, left under `left` when they took
 * another (`steal.ts`). The wardens look at it every {@link WARDEN_EVERY}
 * ticks. A car that stands still on a pavement, on a crossing or inside a
 * junction has broken the rules; one standing in a lane, in a bay or off the
 * road has not. Once it has stood there {@link TICKET_AFTER} ticks it is
 * ticketed: the fine comes off the player's money and the ticket is on the
 * record, where the view draws the slip on the windscreen. A car still there
 * {@link TOW_AFTER} ticks after its ticket draws a tow truck
 * (`city/tow-truck.ts`), which takes it away like a wreck.
 *
 * A car that is moved, pushed or driven again starts over: the time it has
 * stood is forgotten, and a car the player gets back into loses its ticket
 * with its record.
 *
 * Everything is read off the record and the roads on a fixed cadence, so a
 * replay tickets the same car on the same tick.
 */
import { hypot } from '../../core/libm.ts';
import { pointInRing } from '../../core/ring.ts';
import { TICK_RATE, TICKS_PER_HOUR } from '../clock.ts';
import { callTow } from '../city/emergency.ts';
import type { SimState } from '../simulation.ts';
import { TIERS } from '../../world/roads/tiers.ts';
import type { PromotedVehicle, TrafficRoads } from './traffic.ts';

/** Ticks between two looks of the wardens. */
export const WARDEN_EVERY = 2 * TICK_RATE;

/** Ticks a car stands where it should not before it is ticketed: a quarter of a game hour. */
export const TICKET_AFTER = TICKS_PER_HOUR / 4;

/** Ticks a ticketed car may go on standing there before a truck is sent for it: a game hour. */
export const TOW_AFTER = TICKS_PER_HOUR;

/** What a ticket costs the player. */
export const FINE = 60;

/** Metres per second under which a car counts as standing. */
const STILL = 0.5;

/** Metres a car's middle may stand over the kerb and still count as in the road: a wheel up on it. */
const KERB_SLACK = 0.4;

/** Metres of a junction's mouth, out from the mouth along the road, that the crossing covers. */
const CROSSING_DEPTH = 4;

/** Where a car may not stand. */
export type Offence = 'pavement' | 'crossing';

export class ParkingWardens {
  private readonly roads: TrafficRoads;

  constructor(roads: TrafficRoads) {
    this.roads = roads;
  }

  /** One tick: look at the player's left car, on the wardens' cadence. */
  step(state: SimState): void {
    if (state.tick % WARDEN_EVERY !== 0) return;
    for (const record of state.traffic.promoted) {
      if (record.left === true) this.look(state, record);
    }
  }

  /** Where `(x, y)` is a place no car may stand, or undefined where it may. */
  offenceAt(x: number, y: number): Offence | undefined {
    if (this.onCrossing(x, y)) return 'crossing';
    return this.onPavement(x, y) ? 'pavement' : undefined;
  }

  /** True inside a junction, or on the crossing just outside one of its mouths. */
  private onCrossing(x: number, y: number): boolean {
    for (const junction of this.roads.junctions?.junctions ?? []) {
      if (Math.abs(junction.x - x) > 60 || Math.abs(junction.y - y) > 60) continue;
      if (pointInRing({ x, y }, junction.outline)) return true;
      for (const mouth of junction.mouths) {
        // The crossing runs across the road just outside the mouth, as wide as the carriageway.
        const along = (x - mouth.at.x) * mouth.dx + (y - mouth.at.y) * mouth.dy;
        const across = Math.abs(-(x - mouth.at.x) * mouth.dy + (y - mouth.at.y) * mouth.dx);
        if (along >= 0 && along <= CROSSING_DEPTH && across <= TIERS[mouth.tier].width / 2) return true;
      }
    }
    return false;
  }

  /** True on the pavement of a road and in the carriageway of none. */
  private onPavement(x: number, y: number): boolean {
    let pavement = false;
    for (const road of this.roads.roads) {
      const spec = TIERS[road.tier];
      const d = distanceTo(road.points, x, y, spec.width / 2 + spec.verge + spec.pavement);
      // In the carriageway of any road is in the road, whatever pavement of another it is near.
      if (d <= spec.width / 2 + KERB_SLACK) return false;
      if (spec.pavement > 0 && d <= spec.width / 2 + spec.verge + spec.pavement) pavement = true;
    }
    return pavement;
  }

  /** Ticket the car, or send for a truck, when it has stood where it should not long enough. */
  private look(state: SimState, record: PromotedVehicle): void {
    const v = record.vehicle;
    if (hypot(v.vx, v.vz) >= STILL || this.offenceAt(v.x, v.z) === undefined) {
      record.offence = undefined;
      return;
    }
    record.offence ??= state.tick;
    if (record.ticket === undefined) {
      if (state.tick - record.offence < TICKET_AFTER) return;
      record.ticket = state.tick;
      state.money = Math.max(0, state.money - FINE);
      return;
    }
    if (state.tick - record.ticket >= TOW_AFTER) callTow(state, record.id, v.x, v.z);
  }
}

/** Metres from a point to a polyline, or Infinity where it is no nearer than `within`. */
function distanceTo(points: readonly { x: number; y: number }[], x: number, y: number, within: number): number {
  let best = within;
  let found = false;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as { x: number; y: number };
    const b = points[i + 1] as { x: number; y: number };
    if (Math.min(a.x, b.x) - best > x || Math.max(a.x, b.x) + best < x) continue;
    if (Math.min(a.y, b.y) - best > y || Math.max(a.y, b.y) + best < y) continue;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const length2 = vx * vx + vy * vy;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / length2));
    const d = hypot(a.x + vx * t - x, a.y + vy * t - y);
    if (d > best) continue;
    best = d;
    found = true;
  }
  return found ? best : Infinity;
}

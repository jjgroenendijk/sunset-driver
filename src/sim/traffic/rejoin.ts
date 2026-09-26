/**
 * A bumped car drives on (spec sections 5.3, 13.1). A car of the traffic that
 * the player touched is promoted, and the physics owns it from then on. Before
 * this rule it stood where the blow left it for ever, with nobody in it, and
 * the traffic queued behind it.
 *
 * A promoted car that stands still, upright and still in one piece, clear of
 * the player and their car, goes back to its tour. Its tour is searched back
 * from now for the moment it passed nearest where the car stands. That moment
 * becomes its lag, and what is left between the two becomes a swerve, side and
 * yaw, which `swerve.ts` steers back into the lane. The car does not jump.
 *
 * Only a car with a tour rejoins: a parked car has none. The player's own car,
 * left where they took another (`left`), is theirs and stays where they left
 * it, as spec section 20.2 asks.
 */
import { atan2, cos, hypot, sin } from '../../core/libm.ts';
import { TICK_RATE } from '../clock.ts';
import type { SimState } from '../simulation.ts';
import { headingOf, specOf, type VehicleState } from '../vehicles/vehicle.ts';
import { holdOf, type Hold } from './hold.ts';
import { PARKED_ID } from './parked.ts';
import { footprintsTouch, type AmbientPose, type AmbientTraffic, type Footprint, type PromotedVehicle } from './traffic.ts';

/** Metres per second below which a promoted car counts as standing. */
const STILL = 0.2;

/** Seconds of its tour searched back for the moment it passed where the car stands, and the ticks between two looks. */
const SEARCH_BACK = 120;
const SEARCH_STEP = 10;

/** How far off its tour the car may stand and still rejoin it: metres along, metres across, radians turned. */
const ALONG_MOST = 1.5;
const SIDE_MOST = 4;
const TURN_MOST = 0.6;

/** Metres of room a car needs from the player and their car before it drives off: more than a door's reach. */
const ROOM = 2.5;

/** How upright a car has to stand: the up of its body against the world's. */
const UPRIGHT = 0.9;

export class Rejoin {
  private readonly traffic: AmbientTraffic;
  private readonly pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  private readonly car: Footprint = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };
  private readonly theirs: Footprint = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };

  constructor(traffic: AmbientTraffic) {
    this.traffic = traffic;
  }

  /**
   * Put back on its tour every promoted car within `reach` of `(x, y)` that
   * may drive on. Each car is looked at once a second, on a tick of its own.
   * Returns how many rejoined.
   */
  step(state: SimState, x: number, y: number, reach: number): number {
    const promoted = state.traffic.promoted;
    let joined = 0;
    // Backwards, so a removal does not skip the record after it.
    for (let i = promoted.length - 1; i >= 0; i--) {
      const record = promoted[i] as PromotedVehicle;
      if ((state.tick + record.id) % TICK_RATE !== 0 || !this.may(state, record, x, y, reach)) continue;
      const hold = this.holdFor(state, record);
      if (hold === undefined) continue;
      promoted.splice(i, 1);
      insertHold(state.traffic.held.list, hold);
      joined++;
    }
    return joined;
  }

  /** True when a record is a car of the traffic that stands whole, upright and clear, near enough to be looked at. */
  private may(state: SimState, record: PromotedVehicle, x: number, y: number, reach: number): boolean {
    const v = record.vehicle;
    if (record.id >= PARKED_ID || record.left === true || this.traffic.vehicles[record.id] === undefined) return false;
    // A car the player is working the lock of stays theirs to take.
    if (state.theft?.target === record.id) return false;
    if (v.damage.stage !== 'intact' && v.damage.stage !== 'dented') return false;
    if (Math.abs(v.speed) > STILL || hypot(v.vx, v.vz) > STILL) return false;
    if (Math.abs(v.x - x) > reach || Math.abs(v.z - y) > reach) return false;
    if (1 - 2 * (v.qx * v.qx + v.qz * v.qz) < UPRIGHT) return false;
    return !this.nearPlayer(state, v);
  }

  /** True when the car stands within {@link ROOM} of the player or the car they drive or left. */
  private nearPlayer(state: SimState, v: VehicleState): boolean {
    const spec = specOf(v.cls);
    setBox(this.car, v.x, v.z, headingOf(v), spec.halfLength, spec.halfWidth);
    const mine = state.vehicle;
    const theirs = specOf(mine.cls);
    setBox(this.theirs, mine.x, mine.z, headingOf(mine), theirs.halfLength, theirs.halfWidth);
    if (footprintsTouch(this.car, this.theirs, ROOM)) return true;
    if (state.player.driving) return false;
    setBox(this.theirs, state.player.x, state.player.y, 0, 0.4, 0.4);
    return footprintsTouch(this.car, this.theirs, ROOM);
  }

  /** The hold that stands the car on its tour where it stands now, or undefined where its tour did not pass there. */
  private holdFor(state: SimState, record: PromotedVehicle): Hold | undefined {
    const v = record.vehicle;
    const was = holdOf(state.traffic.held, record.id)?.lag ?? 0;
    // Coarse steps back through the tour, then tick by tick round the nearest.
    let best = this.search(record.id, state.tick, v, was, was + SEARCH_BACK * TICK_RATE, SEARCH_STEP);
    best = this.search(record.id, state.tick, v, Math.max(0, best - SEARCH_STEP), best + SEARCH_STEP, 1);
    const pose = this.traffic.poseAt(record.id, state.tick - best, this.pose);
    const c = cos(pose.heading);
    const s = sin(pose.heading);
    const dx = v.x - pose.x;
    const dy = v.z - pose.y;
    const along = dx * c + dy * s;
    const side = -dx * s + dy * c;
    const heading = headingOf(v);
    const yaw = atan2(sin(heading - pose.heading), cos(heading - pose.heading));
    if (Math.abs(along) > ALONG_MOST || Math.abs(side) > SIDE_MOST || Math.abs(yaw) > TURN_MOST) return undefined;
    return { id: record.id, lag: best, step: 0, waited: 0, swerve: { side, aim: side, drift: 0, yaw, blocked: 0 } };
  }

  /** The lag between `from` and `to`, `every` ticks apart, at which car `id`'s tour stands nearest the vehicle. */
  private search(id: number, tick: number, v: VehicleState, from: number, to: number, every: number): number {
    let best = from;
    let nearest = Infinity;
    for (let lag = from; lag <= to; lag += every) {
      const pose = this.traffic.poseAt(id, tick - lag, this.pose);
      const d = (pose.x - v.x) ** 2 + (pose.y - v.z) ** 2;
      if (d < nearest) {
        nearest = d;
        best = lag;
      }
    }
    return best;
  }
}

function setBox(out: Footprint, x: number, y: number, heading: number, halfLength: number, halfWidth: number): void {
  out.x = x;
  out.y = y;
  out.heading = heading;
  out.halfLength = halfLength;
  out.halfWidth = halfWidth;
}

/** Put a hold into a list ascending by id, in place of one under the same id. */
function insertHold(list: Hold[], hold: Hold): void {
  let i = list.length;
  while (i > 0 && (list[i - 1] as Hold).id > hold.id) i--;
  if (i > 0 && (list[i - 1] as Hold).id === hold.id) list[i - 1] = hold;
  else list.splice(i, 0, hold);
}

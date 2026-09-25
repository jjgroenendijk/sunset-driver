/**
 * Parked cars (spec sections 5.3, 13.1): which bay of `src/world/parking.ts`
 * holds a car at a tick, and what car.
 *
 * Time at a bay is cut into stays. Each bay has its own stay length, drawn
 * from what the bay is for, and its own offset, so the city's cars do not all
 * come and go on one tick. A stay rolls once, keyed by the bay and the tick it
 * starts on: the bay holds a car for the whole stay when the roll falls under
 * how full that kind of place is at the middle of the stay. The same roll
 * says which class and which paint. So a street of houses fills in the
 * evening and empties in the morning, and a car park at the works does the
 * opposite, with nothing stepped and nothing stored.
 *
 * A parked car the player touches is promoted like a car of the traffic: its
 * record goes into `TrafficState.promoted` under {@link PARKED_ID} plus its
 * bay, and from then on the physics owns it. The bay stays empty for as long
 * as that record exists.
 */
import { rngFor, Subsystem, type Rng } from '../core/rng.ts';
import { BAY_USES, type BayUse, type ParkingBays } from '../world/parking.ts';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './clock.ts';
import { PAINTS, promotedOf, type TrafficState } from './traffic.ts';
import { AIRCRAFT_CLASSES, type AircraftClass } from '../world/types.ts';
import { specOf, type VehicleClass } from './vehicle.ts';

/**
 * The id a parked car is promoted under is this plus its bay. It stands above
 * every id of the ambient traffic, so the two never share a record.
 */
export const PARKED_ID = 2 ** 24;

/** Metres each way of one bucket of the index that says which bays are near a place. */
const PARKED_CELL = 50;

/**
 * How full each kind of place is at each hour of the day, 0 to 1, from
 * midnight. Between two hours the share is read off the straight line.
 */
const FILL: Record<BayUse, readonly number[]> = {
  // Houses: full at night, half empty while their people are at work.
  home: [0.9, 0.9, 0.9, 0.9, 0.9, 0.88, 0.8, 0.62, 0.5, 0.45, 0.45, 0.45, 0.45, 0.45, 0.45, 0.48, 0.55, 0.68, 0.8, 0.85, 0.88, 0.9, 0.9, 0.9],
  // Shops and offices on a town street: busy all day and into the evening.
  town: [0.3, 0.25, 0.25, 0.25, 0.25, 0.25, 0.3, 0.45, 0.7, 0.85, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.88, 0.85, 0.75, 0.7, 0.62, 0.5, 0.4, 0.35],
  // A works: full on the shift, empty at night.
  work: [0.08, 0.08, 0.08, 0.08, 0.08, 0.12, 0.35, 0.7, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.75, 0.45, 0.25, 0.15, 0.12, 0.1, 0.08, 0.08],
  // A supermarket: a morning trade, a lunch and the rush after work.
  shops: [0.04, 0.03, 0.03, 0.03, 0.03, 0.03, 0.05, 0.15, 0.3, 0.45, 0.55, 0.6, 0.65, 0.55, 0.5, 0.55, 0.65, 0.8, 0.8, 0.6, 0.4, 0.2, 0.08, 0.05],
  // A beach or a trailhead: the middle of the day.
  leisure: [0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.7, 0.7, 0.7, 0.65, 0.55, 0.45, 0.3, 0.2, 0.12, 0.08, 0.05, 0.04],
  // An aircraft stand of spec section 8.4: its aircraft never leaves it.
  aircraft: Array.from({ length: 24 }, () => 1),
};

/** The shortest and longest stay at each kind of place, in game hours. */
const STAY: Record<BayUse, readonly [number, number]> = {
  home: [4, 10],
  town: [1, 4],
  work: [3, 9],
  shops: [0.5, 2],
  leisure: [1, 4],
  aircraft: [24, 48],
};

/** The classes each kind of place parks, and how often each comes up. */
export const PARKED_MIX: Record<BayUse, Partial<Record<VehicleClass, number>>> = {
  home: { compact: 4, saloon: 4, sports: 1, van: 1, offroad: 2 },
  town: { compact: 4, saloon: 4, sports: 2, van: 2, offroad: 1 },
  work: { van: 4, compact: 2, saloon: 2, offroad: 1 },
  shops: { compact: 4, saloon: 4, offroad: 2, van: 1, sports: 1 },
  leisure: { offroad: 4, compact: 2, saloon: 2, van: 1 },
  // A stand keeps the one aircraft its airfield put there (`ParkingBays.craft`).
  aircraft: {},
};

/** Every class that parks, in roster order, the aircraft of the stands after the cars. */
export const PARKED_CLASSES: readonly VehicleClass[] = ['compact', 'saloon', 'sports', 'van', 'offroad', ...AIRCRAFT_CLASSES];

/** The share of a kind of place that is full at a tick. */
export function fillAt(use: BayUse, tick: number): number {
  const inDay = ((tick % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  const hours = inDay / TICKS_PER_HOUR;
  const hour = Math.floor(hours);
  const table = FILL[use];
  const a = table[hour] as number;
  const b = table[(hour + 1) % 24] as number;
  return a + (b - a) * (hours - hour);
}

/** The car standing in a bay. */
export interface ParkedCar {
  cls: VehicleClass;
  paint: number;
  /** The tick its stay started on. */
  since: number;
}

export class ParkedCars {
  readonly bays: ParkingBays;
  private readonly seed: number;
  /** Ticks each bay's stays last, and how far its first stay is shifted. */
  private readonly stay: Int32Array;
  private readonly offset: Int32Array;
  private readonly cells: Int32Array[] = [];
  private readonly originX: number;
  private readonly originY: number;
  private readonly nx: number;
  private readonly ny: number;

  constructor(seed: number, bays: ParkingBays) {
    this.seed = seed;
    this.bays = bays;
    this.stay = new Int32Array(bays.count);
    this.offset = new Int32Array(bays.count);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < bays.count; i++) {
      const rng = rngFor(seed, 0, Subsystem.Parking, i);
      const [shortest, longest] = STAY[BAY_USES[bays.use[i] as number] as BayUse];
      const stay = Math.round(rng.range(shortest, longest) * TICKS_PER_HOUR);
      this.stay[i] = stay;
      this.offset[i] = rng.int(0, stay - 1);
      minX = Math.min(minX, bays.x[i] as number);
      minY = Math.min(minY, bays.y[i] as number);
      maxX = Math.max(maxX, bays.x[i] as number);
      maxY = Math.max(maxY, bays.y[i] as number);
    }
    if (bays.count === 0) minX = minY = maxX = maxY = 0;
    this.originX = minX;
    this.originY = minY;
    this.nx = Math.floor((maxX - minX) / PARKED_CELL) + 1;
    this.ny = Math.floor((maxY - minY) / PARKED_CELL) + 1;
    const lists: number[][] = [];
    for (let i = 0; i < this.nx * this.ny; i++) lists.push([]);
    for (let i = 0; i < bays.count; i++) {
      const cell = this.row(bays.y[i] as number) * this.nx + this.column(bays.x[i] as number);
      (lists[cell] as number[]).push(i);
    }
    this.cells = lists.map((list) => Int32Array.from(list));
  }

  /**
   * The car in a bay at a tick, written into `out`, or false where the bay is
   * empty. A bay whose car has been promoted is empty.
   */
  carAt(bay: number, tick: number, traffic: TrafficState, out: ParkedCar): boolean {
    const stay = this.stay[bay] as number;
    const index = Math.floor((tick + (this.offset[bay] as number)) / stay);
    const since = index * stay - (this.offset[bay] as number);
    const use = BAY_USES[this.bays.use[bay] as number] as BayUse;
    const rng = rngFor(this.seed, since, Subsystem.Parking, bay);
    if (rng.float() >= fillAt(use, since + stay / 2)) return false;
    if (traffic.promoted.length > 0 && promotedOf(traffic, PARKED_ID + bay) !== undefined) return false;
    const craft = this.bays.craft?.[bay] ?? -1;
    if (craft >= 0) {
      // A stand's aircraft is the one it was laid out for, in its own livery.
      out.cls = AIRCRAFT_CLASSES[craft] as AircraftClass;
      out.paint = specOf(out.cls).paint;
      out.since = since;
      return true;
    }
    out.cls = pickClass(PARKED_MIX[use], rng);
    out.paint = PAINTS[rng.int(0, PAINTS.length - 1)] as number;
    out.since = since;
    return true;
  }

  /** The tick the stay a bay is in at a tick ends on, which is the first tick the bay can change. */
  stayEnd(bay: number, tick: number): number {
    const stay = this.stay[bay] as number;
    const offset = this.offset[bay] as number;
    return (Math.floor((tick + offset) / stay) + 1) * stay - offset;
  }

  /** The bays inside a box, ascending. */
  near(minX: number, minY: number, maxX: number, maxY: number, out: number[]): number[] {
    out.length = 0;
    const bays = this.bays;
    for (let iy = this.row(minY); iy <= this.row(maxY); iy++) {
      for (let ix = this.column(minX); ix <= this.column(maxX); ix++) {
        for (const bay of this.cells[iy * this.nx + ix] as Int32Array) {
          const x = bays.x[bay] as number;
          const y = bays.y[bay] as number;
          if (x >= minX && x <= maxX && y >= minY && y <= maxY) out.push(bay);
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  private column(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.originX) / PARKED_CELL)));
  }

  private row(y: number): number {
    return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.originY) / PARKED_CELL)));
  }
}

function pickClass(mix: Partial<Record<VehicleClass, number>>, rng: Rng): VehicleClass {
  let total = 0;
  for (const cls of PARKED_CLASSES) total += mix[cls] ?? 0;
  let pick = rng.float() * total;
  for (const cls of PARKED_CLASSES) {
    pick -= mix[cls] ?? 0;
    if (pick < 0) return cls;
  }
  return 'saloon';
}

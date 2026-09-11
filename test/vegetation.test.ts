import { describe, expect, it } from 'vitest';
import { regionOf, type Point } from '../src/core/geom.ts';
import type { Building, BuildingMap } from '../src/world/buildings.ts';
import type { Parcel, ParcelMap, ParcelOwner } from '../src/world/parcels.ts';
import type { Zone } from '../src/world/types.ts';
import {
  MAX_PLANT_CHANCE,
  MAX_PLANT_RADIUS,
  mixFor,
  PLANT_CELL,
  PLANT_JITTER,
  PLANT_RADIUS,
  STREET_REACH,
  Vegetation,
  type Plant,
} from '../src/world/vegetation.ts';

const SEED = 0x5eed11;
/** The ground the tests scatter over: one square parcel, well clear of the origin. */
const SIDE = 240;

const ZONES: readonly Zone[] = ['core', 'inner', 'industrial', 'suburban', 'outskirts', 'wilderness'];
const OWNERS: readonly ParcelOwner[] = [
  'building',
  'park',
  'car-park',
  'plaza',
  'under-structure',
  'beach',
  'water',
  'ground',
];

/** A square of ground, wound anticlockwise as every region is. */
function square(x: number, y: number, side: number): Point[] {
  return [
    { x, y },
    { x: x + side, y },
    { x: x + side, y: y + side },
    { x, y: y + side },
  ];
}

function parcelOf(owner: ParcelOwner, zone: Zone, ring: Point[] = square(0, 0, SIDE)): ParcelMap {
  const parcel: Parcel = {
    id: 0,
    region: regionOf(ring),
    area: SIDE * SIDE,
    owner,
    district: 0,
    zone,
    roads: [0],
  };
  return { parcels: [parcel], area: parcel.area, land: parcel.area };
}

/** One building on a lot, which is ground no plant may stand on. */
function lotOf(ring: Point[]): BuildingMap {
  const building: Building = {
    id: 0,
    parcel: 0,
    kind: 'house',
    seed: 1,
    lot: ring,
    area: 0,
    width: 0,
    depth: 0,
    front: ring[0] as Point,
    facing: 0,
    road: 0,
    district: 0,
    zone: 'suburban',
  };
  return { buildings: [building], area: 0 };
}

const NOTHING: BuildingMap = { buildings: [], area: 0 };

/** The whole square of ground, as a window on it. */
const WHOLE = { minX: 0, minY: 0, maxX: SIDE, maxY: SIDE };

/** What a chunk hands the scatter: the parcel ground inside the window. */
function groundOf(parcels: ParcelMap): { parcel: number; region: Parcel['region']; owner: ParcelOwner; zone: Zone }[] {
  return parcels.parcels.map((parcel) => ({
    parcel: parcel.id,
    region: parcel.region,
    owner: parcel.owner,
    zone: parcel.zone,
  }));
}

function plantsOn(parcels: ParcelMap, buildings: BuildingMap = NOTHING, window = WHOLE): Plant[] {
  return new Vegetation(SEED, parcels, buildings).plantsIn(window, groundOf(parcels));
}

/** Metres from a point to the nearest edge of a ring, inside it or outside it. */
function edgeDistance(at: Point, ring: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const span = vx * vx + vy * vy;
    let t = span > 0 ? ((at.x - a.x) * vx + (at.y - a.y) * vy) / span : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(at.x - (a.x + vx * t), at.y - (a.y + vy * t)));
  }
  return best;
}

/** Metres from a point to a ring, which is zero where the point stands inside it. */
function distanceToRing(at: Point, ring: readonly Point[]): number {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    if ((b.x - a.x) * (at.y - a.y) - (b.y - a.y) * (at.x - a.x) < 0) return edgeDistance(at, ring);
  }
  return 0;
}

describe('vegetation', () => {
  it('plants nothing on ground no parcel owns', () => {
    // Every plant stands on a parcel, and a parcel is the land the road
    // footprint left (spec section 6.4). Ground the roads own carries none.
    expect(new Vegetation(SEED, { parcels: [], area: 0, land: 0 }, NOTHING).plantsIn(WHOLE, [])).toEqual([]);
  });

  it('keeps the whole canopy of every plant inside its parcel', () => {
    // Spec section 10.4: placement is by parcel polygon, so nothing reaches
    // over the road the parcel was cut from.
    const parcels = parcelOf('park', 'suburban');
    const plants = plantsOn(parcels);
    expect(plants.length).toBeGreaterThan(100);
    for (const plant of plants) {
      expect(plant.radius).toBe(PLANT_RADIUS[plant.species]);
      expect(plant.radius).toBeLessThanOrEqual(MAX_PLANT_RADIUS);
      const room = edgeDistance(plant.at, square(0, 0, SIDE));
      expect(room, `${plant.species} at ${plant.at.x}, ${plant.at.y}`).toBeGreaterThanOrEqual(plant.radius);
    }
  });

  it('keeps every canopy off the lots the parcel already carries', () => {
    const parcels = parcelOf('building', 'suburban');
    const lot = square(40, 40, 120);
    const plants = plantsOn(parcels, lotOf(lot));
    expect(plants.length).toBeGreaterThan(0);
    for (const plant of plants) {
      expect(distanceToRing(plant.at, lot), `${plant.species} at ${plant.at.x}, ${plant.at.y}`).toBeGreaterThanOrEqual(
        plant.radius,
      );
    }
  });

  it('never lets two canopies overlap', () => {
    // By construction, not by checking: a cell is PLANT_CELL across, a plant
    // stands within PLANT_JITTER of its middle, and no canopy is wider than
    // half of what is left.
    expect(2 * MAX_PLANT_RADIUS).toBeLessThanOrEqual(PLANT_CELL - 2 * PLANT_JITTER);
    const plants = plantsOn(parcelOf('ground', 'wilderness'));
    expect(plants.length).toBeGreaterThan(100);
    for (let i = 0; i < plants.length; i++) {
      for (let j = i + 1; j < plants.length; j++) {
        const a = plants[i] as Plant;
        const b = plants[j] as Plant;
        const apart = Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y);
        if (apart > 2 * MAX_PLANT_RADIUS) continue;
        expect(apart, `plants ${i} and ${j}`).toBeGreaterThanOrEqual(a.radius + b.radius);
      }
    }
  });

  it('plants a built-up block only along the road that runs past it', () => {
    const parcels = parcelOf('building', 'core');
    for (const plant of plantsOn(parcels)) {
      expect(edgeDistance(plant.at, square(0, 0, SIDE))).toBeLessThanOrEqual(STREET_REACH);
    }
  });

  it('gives the same plants whatever window is asked for', () => {
    // A chunk is a window on the map, so what grows in it may not depend on
    // where the windows were drawn (spec section 9.1).
    const parcels = parcelOf('park', 'outskirts');
    const whole = plantsOn(parcels);
    const half = SIDE / 2;
    const quarters: Plant[] = [];
    for (const [x, y] of [
      [0, 0],
      [half, 0],
      [0, half],
      [half, half],
    ]) {
      const window = { minX: x as number, minY: y as number, maxX: (x as number) + half, maxY: (y as number) + half };
      quarters.push(...plantsOn(parcels, NOTHING, window));
    }
    const key = (plant: Plant): string => `${plant.at.x} ${plant.at.y} ${plant.species} ${plant.seed}`;
    expect(quarters.map(key).sort()).toEqual(whole.map(key).sort());
  });

  it('plants only what the mix of the parcel allows, and no cell twice', () => {
    for (const zone of ZONES) {
      for (const owner of OWNERS) {
        const mix = mixFor(owner, zone);
        const plants = plantsOn(parcelOf(owner, zone));
        if (mix === undefined) {
          expect(plants, `${zone} ${owner}`).toEqual([]);
          continue;
        }
        expect(mix.chance, `${zone} ${owner}`).toBeLessThanOrEqual(MAX_PLANT_CHANCE);
        const allowed = new Set(mix.species.map((entry) => entry.kind));
        for (const plant of plants) expect(allowed.has(plant.species), `${zone} ${owner}: ${plant.species}`).toBe(true);
        // One cell of the grid carries at most one plant, so a square of ground
        // never holds more plants than it holds cells.
        expect(plants.length, `${zone} ${owner}`).toBeLessThanOrEqual((SIDE / PLANT_CELL + 1) ** 2);
      }
    }
  });
});

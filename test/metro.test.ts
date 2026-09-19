import { describe, expect, it } from 'vitest';
import { MetroPlan, metroDistricts, metroEntrances, type MetroStation } from '../src/world/metro.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { District, RoadCurve, RoadTier, WorldDescription, Zone } from '../src/world/types.ts';

/** A district at a place, which is all the station rule reads. */
function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

/** Districts about a core at the origin: two downtown, one inner and two suburbs. */
const DISTRICTS: District[] = [
  district(0, 'core', 0, 0),
  district(1, 'core', 200, 0),
  district(2, 'inner', 0, 600),
  district(3, 'suburban', 1200, 0),
  district(4, 'suburban', -2400, 0),
  district(5, 'industrial', 0, -1500),
];

function world(districts: District[] = DISTRICTS, roads: RoadCurve[] = []): WorldDescription {
  return { districts, roads, core: { x: 0, y: 0 } } as unknown as WorldDescription;
}

/** A straight road of a tier along the x axis, on the ground the whole way. */
function road(tier: RoadTier, y = 0): RoadCurve {
  const points = [
    { x: -200, y },
    { x: 200, y },
  ];
  return { id: 0, tier, points, nodes: [0, 1], bridges: [], tunnels: [], joins: [] } as unknown as RoadCurve;
}

/** A station parcel of a district, at a place. */
function station(district: number, x: number, y: number): MetroStation {
  return { parcel: 0, district, x, y };
}

/** Spec section 13.3: which districts the line calls at, and which parcel it stands on. */
describe('metro stations', () => {
  it('calls at the core and inner districts and one suburb at the edge', () => {
    // District 4 is the farthest suburb from the core, so it is the one at the
    // edge; district 3 and the industrial district are not served.
    expect(metroDistricts(world())).toEqual([0, 1, 2, 4]);
  });

  it('is served by the core and inner districts alone where a world has no suburb', () => {
    expect(metroDistricts(world(DISTRICTS.filter((d) => d.zone !== 'suburban')))).toEqual([0, 1, 2]);
  });

  it('stands on the plaza nearest the district site where the district has one', () => {
    const plan = new MetroPlan(world());
    const core = DISTRICTS[0] as District;
    plan.offer(core, 10, 'building', { x: 5, y: 0 });
    plan.offer(core, 11, 'plaza', { x: 40, y: 0 });
    plan.offer(core, 12, 'plaza', { x: 20, y: 0 });
    expect(plan.stations()).toEqual([{ parcel: 12, district: 0, x: 20, y: 0 }]);
  });

  it('takes the second nearest building where there is no plaza, since the police have the first', () => {
    const plan = new MetroPlan(world());
    const core = DISTRICTS[0] as District;
    plan.offer(core, 10, 'building', { x: 30, y: 0 });
    plan.offer(core, 11, 'building', { x: 8, y: 0 });
    plan.offer(core, 12, 'building', { x: 50, y: 0 });
    expect(plan.stations()).toEqual([{ parcel: 10, district: 0, x: 30, y: 0 }]);
  });

  it('leaves a district with one candidate parcel, or none, without a station', () => {
    const plan = new MetroPlan(world());
    plan.offer(DISTRICTS[0] as District, 10, 'building', { x: 8, y: 0 });
    plan.offer(DISTRICTS[1] as District, 11, 'park', { x: 200, y: 0 });
    plan.offer(DISTRICTS[1] as District, 12, 'car-park', { x: 210, y: 0 });
    expect(plan.stations()).toEqual([]);
  });

  it('ignores a parcel of a district the line does not call at', () => {
    const plan = new MetroPlan(world());
    const suburb = DISTRICTS[3] as District;
    plan.offer(suburb, 10, 'plaza', { x: 1200, y: 0 });
    expect(plan.stations()).toEqual([]);
  });

  it('lists the stations by district, whatever order the parcels came in', () => {
    const plan = new MetroPlan(world());
    plan.offer(DISTRICTS[2] as District, 20, 'plaza', { x: 0, y: 600 });
    plan.offer(DISTRICTS[4] as District, 21, 'plaza', { x: -2400, y: 0 });
    plan.offer(DISTRICTS[0] as District, 22, 'plaza', { x: 0, y: 0 });
    expect(plan.stations().map((station) => station.district)).toEqual([0, 2, 4]);
  });
});

/** Spec section 13.3: where the stairs down to a station stand. */
describe('metro entrances', () => {
  it('stands on the middle of the pavement, on the side of the road the parcel is on', () => {
    const spec = TIERS.street;
    const away = spec.width / 2 + spec.verge + spec.pavement / 2;
    const [north] = metroEntrances(world(DISTRICTS, [road('street')]), [station(0, 40, 30)]);
    const [south] = metroEntrances(world(DISTRICTS, [road('street')]), [station(0, 40, -30)]);
    expect(north).toMatchObject({ station: 0, district: 0, x: 40, tier: 'street' });
    expect(north?.y).toBeCloseTo(away);
    expect(south?.y).toBeCloseTo(-away);
  });

  it('passes over an alley behind the parcel for the street with a pavement', () => {
    const spec = TIERS.street;
    const away = spec.width / 2 + spec.verge + spec.pavement / 2;
    const roads = [road('alley', 60), road('street', 0)];
    // The alley runs 60 m from the station and the street 20 m, but even an
    // alley under the parcel would be passed over: it claims no pavement.
    const [at] = metroEntrances(world(DISTRICTS, roads), [station(0, 0, 55)]);
    expect(at).toMatchObject({ tier: 'street' });
    expect(at?.y).toBeCloseTo(away);
  });

  it('faces the road it is entered from', () => {
    const [north] = metroEntrances(world(DISTRICTS, [road('street')]), [station(0, 0, 30)]);
    const [south] = metroEntrances(world(DISTRICTS, [road('street')]), [station(0, 0, -30)]);
    // The road runs along the x axis, so the way back to it is straight down
    // the y axis: -pi/2 from the north pavement and +pi/2 from the south one.
    expect(north?.heading).toBeCloseTo(-Math.PI / 2);
    expect(south?.heading).toBeCloseTo(Math.PI / 2);
  });

  it('is nearer its own stairs than the reach of the panel, which the centreline is not', () => {
    const [at] = metroEntrances(world(DISTRICTS, [road('arterial')]), [station(0, 0, 40)]);
    // The arterial's centreline is 10 m from the pavement the stairs stand on,
    // which is why the place the simulation uses is this one and not that.
    expect(at?.y).toBeGreaterThan(7);
  });

  it('leaves out a station in a world with no road, and keeps the rest in station order', () => {
    expect(metroEntrances(world(), [station(0, 0, 0)])).toEqual([]);
    const two = metroEntrances(world(DISTRICTS, [road('street')]), [station(0, -50, 30), station(2, 60, 30)]);
    expect(two.map((at) => [at.station, at.district])).toEqual([
      [0, 0],
      [1, 2],
    ]);
  });
});

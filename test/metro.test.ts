import { describe, expect, it } from 'vitest';
import { MetroPlan, metroDistricts } from '../src/world/metro.ts';
import type { District, WorldDescription, Zone } from '../src/world/types.ts';

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

function world(districts: District[] = DISTRICTS): WorldDescription {
  return { districts, core: { x: 0, y: 0 } } as unknown as WorldDescription;
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

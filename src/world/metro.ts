/**
 * The metro stations (spec section 13.3).
 *
 * The line itself runs underground and claims no ground, so the only thing the
 * world has to place is where a player goes down to it. A station is a parcel
 * like the police station of spec section 11.7: it takes no owner of its own,
 * and its entrance is the road that runs along it, which every parcel has.
 *
 * Which districts are served is the tram's rule (spec section 13.2): every core
 * and inner district, and one more at the edge of the suburbs, which is the
 * suburban district whose site stands farthest from the core. So the line joins
 * downtown to the far edge of the city, which is the trip a player takes it for.
 *
 * Which parcel of a district it stands on is a plaza where the district has
 * one, because an entrance on a public square is what a metro entrance is, and
 * otherwise a building parcel. The police station holds the building parcel
 * nearest the district's site, so a district with no plaza takes the next one:
 * the two are never the same place.
 *
 * The rule is offered one parcel at a time, because `buildParcels` is the one
 * pass that knows both the owner and the centre of a parcel. Pure: the same
 * parcels, offered in the same order, give the same stations.
 */
import type { Point } from '../core/geom.ts';
import { hypot } from '../core/libm.ts';
import { sortedEntries } from '../core/sort.ts';
import type { ParcelOwner } from './parcels.ts';
import type { District, WorldDescription } from './types.ts';

/** A parcel that carries a metro station entrance (spec section 13.3). */
export interface MetroStation {
  /** Id of the parcel it stands on. The parcel keeps its own owner. */
  parcel: number;
  district: number;
  /** The centre of the parcel's ground, which the street entrance is found from. */
  x: number;
  y: number;
}

/** A parcel a district might put its station on, and how far it stands from the district's site. */
interface Candidate {
  parcel: number;
  x: number;
  y: number;
  away: number;
}

/** The two nearest building parcels of a district, and the nearest plaza. */
interface DistrictPlan {
  district: number;
  plaza: Candidate | undefined;
  /** The nearest building parcel and the one after it, ascending by distance. */
  buildings: Candidate[];
}

/**
 * Picks the station parcels as the parcels are built. Every parcel of a served
 * district is offered; the plan keeps only what it may still use.
 */
export class MetroPlan {
  private readonly served: Set<number>;
  private readonly plans = new Map<number, DistrictPlan>();

  constructor(world: WorldDescription) {
    this.served = new Set(metroDistricts(world));
  }

  /**
   * Offer a parcel as its district's station. A parcel of a district the line
   * does not call at, or of an owner that is neither a plaza nor a building
   * group, is nothing to the metro.
   */
  offer(district: District, parcel: number, owner: ParcelOwner, at: Point): void {
    if (!this.served.has(district.id)) return;
    if (owner !== 'plaza' && owner !== 'building') return;
    const plan = this.plans.get(district.id) ?? { district: district.id, plaza: undefined, buildings: [] };
    this.plans.set(district.id, plan);
    const candidate = { parcel, x: at.x, y: at.y, away: hypot(at.x - district.x, at.y - district.y) };
    if (owner === 'plaza') {
      if (plan.plaza === undefined || candidate.away < plan.plaza.away) plan.plaza = candidate;
      return;
    }
    // Only the two nearest buildings can ever be the answer: the nearest is the
    // police station, so the station takes the one behind it.
    plan.buildings.push(candidate);
    plan.buildings.sort((a, b) => a.away - b.away || a.parcel - b.parcel);
    plan.buildings.length = Math.min(plan.buildings.length, 2);
  }

  /**
   * The stations, by district id. A district whose only candidate is the parcel
   * its police station holds is left without one: the metro has other stops,
   * and two places on one parcel is not a place.
   */
  stations(): MetroStation[] {
    const out: MetroStation[] = [];
    for (const [district, plan] of sortedEntries(this.plans)) {
      const pick = plan.plaza ?? plan.buildings[1];
      if (pick === undefined) continue;
      out.push({ parcel: pick.parcel, district, x: pick.x, y: pick.y });
    }
    return out;
  }
}

/**
 * The districts the line calls at, ascending: the core and inner ones, and the
 * suburban district farthest from the core. A world with no suburban district
 * is served by its core and inner districts alone.
 */
export function metroDistricts(world: WorldDescription): number[] {
  const out: number[] = [];
  let edge: District | undefined;
  let edgeAway = -1;
  for (const district of world.districts) {
    if (district.zone === 'core' || district.zone === 'inner') {
      out.push(district.id);
      continue;
    }
    if (district.zone !== 'suburban') continue;
    const away = hypot(district.x - world.core.x, district.y - world.core.y);
    if (away <= edgeAway) continue;
    edgeAway = away;
    edge = district;
  }
  if (edge !== undefined) out.push(edge.id);
  return out.sort((a, b) => a - b);
}

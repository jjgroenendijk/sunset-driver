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
 *
 * {@link metroEntrances} is the other half: the parcel says which district is
 * served, and the entrance says where on the street the stairs stand. Both the
 * simulation and the renderer read that one answer, so the stairs a player
 * walks to are the station the panel opens for.
 */
import type { Point } from '../core/geom.ts';
import { atan2, cos, hypot, sin } from '../core/libm.ts';
import { sortedEntries } from '../core/sort.ts';
import type { ParcelOwner } from './parcels.ts';
import { nearestRoadSpot } from './surface.ts';
import { TIERS } from './tiers.ts';
import type { District, RoadTier, WorldDescription } from './types.ts';

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

/**
 * Where a station's stairs stand, and which way they open (spec section 13.3).
 *
 * A station's parcel is entered from the road that runs along it, so the
 * entrance is found from the parcel's centre and then stood out on the
 * pavement, clear of the carriageway. The renderer builds the stairs here and
 * the simulation puts the player here, because a player who walks up to the
 * stairs has to be the player the metro answers: the reach of `src/sim/metro.ts`
 * is measured from this place, and on an arterial the centreline is 10 m away
 * from it.
 */
export interface MetroEntrance {
  /** The station it belongs to, as {@link MetroPlan.stations} numbers them. */
  station: number;
  district: number;
  /** Where the stairs stand, on the pavement beside the road. */
  x: number;
  y: number;
  /** Radians, from the stairs toward the road: the way a player coming up them faces. */
  heading: number;
  /** The tier of that road, which the ground under the stairs is asked of. */
  tier: RoadTier;
}

/**
 * The entrances of a world's stations, in station order.
 *
 * The road they are found from is one with a pavement, which is an arterial or
 * a street: a tier without one claims no ground beside its carriageway, so an
 * alley behind the parcel has nowhere to put a stair. A station with no such
 * road anywhere is left out, which a generated world has none of, since the
 * line calls only at districts a street runs through.
 *
 * Pure, and the same answer on the main thread and in a chunk worker, so the
 * stairs are drawn where the fast travel is taken.
 */
export function metroEntrances(world: WorldDescription, stations: readonly MetroStation[]): MetroEntrance[] {
  const out: MetroEntrance[] = [];
  for (const [station, at] of stations.entries()) {
    const spot = nearestRoadSpot(world, at.x, at.y, paved);
    if (spot === undefined) continue;
    const spec = TIERS[spot.tier];
    // The middle of the pavement, which is where a metro entrance belongs.
    const away = spec.width / 2 + spec.verge + spec.pavement / 2;
    // Across the road, toward the parcel the station holds: the stairs go on
    // the pavement the parcel is entered from, not the one opposite it.
    const acrossX = -sin(spot.heading);
    const acrossY = cos(spot.heading);
    const side = acrossX * (at.x - spot.x) + acrossY * (at.y - spot.y) < 0 ? -1 : 1;
    out.push({
      station,
      district: at.district,
      x: spot.x + acrossX * side * away,
      y: spot.y + acrossY * side * away,
      heading: atan2(-acrossY * side, -acrossX * side),
      tier: spot.tier,
    });
  }
  return out;
}

/** True of a tier that carries a pavement to stand a stair on. */
function paved(tier: RoadTier): boolean {
  return TIERS[tier].pavement > 0;
}

/**
 * Every place a system of `src/sim` owns, built once for a session.
 *
 * The world description says where the streets and the parcels are; each
 * system says where its own places stand on them. This is the one call that
 * asks them all, in the order they depend on each other, and fills the
 * {@link Ground} the physics reads. It is here rather than in `main.ts` because
 * it is one subject — the places of a city — and `main.ts` is the boot.
 *
 * Two kinds of place come out of it. The parcels the chunk workers laid out
 * carry the police stations, the metro entrances, the shops and the parking
 * bays, so those are read off the scene once it has settled. The rest — the
 * dealers' corners, the front doors, the contacts and the corners their work
 * sends the player to — are a function of the seed and the districts, and each
 * is snapped to the road nearest it, because a person stands on a street.
 */
import type { WorldScene } from './render/world-scene.ts';
import { dealerPlaces, type DealerPlace } from './sim/dealer.ts';
import { EnforcerGang } from './sim/enforcer.ts';
import { giverPlaces } from './sim/giver.ts';
import { jobSites, type MissionWorld } from './sim/job.ts';
import type { MetroPlace } from './sim/metro.ts';
import { ParkedCars } from './sim/parked.ts';
import type { Ground } from './sim/physics.ts';
import { safehousePlaces, type SafehousePlace } from './sim/safehouse.ts';
import { shopPlaces, type ShopPlace } from './sim/shop.ts';
import { crimeGrounds, type CrimeGround } from './sim/street-crime.ts';
import { venuesOf, type Venues } from './sim/city-events.ts';
import { TerritoryMap } from './sim/territory.ts';
import type { TrafficRoads } from './sim/traffic.ts';
import { metroEntrances } from './world/metro.ts';
import { kerbsidePlace } from './world/kerbside.ts';
import { nearestRoadPlace } from './world/surface.ts';
import type { Point, WorldDescription } from './world/types.ts';

/** The places of one session, for whoever draws or names them. */
export interface WorldPlaces {
  /** The police stations, as the parcels put them (spec section 11.7). */
  stations: readonly Point[];
  /** The metro station entrances (spec section 13.3), on the street outside each. */
  metro: readonly MetroPlace[];
  /** The shops (spec section 16.1), entered from their own shopfronts. */
  shops: readonly ShopPlace[];
  /** The dealers' corners (spec section 16.2), which move through the day. */
  dealers: readonly DealerPlace[];
  /** The properties for sale (spec section 16.3). */
  safehouses: readonly SafehousePlace[];
  /** Whose block is whose (spec section 17.2). */
  turf: TerritoryMap;
  /** The contacts and the corners their work runs between (spec section 18). */
  missions: MissionWorld;
  /** The parked cars (spec section 13.1), or undefined where no worker laid out the bays. */
  parked: ParkedCars | undefined;
  /** The corners the street crime of spec section 20.5 happens on, one set to a district. */
  crimes: readonly CrimeGround[];
  /** Where the city holds what it puts on (spec section 20.5). */
  venues: Venues;
}

/**
 * Build them all and hand them to the ground. It is called once the scene has
 * settled, because the parcels are built in the chunk workers and the places
 * dealt over them are not known until one has answered.
 */
export function buildPlaces(
  seed: number,
  description: WorldDescription,
  world: Pick<WorldScene, 'stations' | 'metro' | 'shops' | 'bays'>,
  roads: TrafficRoads,
  ground: Ground,
): WorldPlaces {
  const snap = (x: number, y: number) => nearestRoadPlace(description, x, y);
  const places = findPlaces(seed, description, world);
  // An arrest comes back on the road nearest a station (spec section 11.7).
  ground.stations = places.stations.map((at) => snap(at.x, at.y) ?? { ...at, heading: 0 });
  ground.metro = places.metro;
  ground.shops = places.shops;
  ground.dealers = places.dealers;
  ground.safehouses = places.safehouses;
  ground.turf = places.turf;
  // The enforcers a faction sends walk the roads the police drive.
  ground.enforcers = new EnforcerGang(roads, places.turf);
  ground.missions = places.missions;
  ground.crimes = places.crimes;
  ground.parked = places.parked;
  return places;
}

/**
 * The places alone, with nothing handed to the ground. `scripts/map-preview.ts`
 * marks them on a map with no session behind it, so they must not need one.
 */
export function findPlaces(
  seed: number,
  description: WorldDescription,
  world: Pick<WorldScene, 'stations' | 'metro' | 'shops' | 'bays'>,
): WorldPlaces {
  const snap = (x: number, y: number) => nearestRoadPlace(description, x, y);
  const stations = world.stations ?? [];
  // A metro station is entered from the street, so its place is the pavement
  // the stairs stand on (spec section 13.3), and it is named for the district
  // it serves. The renderer builds the stairs from the same answer, so the
  // reach the panel opens at is measured from the stairs the player walked to.
  const metro: MetroPlace[] = metroEntrances(description, world.metro ?? []).map((at) => ({
    x: at.x,
    y: at.y,
    heading: at.heading,
    name: description.districts[at.district]?.name ?? 'Metro',
  }));
  // A shop is entered from its own shopfront rather than from the road, so
  // these need no lookup.
  const shops = shopPlaces(world.shops ?? [], description.districts);
  // A dealer stands on the pavement and watches the road, not in the traffic.
  const dealers = dealerPlaces(seed, description.districts, (x, y) => kerbsidePlace(description, x, y));
  const safehouses = safehousePlaces(seed, description.districts, snap);
  // The turf is seeded from the district cultures the seed handed out.
  const turf = new TerritoryMap(description);
  const missions: MissionWorld = {
    givers: giverPlaces(seed, description.districts, snap),
    sites: jobSites(seed, description.districts, snap),
  };
  // The street crime of spec section 20.5 happens on corners of a district's
  // own, picked the way the dealers' pitches are, and the city holds what it
  // puts on at a venue picked the same way.
  const crimes = crimeGrounds(seed, description.districts, snap);
  const venues = venuesOf(seed, description.districts, description.beaches, snap);
  // Which bay holds a car is a function of the tick, so the physics and the
  // renderer share one plan.
  const parked = world.bays === undefined ? undefined : new ParkedCars(seed, world.bays);
  return { stations, metro, shops, dealers, safehouses, turf, missions, parked, crimes, venues };
}

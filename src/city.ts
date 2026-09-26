/**
 * The city one session is played in: everything built once from the world
 * description and then read every tick, and the {@link Ground} the physics
 * reads them all through.
 *
 * `main.ts` builds the pieces of a session and `frame.ts` runs them. This is the
 * piece that is a city rather than a screen: the ambient traffic of spec
 * section 13.1 and the crowd that walks beside it, the tram of 13.2, the
 * police of 14, the emergency services of 20.3 and the wildlife of 20.4. Each
 * is placed once for a world and then evaluated from the tick, so the physics
 * and the renderer share one plan.
 *
 * Nothing here is state of a session: the record holds all of that. A city is
 * a pure function of the seed and the world built from it, so two sessions of
 * one seed are driven through the same streets.
 */
import { BusStops } from './sim/transit/bus-stops.ts';
import { StreetCorners } from './sim/crime/corners.ts';
import type { Ground } from './sim/physics/ground-bodies.ts';
import { EmergencyServices } from './sim/city/emergency.ts';
import { AmbientPedestrians, crowdDistrictsOf } from './sim/crowd/pedestrians.ts';
import { PoliceForce, policeDistrictsOf } from './sim/police/police.ts';
import { AmbientTraffic, trafficRoadsOf, type TrafficRoads } from './sim/traffic/traffic.ts';
import { TramLine } from './sim/transit/tram.ts';
import { AmbientWildlife } from './sim/city/wildlife.ts';
import { roadDecks } from './world/decks/decks.ts';
import { pierPosts } from './world/decks/pier-posts.ts';
import { SurfaceIndex } from './world/terrain/surface.ts';
import type { WorldDescription } from './world/types.ts';

/** The carved ground a city stands on: a `WorldScene`, or the carve it reads. */
export interface HeightSource {
  heightAt(x: number, y: number): number;
}

/** The city of one session, and the ground the physics drives on. */
export interface City {
  /** What the physics is built from: the ground, the decks, and everything below. */
  ground: Ground;
  /** The road network as the traffic, the police and the services all read it. */
  roads: TrafficRoads;
  traffic: AmbientTraffic;
  /** The kerbs the buses of spec section 20.2 call at, and the people waiting there. */
  busStops: BusStops;
  crowd: AmbientPedestrians;
  /** The occupied corners of spec section 20.1: buskers, carts, stalls and the people round them. */
  corners: StreetCorners;
  tram: TramLine;
  police: PoliceForce;
  /** The animals of spec section 20.4, placed along the same roads and the shore. */
  wildlife: AmbientWildlife;
}

/**
 * Build the city of a seed. `world` is the scene the renderer has already made
 * of the same description: the physics drives on the carved ground it draws,
 * so the height under a wheel and the height under a pixel are one number
 * (spec section 11.3). Only the height is read, so `scripts/sim-profile.ts`
 * builds a city in Node from the carve alone.
 */
export function buildCity(seed: number, description: WorldDescription, world: HeightSource): City {
  // The surface the parcel model left, which is what says whether a wheel is
  // on tarmac, sand or grass.
  const surfaces = new SurfaceIndex(description);
  const roads = trafficRoadsOf(description);
  const traffic = new AmbientTraffic(seed, roads);
  // The crowd walks the pavements of the same roads, is placed once the same way,
  // and waits for the same lights to cross.
  const districtAt = crowdDistrictsOf(description);
  const crowd = new AmbientPedestrians(seed, roads, districtAt, traffic.signals);
  // The kerbs those buses call at (spec section 20.2), gathered from the tours
  // once they are timed: a stop is where a bus stands, not a thing the world
  // description carries.
  const busStops = new BusStops(seed, traffic, districtAt);
  // The corners somebody stands on for hours are laid out along the same pavements.
  const corners = new StreetCorners(seed, roads, districtAt);
  // The trams of spec section 13.2 keep to the traffic's own lights.
  const tram = new TramLine(seed, roads, description.tram, description.districts, traffic.signals);
  // The police drive the same roads the traffic does, and answer from the
  // district the player stands in (spec section 14). The fire engines and the
  // ambulances of spec section 20.3 answer from the district the call came
  // from, over the same roads.
  const districts = policeDistrictsOf(description);
  const police = new PoliceForce(roads, districts);
  const emergency = new EmergencyServices(roads, districts);
  // The animals of spec section 20.4 live along the same roads and on the
  // beaches of spec section 7.3. They hold no record at all, so nothing steps
  // them: a gull is where the seed and the tick put it.
  const wildlife = new AmbientWildlife(seed, {
    roads,
    beaches: description.beaches,
    seaLevel: description.water.seaLevel,
    districtAt,
  });
  const ground: Ground = {
    heightAt: (x, y) => world.heightAt(x, y),
    surfaceAt: (x, y) => surfaces.at(x, y),
    seaLevel: description.water.seaLevel,
    // A bridged segment carves no ground, so the deck is the only thing to
    // drive on there and the physics is given it as a solid, with the piers it
    // stands on: a car under a deck meets them (spec section 11.3).
    decks: roadDecks(description),
    piers: pierPosts(description),
    traffic,
    crowd,
    tram,
    police,
    emergency,
  };
  return { ground, roads, traffic, busStops, crowd, corners, tram, police, wildlife };
}

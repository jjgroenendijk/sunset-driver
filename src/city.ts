/**
 * The city one session is played in: everything built once from the world
 * description and then read every tick, and the {@link Ground} the physics
 * reads them all through.
 *
 * `main.ts` builds the pieces of a session and runs the frame. This is the
 * piece that is a city rather than a screen: the ambient traffic of spec
 * section 13.1 and the crowd that walks beside it, the tram of 13.2 and the
 * police of 14. Each is placed once for a world and then evaluated from the
 * tick, so the physics and the renderer share one plan.
 *
 * Nothing here is state of a session: the record holds all of that. A city is
 * a pure function of the seed and the world built from it, so two sessions of
 * one seed are driven through the same streets.
 */
import type { Ground } from './sim/ground-bodies.ts';
import { AmbientPedestrians, crowdDistrictsOf } from './sim/pedestrians.ts';
import { PoliceForce, policeDistrictsOf } from './sim/police.ts';
import { AmbientTraffic, trafficRoadsOf, type TrafficRoads } from './sim/traffic.ts';
import { TramLine } from './sim/tram.ts';
import type { WorldScene } from './render/world-scene.ts';
import { roadDecks } from './world/decks.ts';
import { SurfaceIndex } from './world/surface.ts';
import type { WorldDescription } from './world/types.ts';

/** The city of one session, and the ground the physics drives on. */
export interface City {
  /** What the physics is built from: the ground, the decks, and everything below. */
  ground: Ground;
  /** The road network as the traffic, the police and the services all read it. */
  roads: TrafficRoads;
  traffic: AmbientTraffic;
  crowd: AmbientPedestrians;
  tram: TramLine;
  police: PoliceForce;
}

/**
 * Build the city of a seed. `world` is the scene the renderer has already made
 * of the same description: the physics drives on the carved ground it draws,
 * so the height under a wheel and the height under a pixel are one number
 * (spec section 11.3).
 */
export function buildCity(seed: number, description: WorldDescription, world: WorldScene): City {
  // The surface the parcel model left, which is what says whether a wheel is
  // on tarmac, sand or grass.
  const surfaces = new SurfaceIndex(description);
  const roads = trafficRoadsOf(description);
  const traffic = new AmbientTraffic(seed, roads);
  // The crowd walks the pavements of the same roads, and is placed once the same way.
  const crowd = new AmbientPedestrians(seed, roads, crowdDistrictsOf(description));
  // The trams of spec section 13.2 keep to the traffic's own lights.
  const tram = new TramLine(seed, roads, description.tram, description.districts, traffic.signals);
  // The police drive the same roads the traffic does, and answer from the
  // district the player stands in (spec section 14).
  const police = new PoliceForce(roads, policeDistrictsOf(description));
  const ground: Ground = {
    heightAt: (x, y) => world.heightAt(x, y),
    surfaceAt: (x, y) => surfaces.at(x, y),
    seaLevel: description.water.seaLevel,
    // A bridged segment carves no ground, so the deck is the only thing to
    // drive on there and the physics is given it as a solid.
    decks: roadDecks(description),
    traffic,
    crowd,
    tram,
    police,
  };
  return { ground, roads, traffic, crowd, tram, police };
}

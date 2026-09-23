/**
 * The maps of a session (spec section 12) and every mark on them.
 *
 * Both maps are drawn from one `MapArt`, so the corner map and the full map can
 * never disagree about a road or a mark. The POI list is shared with them: a
 * system that owns places writes `pois.extra` once and both maps show them.
 * It is here rather than in `main.ts` because it is one subject — what the maps
 * show — and `main.ts` is the boot.
 */
import type { WorldPlaces } from './places.ts';
import type { SimState } from './sim/simulation.ts';
import { DealerMarks } from './ui/dealers.ts';
import { EnforcerMarks } from './ui/enforcers.ts';
import { EmergencyCrews } from './ui/emergency-crews.ts';
import { GiverBodies } from './ui/givers.ts';
import { OfficerMarks } from './ui/officers.ts';
import { MapArt } from './ui/map-draw.ts';
import { MapPois } from './ui/map.ts';
import { MapScreen } from './ui/map-screen.ts';
import { Navigator } from './ui/map-route.ts';
import { Minimap } from './ui/minimap.ts';
import { MissionMarks } from './ui/missions.ts';
import { placeMarks } from './ui/place-marks.ts';
import { StreetLife } from './ui/street-life.ts';
import { TerritoryOverlay } from './ui/territory.ts';
import { buildRoadGraph, type RoadGraph } from './world/graph.ts';
import type { WorldDescription } from './world/types.ts';

/** The two maps, and the marks that move on them. */
export interface SessionMaps {
  minimap: Minimap;
  map: MapScreen;
  /** The road route from the player to the waypoint, drawn on both maps. */
  navigator: Navigator;
  /** The contacts of spec section 18 on the street, who begin the crowd's list. */
  giverBodies: GiverBodies;
  dealerMarks: DealerMarks;
  enforcerMarks: EnforcerMarks;
  streetLife: StreetLife;
  officerMarks: OfficerMarks;
  emergencyCrews: EmergencyCrews;
  missionMarks: MissionMarks;
}

/**
 * Build both maps of a session over its places. A pick on the full map sets the
 * waypoint. `ground` answers how high a street is, because the people these
 * stand on it stand on the road rather than at sea level.
 */
export function buildMaps(
  state: SimState,
  description: WorldDescription,
  places: WorldPlaces,
  touch: boolean,
  ground: { heightAt(x: number, y: number): number },
): SessionMaps {
  const { missions, dealers, venues, crimes, turf } = places;
  const pois = new MapPois(description);
  pois.extra = placeMarks(places);
  // The contacts never move, so their bodies are stood once and begin the list
  // of people the crowd's mesh draws for somebody else (spec section 18).
  const giverBodies = new GiverBodies(state.seed, missions.givers, ground);
  // The dealers are marked after the rest, because they are the only marks that
  // move: `DealerMarks` keeps the list above and writes its own after it, and
  // stands the contacts in front of its own people.
  const dealerMarks = new DealerMarks(state.seed, dealers, pois, giverBodies.standing);
  // The enforcers are marked after the dealers, because they move every tick
  // and the dealers do not: `EnforcerMarks` writes the list both of them stand
  // in (spec section 17.2).
  const enforcerMarks = new EnforcerMarks(pois);
  // What the city has on and what it is getting up to (spec section 20.5) are
  // marked after the enforcers, for the same reason: they move and the rest
  // does not, and their people stand in the same list.
  const streetLife = new StreetLife(state.seed, venues, crimes, pois);
  // The police on foot of spec section 14 after those: they move every tick,
  // and the crowd mesh draws the list they end.
  const officerMarks = new OfficerMarks(pois);
  // The crews of the fire engines at work after those, holding their hoses:
  // they end the list the crowd mesh draws, and have no mark of their own.
  const emergencyCrews = new EmergencyCrews();
  // The objective is marked last of all, because it moves with the leg of the
  // job the record is carrying (spec section 18).
  const missionMarks = new MissionMarks(pois);
  const overlay = new TerritoryOverlay(turf, state).draw;
  const art = new MapArt(description, pois);
  const minimap = new Minimap(document.body, art);
  minimap.overlay = overlay;
  const map = new MapScreen(
    document.body,
    art,
    (place) => {
      state.waypoint = place;
    },
    touch,
  );
  map.overlay = overlay;
  // The road graph the route is found on. It is built on the first waypoint,
  // since a session that never marks one has no use for it.
  let graph: RoadGraph | undefined;
  const navigator = new Navigator(() => (graph ??= buildRoadGraph(description.roads)));
  return { minimap, map, navigator, giverBodies, dealerMarks, enforcerMarks, streetLife, officerMarks, emergencyCrews, missionMarks };
}

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
import { OfficerMarks } from './ui/officers.ts';
import { MapArt } from './ui/map-draw.ts';
import { MapPois, SHOP_POIS } from './ui/map.ts';
import { MapScreen } from './ui/map-screen.ts';
import { Navigator } from './ui/map-route.ts';
import { Minimap } from './ui/minimap.ts';
import { MissionMarks } from './ui/missions.ts';
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
  dealerMarks: DealerMarks;
  enforcerMarks: EnforcerMarks;
  streetLife: StreetLife;
  officerMarks: OfficerMarks;
  missionMarks: MissionMarks;
}

/** Build both maps of a session over its places. A pick on the full map sets the waypoint. */
export function buildMaps(
  state: SimState,
  description: WorldDescription,
  places: WorldPlaces,
  touch: boolean,
): SessionMaps {
  const { stations, metro, shops, safehouses, missions, dealers, venues, crimes, turf } = places;
  const pois = new MapPois(description);
  pois.extra = [
    ...stations.map((at) => ({ type: 'police' as const, x: at.x, y: at.y })),
    ...metro.map((at) => ({ type: 'metro-station' as const, x: at.x, y: at.y, name: `Metro · ${at.name}` })),
    ...shops.map((at) => ({ type: SHOP_POIS[at.kind], x: at.x, y: at.y, name: at.name })),
    ...safehouses.map((at) => ({ type: 'safehouse' as const, x: at.x, y: at.y, name: at.name })),
    // The contacts of spec section 18 stand where the seed put them and never
    // move, so they are marked once with the rest.
    ...missions.givers.map((at) => ({ type: 'mission-giver' as const, x: at.x, y: at.y, name: at.name })),
  ];
  // The dealers are marked after the rest, because they are the only marks that
  // move: `DealerMarks` keeps the list above and writes its own after it.
  const dealerMarks = new DealerMarks(state.seed, dealers, pois);
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
  return { minimap, map, navigator, dealerMarks, enforcerMarks, streetLife, officerMarks, missionMarks };
}

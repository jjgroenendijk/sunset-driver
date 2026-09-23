/**
 * The marks of the places that never move, which every map of a session starts
 * from. `src/maps.ts` writes them into `MapPois.extra` for the game, and
 * `map-preview.ts` for the picture of the map, so the two cannot differ.
 */
import type { WorldPlaces } from '../places.ts';
import { SHOP_POIS, type MapPoi } from './map.ts';

/** The police stations, metro entrances, shops, safehouses and contacts, as marks. */
export function placeMarks(places: Pick<WorldPlaces, 'stations' | 'metro' | 'shops' | 'safehouses' | 'missions'>): MapPoi[] {
  const { stations, metro, shops, safehouses, missions } = places;
  return [
    ...stations.map((at) => ({ type: 'police' as const, x: at.x, y: at.y })),
    ...metro.map((at) => ({ type: 'metro-station' as const, x: at.x, y: at.y, name: `Metro · ${at.name}` })),
    ...shops.map((at) => ({ type: SHOP_POIS[at.kind], x: at.x, y: at.y, name: at.name })),
    ...safehouses.map((at) => ({ type: 'safehouse' as const, x: at.x, y: at.y, name: at.name })),
    // The contacts of spec section 18 stand where the seed put them and never
    // move, so they are marked once with the rest.
    ...missions.givers.map((at) => ({ type: 'mission-giver' as const, x: at.x, y: at.y, name: at.name })),
  ];
}

/**
 * The hangar of spec section 16.3: a safehouse at the airport whose garage
 * keeps one aircraft.
 *
 * It is a {@link SafehousePlace} like every other door, so the broker sells it,
 * the panel at its door opens on it and the garage is the same exchange. What
 * is its own is where it stands and what it comes with. Its door is behind the
 * first hangar of the airport, on the landside, so a player walking up to it
 * trespasses on nothing. The aircraft it keeps is brought out onto the apron in
 * front, where the aircraft has room to leave from.
 */
import { fromLocal } from '../../world/transit/airfield-frame.ts';
import type { AircraftClass, Airfield, District } from '../../world/types.ts';
import type { SafehousePlace } from './safehouse.ts';

/** Dollars the broker asks for the hangar: dearer than the dearest house. */
export const HANGAR_PRICE = 60_000;

/** The aircraft a hangar comes with. */
export const HANGAR_AIRCRAFT: AircraftClass = 'heli-light';

/** Metres behind the hangar the door stands, and in front of it the aircraft comes out. */
const DOOR_BEHIND = 18;
const YARD_AHEAD = 22;

/**
 * The hangar of a world's airport, with the id it takes in the list of
 * properties, or none where the airport has no hangar. It is named for the
 * district nearest the airport, which is also the district its door is in.
 */
export function hangarPlaces(airfields: readonly Airfield[], districts: readonly District[], id: number): SafehousePlace[] {
  const airport = airfields.find((field) => field.kind === 'airport');
  const hangar = airport?.parts.find((part) => part.kind === 'hangar');
  if (airport === undefined || hangar === undefined || districts.length === 0) return [];
  // The hangar's back faces the landside, which is `+v`; its doors open on the apron at `-v`.
  const door = fromLocal(airport, hangar.u, hangar.v + hangar.halfV + DOOR_BEHIND);
  const yard = fromLocal(airport, hangar.u, hangar.v - hangar.halfV - YARD_AHEAD);
  let district = districts[0] as District;
  let near = Infinity;
  for (const candidate of districts) {
    const away = (candidate.x - airport.x) ** 2 + (candidate.y - airport.y) ** 2;
    if (away < near) {
      near = away;
      district = candidate;
    }
  }
  const out = airport.heading - Math.PI / 2;
  return [
    {
      id,
      district,
      name: `Hangar · ${district.name}`,
      price: HANGAR_PRICE,
      slots: 1,
      x: door.x,
      y: door.y,
      heading: airport.heading + Math.PI / 2,
      hangar: { x: yard.x, y: yard.y, heading: out },
    },
  ];
}

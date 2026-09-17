/**
 * The contacts who put work the player's way, and where they stand (spec
 * section 18).
 *
 * One contact works each of a faction's home districts, so a faction has as
 * many as the seed gave it neighbourhoods (`faction.ts`), and a faction the
 * seed left without a district has none at all. Unit 13 is the police and holds
 * no ground, so it has no home district and no contact here; its work waits on
 * a giver that is not a piece of turf.
 *
 * A contact stands on a street rather than in a doorway, so the place is a
 * point round the district's site snapped to the nearest road, exactly as a
 * dealer's corner is (`dealer.ts`) and a front door is (`safehouse.ts`). Unlike
 * a dealer they do not move: a player who learns where a contact stands finds
 * them there for the rest of the session, which is what makes the work
 * something to come back to.
 *
 * Pure: it reads the world's districts and the record, and answers with plain
 * numbers.
 */
import { genRng, Subsystem } from '../core/rng.ts';
import type { District } from '../world/types.ts';
import { FACTIONS, homeDistricts, hostileTo, type Faction } from './faction.ts';
import type { Place } from './on-foot.ts';
import type { SimState } from './simulation.ts';

/** Metres of a contact a player on foot may take work from: the reach of a shop door. */
export const GIVER_REACH = 4;

/** Metres from the middle of a district a contact is looked for, and the most they may end up at. */
const STAND_NEAR = 50;
const STAND_FAR = 190;
const STAND_LIMIT = 300;

/** Corners tried round a district before it is left without a contact. */
const STAND_TRIES = 5;

/** A contact, as the simulation, the panel and the map read one. */
export interface GiverPlace extends Place {
  /** Their own id, which is also where they stand in the list the game builds. */
  id: number;
  /** The faction they speak for: the row of {@link FACTIONS}. */
  faction: number;
  /** The district they work, which the jobs they hand out are built round. */
  district: District;
  /** What the panel and the map call them. */
  name: string;
}

/**
 * The contacts of a world: one per home district of every territorial faction.
 * `snap` puts a point on the nearest road and answers nothing where there is no
 * road near it; `src/world/surface.ts` is what the game hands in, and a
 * simulation test hands in a road of its own.
 */
export function giverPlaces(
  seed: number,
  districts: readonly District[],
  snap: (x: number, y: number) => Place | undefined,
): GiverPlace[] {
  const givers: GiverPlace[] = [];
  for (let faction = 0; faction < FACTIONS.length; faction++) {
    const spec = FACTIONS[faction] as Faction;
    for (const district of homeDistricts(districts, faction)) {
      const place = standOf(seed, district);
      if (place === undefined) continue;
      givers.push({
        id: givers.length,
        faction,
        district,
        name: `${spec.name} · ${district.name}`,
        x: place.x,
        y: place.y,
        heading: place.heading,
      });
    }
  }
  return givers;

  /** The corner one stands on: round the district's site and on a street of it. */
  function standOf(worldSeed: number, district: District): Place | undefined {
    const rng = genRng(worldSeed, Subsystem.Missions, district.id);
    const turn = rng.range(0, Math.PI * 2);
    for (let i = 0; i < STAND_TRIES; i++) {
      const angle = turn + (i / STAND_TRIES) * Math.PI * 2;
      const away = rng.range(STAND_NEAR, STAND_FAR);
      const place = snap(district.x + Math.cos(angle) * away, district.y + Math.sin(angle) * away);
      if (place === undefined) continue;
      if (Math.hypot(place.x - district.x, place.y - district.y) > STAND_LIMIT) continue;
      return place;
    }
    return undefined;
  }
}

/**
 * The contact the player is standing at, or -1. The nearest one answers, as the
 * shop doors and the dealers' corners do, and a player driving past is at them
 * too, so the panel can say why they are not being offered anything.
 */
export function giverAt(givers: readonly GiverPlace[], state: SimState): number {
  let at = -1;
  let near = GIVER_REACH;
  for (let i = 0; i < givers.length; i++) {
    const giver = givers[i] as GiverPlace;
    const away = Math.hypot(giver.x - state.player.x, giver.y - state.player.y);
    if (away > near) continue;
    near = away;
    at = i;
  }
  return at;
}

/**
 * Why a contact has no work for the player, in the words the panel shows, or
 * null when they have. A contact talks on a street corner: they will not lean
 * into a car, and they are gone before the police the player brought with them
 * arrive.
 *
 * The third is the reputation of spec section 17.3 — a faction that shoots the
 * player on sight does not hire them — and the fourth is the one rule of the
 * work itself: one job at a time, so a player carrying somebody's package
 * cannot also be guarding somebody else's shop.
 */
export function giverRefusal(state: SimState, giver?: GiverPlace): string | null {
  if (state.player.driving) return 'Not from a vehicle.';
  if (state.heat > 0) return 'Not while the police want you.';
  if (giver !== undefined && hostileTo(state, giver.faction)) {
    return `Nothing for you. ${FACTIONS[giver.faction]?.name ?? ''} has had enough of you.`;
  }
  if (state.missions.active !== null) return 'Finish what you are carrying first.';
  return null;
}

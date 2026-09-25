/**
 * The eight factions and how the player stands with them (spec section 17).
 *
 * A faction is defined first by what it trades, where it holds and how it
 * fights; the culture is the flavour on top of that. The roster below is the
 * spec's own table, and it is the one table: the territory of `territory.ts`,
 * the enforcers of `enforcer.ts`, the dealers' cut in `market.ts` and the map
 * overlay all read it and none of them keeps a second copy.
 *
 * Home turf comes from the district cultures `src/world/districts.ts` hands
 * out, so a faction's ground is wherever the seed put its neighbourhood. One
 * faction holds nothing: Unit 13 is the police, and it works the whole city.
 *
 * Reputation is one number a faction, -1..1, and it lives in the record.
 * Helping one faction moves its rivals the other way, which is what makes the
 * standing a choice rather than a counter that only goes up.
 *
 * Pure: it reads the record and the world's districts, and takes no wall-clock.
 */
import { clamp } from '../core/math.ts';
import type { Culture, District } from '../world/types.ts';
import type { SimState } from './simulation.ts';
import type { VehicleClass } from './vehicle.ts';
import type { WeaponId } from './weapon.ts';

/** The factions, in the order of the spec's table. The record stores a row per faction in this order. */
export const FACTION_IDS = ['family', 'syndicate', 'bratva', 'reyes', 'crew', 'saints', 'docklands', 'unit13'] as const;
export type FactionId = (typeof FACTION_IDS)[number];

/** One row of the roster (spec section 17.1). */
export interface Faction {
  id: FactionId;
  /** What the map, the HUD and the panels call them. */
  name: string;
  /**
   * The district culture that is their home turf. Their ground is seeded from
   * every district of it, so a seed that scatters the named neighbourhoods
   * scatters the faction with them. `none` is the one that holds no ground.
   */
  culture: Culture;
  /** False only for Unit 13, which works the city and holds none of it. */
  territorial: boolean;
  /** What they run, in the words the panels show. */
  business: string;
  /** What they carry and what their enforcers come out with. */
  arsenal: readonly WeaponId[];
  /** What they drive, dearest first. */
  vehicles: readonly VehicleClass[];
  /** The work they put the player's way (spec section 17.1). */
  offer: string;
  /** Standing gained with this faction is lost with each of these, and the other way about. */
  rivals: readonly FactionId[];
  /** The colour their ground is washed in on the map. No two share one. */
  colour: string;
}

/**
 * The roster. The rivalries are symmetric — every faction named as a rival
 * names the other back — because a shift in standing walks them both ways and a
 * one-sided pair would move only in one direction.
 */
export const FACTIONS: readonly Faction[] = Object.freeze([
  Object.freeze({
    id: 'family',
    name: 'The Family',
    culture: 'italian',
    territorial: true,
    business: 'Protection, waste hauling, restaurants and union graft',
    arsenal: Object.freeze(['colt-m1911', 'model-29', 'remington-870', 'sawn-off', 'baseball-bat'] as const),
    vehicles: Object.freeze(['saloon', 'van'] as const),
    offer: 'Collection work, and a discount on a respray.',
    rivals: Object.freeze(['syndicate', 'docklands'] as const),
    colour: '#d05a5a',
  }),
  Object.freeze({
    id: 'syndicate',
    name: 'The Syndicate',
    culture: 'chinese',
    territorial: true,
    business: 'Import and export, counterfeits, gambling dens and night markets',
    arsenal: Object.freeze(['tec-9', 'mac-10', 'uzi', 'machete', 'katana'] as const),
    vehicles: Object.freeze(['van', 'compact'] as const),
    offer: 'The best contraband prices in the city.',
    rivals: Object.freeze(['family', 'bratva'] as const),
    colour: '#e0b13a',
  }),
  Object.freeze({
    id: 'bratva',
    name: 'The Bratva',
    culture: 'east-european',
    territorial: true,
    business: 'Car theft rings, chop shops, arms and export through the harbour',
    arsenal: Object.freeze(['ak-47', 'fn-fal', 'm4a1', 'sig-p226', 'crowbar'] as const),
    vehicles: Object.freeze(['sports', 'truck'] as const),
    offer: 'Theft and export work, and the widest weapon catalogue.',
    rivals: Object.freeze(['syndicate', 'docklands'] as const),
    colour: '#8a8fa8',
  }),
  Object.freeze({
    id: 'reyes',
    name: 'Los Reyes',
    culture: 'latin',
    territorial: true,
    business: 'Street distribution, illegal racing and custom cars',
    arsenal: Object.freeze(['glock-17', 'beretta-92fs', 'mini-14', 'switchblade'] as const),
    vehicles: Object.freeze(['sports', 'compact'] as const),
    offer: 'Street races, courier runs and vehicle work.',
    rivals: Object.freeze(['crew', 'saints'] as const),
    colour: '#4fb3d0',
  }),
  Object.freeze({
    id: 'crew',
    name: 'The Crew',
    culture: 'african-american',
    territorial: true,
    business: 'Corner-level trade, music and cars',
    arsenal: Object.freeze(['glock-17', 'uzi', 'mp5', 'mossberg-500'] as const),
    vehicles: Object.freeze(['saloon', 'offroad'] as const),
    offer: 'Territory work, quick sales and word on the police.',
    rivals: Object.freeze(['reyes', 'unit13'] as const),
    colour: '#5fc07a',
  }),
  Object.freeze({
    id: 'saints',
    name: 'The Iron Saints',
    culture: 'outlaw',
    territorial: true,
    business: 'Meth, gun running and highway robbery',
    arsenal: Object.freeze(['sawn-off', 'mossberg-500', 'spas-12', 'molotov'] as const),
    vehicles: Object.freeze(['motorcycle', 'truck'] as const),
    offer: 'Wilderness work and off-road vehicles.',
    rivals: Object.freeze(['reyes', 'unit13'] as const),
    colour: '#c47a3a',
  }),
  Object.freeze({
    id: 'docklands',
    name: 'The Docklands Mob',
    culture: 'irish',
    territorial: true,
    business: 'Port labour, smuggling, politics and property',
    arsenal: Object.freeze(['beretta-92fs', 'desert-eagle', 'baseball-bat', 'pipe-bomb'] as const),
    vehicles: Object.freeze(['van', 'saloon'] as const),
    offer: 'Smuggling runs, and property at a price nobody else gets.',
    rivals: Object.freeze(['family', 'bratva'] as const),
    colour: '#7fae5a',
  }),
  Object.freeze({
    id: 'unit13',
    name: 'Unit 13',
    culture: 'none',
    territorial: false,
    business: 'Bribes, protection, evidence and information',
    arsenal: Object.freeze(['sig-p226', 'mp5', 'remington-870', 'tear-gas'] as const),
    vehicles: Object.freeze(['saloon', 'emergency'] as const),
    offer: 'Heat off for cash, intel, and work nobody else will take.',
    rivals: Object.freeze(['crew', 'saints'] as const),
    colour: '#9a7ad0',
  }),
] as const);

/** The row a faction stands on, or -1 for a name no faction carries. */
export function factionIndex(id: FactionId): number {
  return FACTION_IDS.indexOf(id);
}

/**
 * The faction whose home turf a district culture is, or -1 where it is
 * nobody's. The beach and the unnamed districts belong to no one, and so does
 * the culture Unit 13 carries: the police hold no ground (spec section 17.2).
 */
export function factionForCulture(culture: Culture): number {
  for (let i = 0; i < FACTIONS.length; i++) {
    const faction = FACTIONS[i] as Faction;
    if (faction.territorial && faction.culture === culture) return i;
  }
  return -1;
}

/** The districts a faction calls home, in the world's own order. Empty for Unit 13. */
export function homeDistricts(districts: readonly District[], faction: number): District[] {
  const spec = FACTIONS[faction];
  if (spec === undefined || !spec.territorial) return [];
  return districts.filter((d) => d.culture === spec.culture);
}

/** What the record carries about the factions (spec sections 17.2, 17.3). */
export interface FactionState {
  /**
   * Reputation with each faction, -1..1, one row per faction of
   * {@link FACTIONS}. 0 is a stranger: they will trade and they will not shoot.
   */
  standing: number[];
  /**
   * The blocks the player has taken off a faction (spec section 17.2), each a
   * packed block key of `territory.ts`. Kept sorted, so the record reads the
   * same however the captures happened.
   */
  captured: number[];
  /** The takeover the player is in the middle of, or null while they are in none. */
  takeover: TakeoverState | null;
  /** The wave that is out after them, or null while nobody is coming. */
  wave: WaveState | null;
  /** The last tick the held ground paid out, so a day's income is paid once. */
  paidTick: number;
}

/** The block the player is standing their ground on (spec section 17.2). */
interface TakeoverState {
  /** The packed block key of `territory.ts`. */
  block: number;
  /** The faction it is being taken off. */
  faction: number;
  /** The tick the player first stood on it. */
  started: number;
}

/**
 * A retaliation wave (spec section 17.2): who is coming, what they are coming
 * for and until when. The enforcers themselves are `enforcer.ts`'s.
 */
interface WaveState {
  faction: number;
  /** The block that started it. */
  block: number;
  /** The tick the wave was called. */
  called: number;
  /** The tick it gives up on, if the player is still standing. */
  until: number;
  /** Which wave of the fight this is, counted from 1. */
  round: number;
  /**
   * How many enforcers it has put on the street so far. A wave is a fixed
   * number of people, so this is what says when it has sent them all, and a
   * shot one is not replaced.
   */
  sent: number;
}

export function createFactionState(): FactionState {
  return { standing: FACTIONS.map(() => 0), captured: [], takeover: null, wave: null, paidTick: 0 };
}

/** Standing at or under this and they shoot on sight (spec section 17.3). */
export const HOSTILE = -0.4;

/** The share of a shift that lands on each rival, the other way about. */
const RIVAL_SHARE = 0.5;

/** How well the player stands with a faction, -1..1. Out-of-range rows read as strangers. */
export function standingOf(state: SimState, faction: number): number {
  return state.factions.standing[faction] ?? 0;
}

/**
 * Move the player's standing with a faction, and its rivals' the other way
 * (spec section 17.3). Helping one side of a rivalry is the same act as
 * crossing the other, so one call is the whole of it and nothing else writes
 * the row.
 */
export function shiftStanding(state: SimState, faction: number, amount: number): void {
  const spec = FACTIONS[faction];
  if (spec === undefined || amount === 0) return;
  const standing = state.factions.standing;
  standing[faction] = clamp((standing[faction] ?? 0) + amount, -1, 1);
  for (const id of spec.rivals) {
    const rival = factionIndex(id);
    if (rival < 0) continue;
    standing[rival] = clamp((standing[rival] ?? 0) - amount * RIVAL_SHARE, -1, 1);
  }
}

/** True where a faction shoots the player on sight (spec section 17.3). */
export function hostileTo(state: SimState, faction: number): boolean {
  return faction >= 0 && faction < FACTIONS.length && standingOf(state, faction) <= HOSTILE;
}

/**
 * Who runs each district, as one row per district id and -1 where nobody does.
 * It is an array rather than a map because `src/sim` may not walk one (the
 * determinism rules of `CLAUDE.md`), and because the dealers, the shops and the
 * territory all ask the same question of the same ids.
 */
export function districtFactions(districts: readonly District[]): number[] {
  let top = -1;
  for (const district of districts) top = Math.max(top, district.id);
  const out = new Array<number>(top + 1).fill(-1);
  for (const district of districts) out[district.id] = factionForCulture(district.culture);
  return out;
}

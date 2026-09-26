/**
 * The crime the city commits on its own (spec section 20.5): the mugging on
 * the corner, the shootout between two crews, the deal in the alley, the
 * driver pulled over, the shoplifter running out of a shop.
 *
 * It is a diary, not a simulation. The day is cut into slots, and every
 * district draws from `(seed, slot)` whether something happens on one of its
 * corners in that slot, what it is, and which corner. So the whole city's
 * crime is a pure function of the seed and the tick, costs nothing while
 * nobody is near it, and replays exactly. The corners are picked once for a
 * world, the way the dealers' pitches are (`dealer.ts`): a point near a
 * district's middle, snapped to the nearest street.
 *
 * What the player does about it is the one thing that is written down.
 * {@link stepStreetCrime} looks at the crime the player has walked into: come
 * close enough to a mugging and it breaks up, and the record keeps that it
 * did. A deal broken up this way is a deal robbed, which pays and draws the
 * police; a mugging is a good turn, which pays less and draws nobody. A
 * traffic stop is the police's own business and breaks up for nobody.
 *
 * The record holds the incidents the player has settled and nothing else,
 * because everything else is already a function of the tick.
 */
import { genRng, rngFor, Subsystem } from '../../core/rng.ts';
import { cos, hypot, sin } from '../../core/libm.ts';
import type { District } from '../../world/types.ts';
import type { Zone } from '../../world/types.ts';
import { TICKS_PER_HOUR } from '../clock.ts';
import type { Place } from '../player/on-foot.ts';
import { report } from '../police/police.ts';
import type { SimState } from '../simulation.ts';

/** What the city gets up to on its own. */
export type CrimeKind = 'mugging' | 'shootout' | 'deal' | 'stop' | 'shoplifter';

/** What one kind of incident is. */
export interface CrimeSpec {
  /** What the HUD and the map call it. */
  name: string;
  /** The hour it may start in and the first hour it may not. It wraps past midnight. */
  from: number;
  to: number;
  /** The zones it happens in. */
  zones: readonly Zone[];
  /** How likely a district is to draw one of these in a slot, before the zone thins it. */
  weight: number;
  /** Ticks it runs for if nobody interferes. */
  ticks: number;
  /** True for one the player can break up. A traffic stop is not. */
  breakable: boolean;
  /** Dollars breaking it up leaves the player with. */
  pays: number;
  /** Heat breaking it up draws. Robbing a deal is a crime; stopping a mugging is not. */
  heat: number;
}

/** Every kind and the numbers that make it. Nothing else branches on a kind. */
export const CRIMES: Readonly<Record<CrimeKind, CrimeSpec>> = Object.freeze({
  mugging: {
    name: 'Mugging',
    from: 19,
    to: 4,
    zones: ['core', 'inner', 'industrial'],
    weight: 1,
    ticks: 40 * 60,
    breakable: true,
    pays: 60,
    heat: 0,
  },
  shootout: {
    name: 'Shootout',
    from: 21,
    to: 3,
    zones: ['inner', 'industrial'],
    weight: 0.35,
    ticks: 30 * 60,
    breakable: true,
    pays: 0,
    heat: 0,
  },
  deal: {
    name: 'Deal',
    from: 22,
    to: 5,
    zones: ['inner', 'industrial', 'outskirts'],
    weight: 0.7,
    ticks: 50 * 60,
    breakable: true,
    pays: 240,
    heat: 0.8,
  },
  stop: {
    name: 'Traffic stop',
    from: 6,
    to: 22,
    zones: ['core', 'inner', 'suburban', 'outskirts'],
    weight: 0.8,
    ticks: 60 * 60,
    breakable: false,
    pays: 0,
    heat: 0,
  },
  shoplifter: {
    name: 'Shoplifter',
    from: 9,
    to: 20,
    zones: ['core', 'inner'],
    weight: 0.6,
    ticks: 35 * 60,
    breakable: true,
    pays: 90,
    heat: 0,
  },
});

/** The kinds in a fixed order, so nothing here ever iterates an object. */
export const CRIME_ORDER: readonly CrimeKind[] = Object.freeze(['mugging', 'shootout', 'deal', 'stop', 'shoplifter']);

/** Ticks one slot of the diary runs for: twenty minutes of game clock. */
export const SLOT_TICKS = Math.round(TICKS_PER_HOUR / 3);

/** Corners of its own each district keeps for this. */
const CORNERS = 6;

/** Metres from a district's middle the corners are looked for. */
const CORNER_NEAR = 50;
const CORNER_FAR = 220;

/** Metres from an incident the player has to get to break it up. */
export const INTERRUPT_RANGE = 8;

/** How much of a district's weight each zone carries. */
const ZONE_CRIME: Record<Zone, number> = {
  core: 1,
  inner: 1,
  industrial: 0.7,
  suburban: 0.35,
  outskirts: 0.3,
  wilderness: 0,
};

/** The corners one district's incidents happen on. */
export interface CrimeGround {
  district: District;
  corners: readonly Place[];
}

/** One incident, as it stands while it is going on. */
export interface StreetCrime {
  /** Stable for the life of a session: the slot it was drawn in and the district that drew it. */
  id: number;
  kind: CrimeKind;
  x: number;
  y: number;
  heading: number;
  district: number;
  /** The tick it started and the tick it ends of its own accord. */
  from: number;
  to: number;
}

/** An incident the player settled, as the record carries it. */
export interface SettledCrime {
  id: number;
  kind: CrimeKind;
  /** The tick the player broke it up on. */
  tick: number;
  /** What it paid them. */
  paid: number;
}

/** What the record holds of the street crime: the incidents the player has settled. */
export interface CrimeState {
  /** Ascending by id. */
  settled: SettledCrime[];
}

export function createCrimeState(): CrimeState {
  return { settled: [] };
}

/**
 * Pick the corners of a world. `snap` puts a point on the nearest street and
 * answers nothing where there is none, exactly as the dealers' pitches are
 * placed. A district with no street near its middle keeps no corners and gets
 * no crime, which over the seeds measured is the wilderness and nothing else.
 */
export function crimeGrounds(
  seed: number,
  districts: readonly District[],
  snap: (x: number, y: number) => Place | undefined,
): CrimeGround[] {
  const grounds: CrimeGround[] = [];
  for (const district of districts) {
    if (ZONE_CRIME[district.zone] <= 0) continue;
    const rng = genRng(seed, Subsystem.Events, district.id);
    const turn = rng.range(0, 2 * Math.PI);
    const corners: Place[] = [];
    for (let i = 0; i < CORNERS; i++) {
      const angle = turn + (i / CORNERS) * 2 * Math.PI;
      const away = rng.range(CORNER_NEAR, CORNER_FAR);
      const place = snap(district.x + cos(angle) * away, district.y + sin(angle) * away);
      if (place !== undefined) corners.push(place);
    }
    if (corners.length === 0) continue;
    grounds.push({ district, corners });
  }
  return grounds;
}

/** What is going on at a tick, ascending by id. A settled incident is over and is not listed. */
export function crimesAt(seed: number, tick: number, grounds: readonly CrimeGround[], state?: CrimeState): StreetCrime[] {
  const live: StreetCrime[] = [];
  const slot = Math.floor(Math.max(0, tick) / SLOT_TICKS);
  // An incident started in the slot before this one may still be running.
  for (const before of [1, 0]) {
    const at = slot - before;
    if (at < 0) continue;
    for (const [i, ground] of grounds.entries()) {
      const crime = crimeOn(seed, at, i, ground, grounds.length);
      if (crime === undefined) continue;
      if (tick < crime.from || tick >= crime.to) continue;
      if (state !== undefined && settledOf(state, crime.id) !== undefined) continue;
      live.push(crime);
    }
  }
  live.sort((a, b) => a.id - b.id);
  return live;
}

/** The incident one district draws in one slot, or undefined where it draws none. */
function crimeOn(
  seed: number,
  slot: number,
  index: number,
  ground: CrimeGround,
  districts: number,
): StreetCrime | undefined {
  const rng = rngFor(seed, slot, Subsystem.Events, ground.district.id);
  const busy = ZONE_CRIME[ground.district.zone] * (0.4 + 0.6 * ground.district.density);
  const hour = Math.floor(((slot * SLOT_TICKS) % (24 * TICKS_PER_HOUR)) / TICKS_PER_HOUR);
  // One draw over every kind at once, so a district holds at most one incident
  // in a slot and the kinds keep their weights against each other.
  let total = 0;
  for (const kind of CRIME_ORDER) total += runs(kind, ground.district.zone, hour) ? CRIMES[kind].weight * busy : 0;
  const roll = rng.float();
  if (roll >= total) return undefined;
  let seen = 0;
  for (const kind of CRIME_ORDER) {
    if (!runs(kind, ground.district.zone, hour)) continue;
    seen += CRIMES[kind].weight * busy;
    if (roll >= seen) continue;
    const corner = ground.corners[rng.int(0, ground.corners.length - 1)] as Place;
    const from = slot * SLOT_TICKS + rng.int(0, SLOT_TICKS - 1);
    return {
      id: slot * districts + index,
      kind,
      x: corner.x,
      y: corner.y,
      heading: corner.heading,
      district: ground.district.id,
      from,
      to: from + CRIMES[kind].ticks,
    };
  }
  return undefined;
}

/** What the record says about an incident, or undefined while nobody has settled it. */
export function settledOf(state: CrimeState, id: number): SettledCrime | undefined {
  const list = state.settled;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = (list[mid] as SettledCrime).id;
    if (at === id) return list[mid];
    if (at < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/**
 * Break up whatever the player has walked into on this tick. It is the whole
 * of the player's side of spec section 20.5: come within
 * {@link INTERRUPT_RANGE} of an incident that can be broken up and it is over,
 * the money is theirs, and what it cost them in heat goes through `police.ts`
 * like every other raise. Answers the incidents settled this tick.
 */
export function stepStreetCrime(state: SimState, grounds: readonly CrimeGround[]): StreetCrime[] {
  const settled: StreetCrime[] = [];
  if (grounds.length === 0) return settled;
  const at = state.player.driving ? { x: state.vehicle.x, y: state.vehicle.z } : { x: state.player.x, y: state.player.y };
  for (const crime of crimesAt(state.seed, state.tick, grounds, state.crimes)) {
    const spec = CRIMES[crime.kind];
    if (!spec.breakable) continue;
    if (hypot(crime.x - at.x, crime.y - at.y) > INTERRUPT_RANGE) continue;
    addSettled(state.crimes, { id: crime.id, kind: crime.kind, tick: state.tick, paid: spec.pays });
    state.money += spec.pays;
    if (spec.heat > 0) report(state, spec.heat);
    settled.push(crime);
  }
  return settled;
}

/** Add a settled incident, keeping the list in id order. */
function addSettled(state: CrimeState, record: SettledCrime): void {
  let i = state.settled.length;
  while (i > 0 && (state.settled[i - 1] as SettledCrime).id > record.id) i--;
  state.settled.splice(i, 0, record);
}

/** True where a kind happens: the right zone, at an hour it keeps. */
function runs(kind: CrimeKind, zone: Zone, hour: number): boolean {
  const spec = CRIMES[kind];
  if (!spec.zones.includes(zone)) return false;
  return spec.from <= spec.to ? hour >= spec.from && hour < spec.to : hour >= spec.from || hour < spec.to;
}

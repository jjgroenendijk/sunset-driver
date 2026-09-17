/**
 * The dealers of the contraband trade, and where they are standing (spec
 * section 16.2).
 *
 * One dealer works each district. They do not stand still: each has a handful
 * of corners on their own streets and moves to the next one every few hours, so
 * a player who learns a district still has to look for the pitch. Which corner
 * they are on is a function of the tick alone, which is what lets the map mark
 * it, the panel name it and a replay find them in the same place (spec section
 * 5.3).
 *
 * A corner is picked round the district's site and then snapped to the nearest
 * road, because a dealer stands on a street and not in the middle of a block.
 * The snapping is handed in rather than read here, so the simulation tests can
 * put a dealer on a hillside with no roads on it at all.
 *
 * A district with no street near its middle keeps no corner and gets no dealer.
 * Over the seeds measured that is the wilderness and nothing else, which is the
 * right answer: nobody works a corner in the backwoods.
 *
 * Pure: it reads the world's districts and answers with plain numbers.
 */
import type { District } from '../world/types.ts';
import { genRng, Subsystem } from '../core/rng.ts';
import { FACTIONS, factionForCulture, hostileTo } from './faction.ts';
import type { Place } from './on-foot.ts';
import { lookOf, type PedestrianLook } from './pedestrian-look.ts';
import { TICKS_PER_HOUR } from './clock.ts';
import type { SimState } from './simulation.ts';

/** Metres of a pitch a player on foot may deal from: the reach of a shop door. */
export const DEALER_REACH = 4;

/** Game ticks a dealer works one corner before moving to the next. */
export const PITCH_TICKS = TICKS_PER_HOUR * 4;

/** Corners one dealer works. */
const PITCHES = 4;

/** Metres from the middle of a district the corners are looked for. */
const PITCH_NEAR = 45;
const PITCH_FAR = 160;

/**
 * Metres from the middle of a district a corner may end up at. A point in a
 * district with no street near it snaps to the nearest road of the district
 * next door, and a dealer whose prices are one district's has to be standing in
 * it. A district that loses every corner this way has no dealer at all.
 */
export const PITCH_LIMIT = 260;

/**
 * The key a dealer's look is drawn on, kept clear of the district ids the
 * pitches use so that two things never read one stream.
 */
const LOOK_KEY = 0x10000;

/** A dealer, as the simulation and the panel read one. */
export interface DealerPlace {
  /** The district they work. The prices of spec section 16.2 are read off it. */
  district: District;
  /** What the panel and the map call them. */
  name: string;
  /** The corners they work, in the order they walk them. */
  pitches: readonly Place[];
}

/**
 * The dealers of a world: one per district that has a street to stand on.
 * `snap` puts a point on the nearest road and answers nothing where there is no
 * road near it; `src/world/surface.ts` is what the game hands in.
 */
export function dealerPlaces(
  seed: number,
  districts: readonly District[],
  snap: (x: number, y: number) => Place | undefined,
): DealerPlace[] {
  const dealers: DealerPlace[] = [];
  for (const district of districts) {
    const rng = genRng(seed, Subsystem.Market, district.id);
    const turn = rng.range(0, Math.PI * 2);
    const pitches: Place[] = [];
    // The corners are spread round the district rather than taken at random, so
    // the walk between them crosses it instead of circling one block.
    for (let i = 0; i < PITCHES; i++) {
      const angle = turn + (i / PITCHES) * Math.PI * 2;
      const away = rng.range(PITCH_NEAR, PITCH_FAR);
      const place = snap(district.x + Math.cos(angle) * away, district.y + Math.sin(angle) * away);
      if (place === undefined) continue;
      if (Math.hypot(place.x - district.x, place.y - district.y) > PITCH_LIMIT) continue;
      pitches.push(place);
    }
    if (pitches.length === 0) continue;
    dealers.push({ district, name: `Dealer · ${district.name}`, pitches: rng.shuffle(pitches) });
  }
  return dealers;
}

/** The corner a dealer is working on a tick. */
export function pitchOf(dealer: DealerPlace, tick: number): Place {
  const spell = Math.floor(Math.max(0, tick) / PITCH_TICKS);
  return dealer.pitches[spell % dealer.pitches.length] as Place;
}

/**
 * The person on the corner, for the crowd mesh to draw (spec section 20.1).
 * They are dressed as the district they work is dressed, which is what makes a
 * dealer a face in their own street rather than a mark on the map.
 */
export function dealerLook(seed: number, dealer: DealerPlace): PedestrianLook {
  return lookOf(dealer.district.zone, genRng(seed, Subsystem.Market, LOOK_KEY + dealer.district.id));
}

/**
 * The dealer the player is standing at, or -1. The nearest one answers, as the
 * shop doors do, and a player driving past a pitch is at it too, so the panel
 * can say why they may not deal.
 */
export function dealerAt(dealers: readonly DealerPlace[], state: SimState): number {
  let at = -1;
  let near = DEALER_REACH;
  for (let i = 0; i < dealers.length; i++) {
    const pitch = pitchOf(dealers[i] as DealerPlace, state.tick);
    const away = Math.hypot(pitch.x - state.player.x, pitch.y - state.player.y);
    if (away > near) continue;
    near = away;
    at = i;
  }
  return at;
}

/**
 * Why a dealer will not trade, in the words the panel shows, or null when they
 * will. A dealer works a street corner: they will not lean into a car, and they
 * are gone before the police the player brought with them arrive.
 *
 * The third reason is the reputation of spec section 17.3: a dealer works their
 * own district, so they answer to whoever runs it, and a player that faction
 * has crossed off does not get served. A dealer in nobody's district serves
 * anybody, which is what keeps the trade open to a player at war with the city.
 */
export function dealRefusal(state: SimState, dealer?: DealerPlace): string | null {
  if (state.player.driving) return 'Not from a vehicle.';
  if (state.heat > 0) return 'Not while the police want you.';
  if (dealer === undefined) return null;
  const faction = factionForCulture(dealer.district.culture);
  if (faction >= 0 && hostileTo(state, faction)) return `Not to you. ${FACTIONS[faction]?.name ?? ''} runs this street.`;
  return null;
}

/**
 * The situational scoring of spec section 15: what the music does when the game
 * stops being a drive and starts being a chase.
 *
 * It reads the record the radio is playing under — the heat of spec section 14,
 * the units that are out and how near the nearest of them is — and answers a
 * mood, how hard it is, and how much of the radio is left under it. Calm leaves
 * the radio alone; a chase lays a pulse over it and pulls it down; a fight
 * takes the radio off altogether, which is the "layered over or replacing"
 * of the spec.
 *
 * Pure, like the rest of the planning half: `radio.ts` is what plays it.
 */
import { heatStars } from '../sim/police/crime.ts';
import type { SimState } from '../sim/simulation.ts';

/** What the scene is, musically. */
export type Mood = 'calm' | 'pursuit' | 'combat';

/** What the score should be doing this frame. */
export interface Score {
  mood: Mood;
  /** How hard it leans, 0 to 1. The stars and the nearest unit decide it. */
  intensity: number;
  /** How much of the radio is left under the score, 0 to 1. */
  radio: number;
}

/** Metres within which a unit is on top of the player, which is what makes it a fight. */
export const CLOSE = 40;

/** Stars at which a chase becomes a fight of its own accord. */
export const COMBAT_STARS = 4;

/** How much of the radio each mood leaves. A fight takes it off. */
export const RADIO_UNDER: Record<Mood, number> = { calm: 1, pursuit: 0.45, combat: 0 };

/** What the music should be doing, given the record. */
export function scoreOf(state: SimState): Score {
  const stars = heatStars(state.heat);
  if (stars <= 0 || state.police.units.length === 0) {
    return { mood: 'calm', intensity: 0, radio: RADIO_UNDER.calm };
  }
  let nearest = Infinity;
  for (const unit of state.police.units) {
    nearest = Math.min(nearest, Math.hypot(unit.x - state.player.x, unit.y - state.player.y));
  }
  // The stars say how much trouble the player is in; the nearest unit says how
  // immediate it is. A helicopter three streets up is a chase; a car on the
  // bumper at four stars is a fight.
  const pressure = Math.max(0, Math.min(1, (CLOSE * 2 - nearest) / (CLOSE * 2)));
  const heat = Math.min(1, stars / 5);
  const mood: Mood = stars >= COMBAT_STARS && nearest <= CLOSE ? 'combat' : 'pursuit';
  return { mood, intensity: Math.max(0.25, Math.min(1, 0.6 * heat + 0.4 * pressure)), radio: RADIO_UNDER[mood] };
}

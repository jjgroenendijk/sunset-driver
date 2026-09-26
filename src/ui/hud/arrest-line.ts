/**
 * What the HUD says about being taken in (spec sections 11.7, 14): the cuffs
 * closing and how to break free of them, the hands up of a player who gave
 * themselves up, and the key that gives up at one or two stars.
 *
 * Pure, so a test reads it without a DOM; `hud.ts` draws it.
 */
import { cuffProgress, maySurrender } from '../../sim/police/arrest.ts';
import type { SimState } from '../../sim/simulation.ts';

/** One line of the arrest, and how far the cuffs are through closing: -1 with no bar to draw. */
export interface ArrestLine {
  text: string;
  progress: number;
}

/** What to show this frame. Empty text where there is nothing to say, which is almost always. */
export function arrestLine(state: SimState): ArrestLine {
  const police = state.police;
  const cuffs = police.cuffs;
  if (cuffs !== null) {
    const progress = cuffProgress(state);
    if (cuffs.yielded) return { text: 'Hands up. Being taken in', progress };
    return { text: `Mash Space to break free  ${cuffs.presses}/${cuffs.need}`, progress };
  }
  if (police.surrendered) return { text: 'Hands up. Waiting for an officer', progress: -1 };
  if (maySurrender(state)) return { text: 'X to give up', progress: -1 };
  return { text: '', progress: -1 };
}

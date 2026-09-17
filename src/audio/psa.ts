/**
 * The radio PSAs of spec section 19: real harm-reduction information, delivered
 * between songs as part of the world's texture.
 *
 * Spec section 19 is plain about the tone: factual, non-judgemental, never a
 * modal, never a lecture, never blocking play. So a PSA here is a line read
 * between two songs on whatever station the player is listening to, shown on
 * the HUD while the station's bed plays under it, and gone in a few seconds.
 * Nothing pauses and nothing waits for the player.
 *
 * Spec section 1.2 forbids audio files, and nothing synthesises a voice, so the
 * line is text. The posters, the clinic and the rest of section 19 are issue
 * #53; this is the radio's share of it.
 */

/** One announcement: what is shown, and who it says it is from. */
export interface Psa {
  /** The line itself, as the HUD shows it. Kept to a line a driver can read. */
  line: string;
  /** Who it is credited to in the world. */
  from: string;
}

/**
 * The announcements, in the order they come round. They are written the way a
 * public health service writes them: what the risk is and what to do about it,
 * with nobody told off.
 */
export const PSAS: readonly Psa[] = [
  {
    line: 'Fentanyl turns up in more than dope now. Test strips are free at the clinic, no name asked.',
    from: 'City Health',
  },
  {
    line: 'Never use alone. If you are on your own, leave the door unlocked and ask someone to check on you.',
    from: 'City Health',
  },
  {
    line: 'Naloxone reverses an opioid overdose. It is free, it needs no prescription, and it keeps in a glovebox.',
    from: 'City Health',
  },
  {
    line: 'Downers stack: opioids, benzos and drink together are what stop the breathing. One at a time, if at all.',
    from: 'City Health',
  },
  {
    line: 'Snoring nobody can wake is not sleep. Roll them on their side, call it in, and stay with them.',
    from: 'City Health',
  },
  {
    line: 'A week clean takes your tolerance down with it. The old dose is what catches people coming back.',
    from: 'City Health',
  },
  {
    line: 'In this city, calling for help at an overdose brings no charge. Make the call.',
    from: 'City Ordinance 14-2',
  },
  {
    line: 'The needle exchange on the boardwalk asks no names and keeps no numbers. Clean works, every day.',
    from: 'Harbour Clinic',
  },
  {
    line: 'Start low and go slow with anything from a new hand. You can always take more; you cannot take less.',
    from: 'City Health',
  },
  {
    line: 'Cocaine and drink make a third thing the heart has to clear. Leave time between them, and water.',
    from: 'City Health',
  },
];

/** The announcement at a place in the round, which wraps. */
export function psaAt(index: number): Psa {
  const at = ((index % PSAS.length) + PSAS.length) % PSAS.length;
  return PSAS[at] as Psa;
}

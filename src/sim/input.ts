/**
 * Per-tick player input. A plain, serialisable record so an input stream can
 * be recorded and replayed to reproduce a session.
 */
export interface InputFrame {
  /** -1..1 forward axis (accelerate/brake or walk). */
  throttle: number;
  /** -1..1 steering axis. */
  steer: number;
  handbrake: boolean;
  horn: boolean;
  sprint: boolean;
  jump: boolean;
  interact: boolean;
  fire: boolean;
  /** Held while aiming rather than firing from the hip (spec section 11.5). */
  aim: boolean;
  /**
   * Whether the pointer stands on the map, and the point it stands on in map
   * metres (spec section 11.5). A shot goes toward it, and `aim.ts` pulls it
   * onto a target near it. Without a pointer a shot goes the way the player
   * faces.
   */
  pointing: boolean;
  pointX: number;
  pointY: number;
  /**
   * Radians above level the shot climbs, and below it where negative. Only the
   * first-person view sets it, from where the view looks; every other view
   * aims level, as the top-down game always has.
   */
  pitch: number;
  /** Reload the weapon in hand (spec section 11.6). */
  reload: boolean;
  /**
   * The step through the weapons carried this tick (spec section 11.6): 1 for
   * the next, -1 for the one before, 0 for none. It is an edge, like
   * {@link InputFrame.station}: one notch of the wheel is one weapon.
   */
  cycle: number;
  /**
   * The turn of the radio dial this tick (spec section 15): 1 for the next
   * station, -1 for the one before, 0 for no turn. It is an edge rather than a
   * level, like {@link InputFrame.travel}, because a held key would run the
   * whole dial round in a fifth of a second.
   */
  station: number;
  /**
   * The metro destination chosen this tick (spec section 13.3): a place in the
   * list of stations a trip may go to, counted from 1, and 0 for no choice. It
   * is a number in the frame rather than a station id, so a recorded stream
   * replays the trip the player picked off the panel they were shown.
   */
  travel: number;
  /**
   * The row of a shop counter bought this tick (spec section 16.1), the row of
   * a safehouse's own panel used this tick (spec section 16.3), and the row of
   * a contact's job board taken this tick (spec section 18): a place in the
   * list on screen, counted from 1, and 0 for no choice. It is the same edge of
   * the same number keys as {@link InputFrame.travel} and for the same reason.
   * No two of the four are ever read at once: a player inside a shop may not
   * take the metro, one standing on their own step is in no shop, and one
   * talking to a contact is on neither.
   */
  buy: number;
  /**
   * The row of a dealer's panel traded this tick (spec section 16.2): the good
   * counted from 1 to buy it, the same number negative to sell it, and 0 for no
   * trade. It is the number keys again, with the sprint key held for a sale,
   * and it is only ever read while a deal is open, which is when neither the
   * metro panel nor a shop counter is.
   */
  trade: number;
  /**
   * Held to give up to the police (spec section 14): the player's hands go up,
   * and at one or two stars the next officer to reach them takes them in for
   * less than an arrest costs (`arrest.ts`).
   */
  surrender: boolean;
}

export const EMPTY_INPUT: Readonly<InputFrame> = Object.freeze({
  throttle: 0,
  steer: 0,
  handbrake: false,
  horn: false,
  sprint: false,
  jump: false,
  interact: false,
  fire: false,
  aim: false,
  pointing: false,
  pointX: 0,
  pointY: 0,
  pitch: 0,
  reload: false,
  cycle: 0,
  station: 0,
  travel: 0,
  buy: 0,
  trade: 0,
  surrender: false,
});

/**
 * Every field of {@link InputFrame}, in the order the interface declares them.
 * {@link inputEquals} walks this list rather than naming the fields itself, and
 * the checks below fail to compile when the list and the interface disagree, so
 * a field added to the frame cannot be left out of the comparison again.
 */
export const INPUT_FIELDS = [
  'throttle',
  'steer',
  'handbrake',
  'horn',
  'sprint',
  'jump',
  'interact',
  'fire',
  'aim',
  'pointing',
  'pointX',
  'pointY',
  'pitch',
  'reload',
  'cycle',
  'station',
  'travel',
  'buy',
  'trade',
  'surrender',
] as const satisfies readonly (keyof InputFrame)[];

/** `never` unless a field of `InputFrame` is missing from {@link INPUT_FIELDS}. */
type UnlistedField = Exclude<keyof InputFrame, (typeof INPUT_FIELDS)[number]>;

/**
 * The compile error when a field is missing: `UnlistedField` is then the name
 * of that field, which does not satisfy the `never` this alias demands.
 */
type EveryFieldListed<T extends never> = T;
/** @public */
export type _EveryInputFieldListed = EveryFieldListed<UnlistedField>;

/** Whether two frames hold the same input, field for field. */
export function inputEquals(a: InputFrame, b: InputFrame): boolean {
  for (const field of INPUT_FIELDS) {
    if (a[field] !== b[field]) return false;
  }
  return true;
}

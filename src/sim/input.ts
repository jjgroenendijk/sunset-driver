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
  reload: false,
  cycle: 0,
  station: 0,
  travel: 0,
  buy: 0,
  trade: 0,
});

export function inputEquals(a: InputFrame, b: InputFrame): boolean {
  return (
    a.throttle === b.throttle &&
    a.steer === b.steer &&
    a.handbrake === b.handbrake &&
    a.horn === b.horn &&
    a.sprint === b.sprint &&
    a.jump === b.jump &&
    a.interact === b.interact &&
    a.fire === b.fire &&
    a.aim === b.aim &&
    a.pointing === b.pointing &&
    a.pointX === b.pointX &&
    a.pointY === b.pointY &&
    a.reload === b.reload &&
    a.cycle === b.cycle &&
    a.station === b.station &&
    a.travel === b.travel
  );
}

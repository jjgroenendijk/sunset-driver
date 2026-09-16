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
  /** Reload the weapon in hand (spec section 11.6). */
  reload: boolean;
  /** Take the next weapon carried (spec section 11.6). */
  cycle: boolean;
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
  reload: false,
  cycle: false,
  station: 0,
  travel: 0,
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
    a.reload === b.reload &&
    a.cycle === b.cycle &&
    a.station === b.station &&
    a.travel === b.travel
  );
}

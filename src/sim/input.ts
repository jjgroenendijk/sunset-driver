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
    a.fire === b.fire
  );
}

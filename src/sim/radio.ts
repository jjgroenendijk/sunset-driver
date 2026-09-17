/**
 * The radio dial, as the record carries it (spec section 15).
 *
 * The rule is the whole of the simulation's share of the radio: a player behind
 * a wheel may turn the dial, and where it stands belongs to the vehicle, so a
 * car keeps its station and a stolen one comes with its owner's. What is on
 * each position, and how many there are, is `src/audio/dial.ts`: the simulation
 * moves a number and never reads it back.
 */
import type { InputFrame } from './input.ts';
import type { SimState } from './simulation.ts';

/** Turn the dial by what the input frame asked for, if anybody is at the wheel. */
export function stepRadio(state: SimState, input: InputFrame): void {
  if (input.station === 0 || !state.player.driving) return;
  state.vehicle.station += Math.sign(input.station);
}

/**
 * The leaves of a vehicle that open, as the record carries them: four doors
 * and the bonnet. `doors.ts` swings them; this file holds only the record, so
 * `vehicle.ts` can build it without importing what steps it.
 */

/** The leaves, by index: the driver's front door, the other front door, the rear doors behind them, the bonnet. */
export const LEAVES = 5;
export const BONNET_LEAF = 4;

/** How far each leaf stands open, from 0 shut to 1 open, and which are wanted open. */
export interface LeafState {
  open: number[];
  want: boolean[];
}

/** Every leaf shut. */
export function createLeafState(): LeafState {
  return { open: new Array<number>(LEAVES).fill(0), want: new Array<boolean>(LEAVES).fill(false) };
}

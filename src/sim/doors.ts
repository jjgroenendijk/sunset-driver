/**
 * The doors and the bonnet of a vehicle (spec section 11.3).
 *
 * A vehicle has five leaves that open: four doors and the bonnet. The record
 * carries how far each one stands open, from 0 shut to 1 open, and which ones
 * somebody wants open. A leaf swings toward what is wanted of it a step a
 * tick, so it is drawn opening rather than jumping open.
 *
 * Three things open a leaf. The player's key lifts and drops the bonnet of the
 * car they are in or stand beside. A workshop lifts it for as long as the
 * player is inside (spec section 16.1). A hard hit leaves the panel it landed
 * on hanging ajar until it is repaired or torn off (`damage.ts`). The boarding
 * move opens the door the player goes through, but that door is drawn from
 * the move itself (`render/boarding.ts`) and is not in the record.
 *
 * A class with no door at a leaf simply has nothing there to draw.
 */
import { hypot } from '../core/libm.ts';
import { PANELS } from './damage.ts';
import type { InputFrame } from './input.ts';
import { BONNET_LEAF, LEAVES } from './leaves.ts';
import type { SimState } from './simulation.ts';
import { specOf, type VehicleState } from './vehicle.ts';

/** Ticks a leaf takes to swing from shut to all the way open. */
export const LEAF_TICKS = 24;

/** How far open a panel hangs once a hit has sprung it. */
export const AJAR = 0.2;

/** Metres past the end of the body the player may stand and still reach the bonnet. */
const BONNET_REACH = 1.6;

/**
 * The panel of {@link PANELS} each leaf hangs on: the bonnet on the front,
 * each door on its own flank. The driver sits on the right-hand flank.
 */
const PANEL_OF: readonly (typeof PANELS)[number][] = ['right', 'left', 'right', 'left', 'front'];

/** How far open a leaf is heading: all the way when wanted, ajar when sprung, shut otherwise. */
export function leafTarget(v: VehicleState, leaf: number, workshop = false): number {
  if (v.leaves.want[leaf] === true || (leaf === BONNET_LEAF && workshop)) return 1;
  const panel = PANELS.indexOf(PANEL_OF[leaf] as (typeof PANELS)[number]);
  // A hit springs the front door of a flank, never the rear one: the front is
  // the one the flank's dent is drawn round.
  const front = leaf === BONNET_LEAF || leaf < 2;
  return front && v.damage.ajar[panel] === true ? AJAR : 0;
}

/** Swing every leaf of a vehicle one tick toward where it is heading. */
export function stepLeaves(v: VehicleState, workshop = false): void {
  const rate = 1 / LEAF_TICKS;
  for (let leaf = 0; leaf < LEAVES; leaf++) {
    const target = leafTarget(v, leaf, workshop);
    const open = v.leaves.open[leaf] ?? 0;
    // A leaf within a step of where it is heading lands on it exactly, so
    // sums of the step never leave it a hair short of shut.
    if (Math.abs(target - open) <= rate + 1e-9) v.leaves.open[leaf] = target;
    else v.leaves.open[leaf] = open < target ? open + rate : open - rate;
  }
}

/**
 * Step the player's vehicle's leaves for one tick. The bonnet key acts once a
 * press, from the seat or from beside the car; `workshop` is true while the
 * player is inside a workshop, whose mechanics have the bonnet up.
 */
export function stepDoors(state: SimState, input: InputFrame, workshop: boolean): void {
  const p = state.player;
  const pressed = input.bonnet && !p.held.bonnet;
  p.held.bonnet = input.bonnet;
  const v = state.vehicle;
  if (pressed && (p.driving || hypot(p.x - v.x, p.y - v.z) <= specOf(v.cls).halfLength + BONNET_REACH)) {
    v.leaves.want[BONNET_LEAF] = !(v.leaves.want[BONNET_LEAF] ?? false);
  }
  stepLeaves(v, workshop);
}

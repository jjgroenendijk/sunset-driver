/**
 * The fire engines and the ambulances near the player, as Rapier bodies (spec
 * section 20.3).
 *
 * A unit is a kinematic box moved to where the record says it is, as a police
 * car is (`police-bodies.ts`): the player's car hits an engine standing across
 * a street as a wall, and no crash pushes it off the route it is driving. Each
 * kind is the size `UNIT_BODY` gives it, so an engine blocks more of the road
 * than an ambulance does.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { UNIT_BODY, type EmergencyUnit } from './emergency.ts';
import { CarBodies } from './police-bodies.ts';

export class EmergencyBodies extends CarBodies<EmergencyUnit> {
  constructor(world: RAPIER.World) {
    super(world, (state) => state.emergency.units, (unit) => UNIT_BODY[unit.kind]);
  }
}

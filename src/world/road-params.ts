/**
 * The numbers the road network is traced by: how each tier steps along the
 * field, and how far apart the plan in `roads.ts` lays its roads.
 */
import { TIERS } from './tiers.ts';

/** Metres of highway before it may merge into another one; both cross at the core. */
export const HIGHWAY_MERGE_AFTER = 400;
/**
 * Metres between the interchanges of a highway. A highway takes a junction
 * only at one of them (spec section 6.2), so this is how far apart the ramps
 * on and off it stand.
 */
export const INTERCHANGE_SPACING = 700;
/** Fractions of a highway's length where a branch highway leaves it. */
export const BRANCH_AT = [0.3, 0.7];
/** A highway shorter than this fraction of the map is not worth keeping. */
export const MIN_HIGHWAY = 0.25;
/** Metres from a road within which a district counts as already served. */
export const SERVED = 130;
/** Spacing between arterials, as a fraction of the world side. */
export const ARTERIAL_SPACING = 0.05;
/** How many arterials deep the fill grows from the highways, and how many it may lay in all. */
export const FILL_GENERATIONS = 4;
export const FILL_LIMIT = 400;
/** How many streets deep the minor fill grows, and how many curves it may lay in all. */
export const MINOR_GENERATIONS = 6;
export const MINOR_LIMIT = 3000;
/** How much of a spacing a road may run past its seed without meeting another road. */
export const DEAD_END_SPACINGS = 1.2;
/** Density a district needs before its blocks are cut through by alleys. */
export const ALLEY_DENSITY = 0.5;
/** Steps an arterial must run before it may merge into a road other than its parent. */
export const MIN_MERGE_STEPS = 4;
/** Metres a bridge head may be moved inland from the crossing's shore point. */
export const ANCHOR_REACH = 100;
/** Metres of boardwalk that have to survive the ground before the street is worth laying. */
export const MIN_BOARDWALK = 120;
/** How each tier traces. */
export interface TierParams {
  /** Metres per traced step. */
  step: number;
  /** Radians the heading may turn in one step. */
  maxTurn: number;
  /** How much of the field's deflection from the bearing a guided trace keeps, in [0, 1]. */
  fieldWeight: number;
  /** Metres within which the trace joins a road that is already there. */
  mergeRadius: number;
  /** Longest curve, as a fraction of the world side. */
  maxLength: number;
  /** Steepest grade a step may climb; the tier table owns the number. */
  maxGrade: number;
}

export const HIGHWAY: TierParams = { step: 30, maxTurn: 0.09, fieldWeight: 1, mergeRadius: 110, maxLength: 1.3, maxGrade: TIERS.highway.maxGrade };
export const ARTERIAL: TierParams = { step: 22, maxTurn: 0.17, fieldWeight: 0.75, mergeRadius: 80, maxLength: 0.8, maxGrade: TIERS.arterial.maxGrade };
export const STREET: TierParams = { step: 14, maxTurn: 0.22, fieldWeight: 0.8, mergeRadius: 26, maxLength: 0.35, maxGrade: TIERS.street.maxGrade };
export const ALLEY: TierParams = { step: 10, maxTurn: 0.3, fieldWeight: 0.8, mergeRadius: 18, maxLength: 0.06, maxGrade: TIERS.alley.maxGrade };
export const DIRT: TierParams = { step: 26, maxTurn: 0.2, fieldWeight: 0.9, mergeRadius: 55, maxLength: 0.5, maxGrade: TIERS.dirt.maxGrade };

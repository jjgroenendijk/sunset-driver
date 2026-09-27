/**
 * Friendly fire on the wire (spec section 21.5): a round one player put into
 * another, sent to the one it went into.
 *
 * The shooter's physics finds the hit (`peer-bodies.ts`) and does not apply
 * it. Each peer has the final word on its own health and its own vehicle
 * (spec section 21.4), so the hit crosses the wire as a one-shot message and
 * the owner applies it with `takeRound`, at the top of its next frame.
 *
 * The message names the weapon and the way the round was flying, never the
 * damage: the owner reads what the round is worth from its own arsenal, so a
 * peer can claim a hit but not a size of hit.
 */
import { WEAPON_IDS, type WeaponId } from '../sim/weapons/weapon.ts';

/** One round, as it crosses the wire. */
export interface Hit {
  weapon: WeaponId;
  part: 'person' | 'vehicle';
  /** The way the round was flying, in world axes, as a unit vector. */
  dx: number;
  dh: number;
  dy: number;
}

/** A hit as sent, or null where what arrived is not one. */
export function readHit(value: unknown): Hit | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as Record<string, unknown>;
  const weapon = WEAPON_IDS.find((id) => id === body.weapon);
  if (weapon === undefined) return null;
  if (body.part !== 'person' && body.part !== 'vehicle') return null;
  const { dx, dh, dy } = body;
  if (typeof dx !== 'number' || typeof dh !== 'number' || typeof dy !== 'number') return null;
  const length = Math.hypot(dx, dh, dy);
  // A direction that is no direction, or not a number, is no hit.
  if (!Number.isFinite(length) || length < 1e-6) return null;
  return { weapon, part: body.part, dx: dx / length, dh: dh / length, dy: dy / length };
}

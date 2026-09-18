/**
 * What crosses the wire at the handshake and on the shared clock of spec
 * section 21.4, and what a peer is allowed to say.
 *
 * Everything here arrives from another browser, so nothing is trusted: a
 * message is read into a shape or refused. A peer that sends a different seed,
 * or a protocol this build does not speak, is turned away at the handshake
 * rather than left to drift in a city nobody else is in (spec section 21.2,
 * point 3).
 */

/** The name Trystero namespaces the signalling under. Another game's rooms are never these rooms. */
export const APP_ID = 'sunset-driver';

/**
 * The version of what is written below. It goes up whenever a message changes
 * shape, because two builds that read the same field differently would diverge
 * quietly, which is the one failure the shared clock cannot show.
 */
export const PROTOCOL = 1;

/** The kinds of message this issue's scope carries. Each is one Trystero action. */
export const MESSAGE_KINDS = ['hello', 'tick'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** The first thing either side says: who it is, which city it is in, and what time it is there. */
export interface Hello {
  protocol: number;
  seed: string;
  /** The sender's tick when it spoke. A joiner locks to the host's (spec section 21.4). */
  tick: number;
  /** Whether the sender opened the room. Exactly one peer of a room says true. */
  host: boolean;
}

/** Why a peer was turned away. The player is told in these words, so they are few. */
export type Refusal = 'protocol' | 'seed';

/** A whole number that is not `NaN` and not an infinity: every tick that crosses the wire is one. */
function readTick(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A `hello` as sent, or null where what arrived is not one. */
export function readHello(value: unknown): Hello | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as Record<string, unknown>;
  const tick = readTick(body.tick);
  if (typeof body.protocol !== 'number' || typeof body.seed !== 'string') return null;
  if (tick === null || typeof body.host !== 'boolean') return null;
  return { protocol: body.protocol, seed: body.seed, tick, host: body.host };
}

/** The tick of a beat as sent, or null where what arrived is not one. */
export function readBeat(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  return readTick((value as Record<string, unknown>).tick);
}

/** Why this peer may not play here, or null where it may. */
export function refuse(hello: Hello, seed: string): Refusal | null {
  if (hello.protocol !== PROTOCOL) return 'protocol';
  if (hello.seed !== seed) return 'seed';
  return null;
}

/** What the player is told about a peer that was turned away. */
export function refusalText(why: Refusal): string {
  return why === 'seed'
    ? 'A player tried to join from another city. Two players are never in different cities.'
    : 'A player tried to join from another version of the game.';
}

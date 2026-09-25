/**
 * What the host owns, and how it reaches everybody else (spec section 21.4).
 *
 * Peers compute the world themselves from the shared seed and the shared tick,
 * so the network carries only what cannot be derived. That is the divergence
 * set: the ambient cars that have left their trajectories, the people who have
 * left their loops, the wrecks that are burning, the police and the emergency
 * units that are out, the enforcers a faction has sent, the street crime that
 * has been settled, and the blocks a session has taken. Everything else in a
 * record is a function of `(seed, tick)` and never crosses the wire.
 *
 * A career does not cross it either. Spec section 21.3 keeps money, missions,
 * reputation and progress to the player who earned them, so the record's own
 * player, vehicle, loadout, missions and faction standing stay where they are.
 * Territory is the one exception the spec names: the captures are the session's
 * shared map, owned by the host and written to nobody's save.
 *
 * Two things go out, both from {@link WorldSender}:
 *
 * - **Deltas.** Every {@link DELTA_TICKS} the host looks at each part of the
 *   set and sends the ones that changed, at most {@link PARTS_PER_DELTA} of
 *   them, taking the parts in turn so none is starved. That is the cap of spec
 *   section 21.5: the host's broadcast load does not grow with how busy the
 *   city gets.
 * - **Correction snapshots.** Every {@link SNAPSHOT_TICKS} the whole set goes
 *   out whatever changed, so a peer that lost a delta is put right within ten
 *   seconds rather than drifting until it leaves. It is cheap because the
 *   deterministic majority of the world is never in it.
 *
 * Nothing arriving is trusted. A part is refused unless it is the shape that
 * part of a record has, and it is copied through JSON before it is written, so
 * what lands in the record is plain data and nothing else.
 */
import type { SimState } from '../sim/simulation.ts';

/** The parts of a record the host owns. Everything else is derived or a career. */
const DIVERGENCE_KEYS = [
  'traffic',
  'pedestrians',
  'fires',
  'emergency',
  'police',
  'enforcers',
  'crimes',
  'captured',
] as const;

export type DivergenceKey = (typeof DIVERGENCE_KEYS)[number];

/** Ticks between two deltas: five a second. */
export const DELTA_TICKS = 12;

/** Parts one delta carries at most, which is what caps the host's broadcast load. */
export const PARTS_PER_DELTA = 4;

/** Ticks between two correction snapshots: ten seconds. */
export const SNAPSHOT_TICKS = 600;

/** What crosses the wire: the parts that changed, or the whole set as a correction. */
export interface WorldUpdate {
  /** The host's tick when it was taken, which is what the receiver notes it against. */
  tick: number;
  /** True for a correction snapshot, false for a delta. */
  full: boolean;
  parts: Partial<Record<DivergenceKey, unknown>>;
}

/** The part of a record a key names. */
function partOf(state: SimState, key: DivergenceKey): unknown {
  if (key === 'captured') return state.factions.captured;
  return state[key];
}

/**
 * Whether a part is the shape that part of a record has. It is the top level
 * only: the host is trusted to describe its own world, and this is what keeps a
 * malformed or hostile peer from writing something into the record that the
 * simulation would then step.
 */
const SHAPES: Record<DivergenceKey, (value: unknown) => boolean> = {
  traffic: (v) => list(v, 'promoted'),
  pedestrians: (v) => list(v, 'startled') && list(v, 'casualties'),
  fires: (v) => list(v, 'blazes') && count(v, 'nextBlaze'),
  emergency: (v) =>
    list(v, 'units') &&
    list(v, 'calls') &&
    list(v, 'crew') &&
    list(v, 'fallen') &&
    count(v, 'nextUnit') &&
    count(v, 'nextCall') &&
    count(v, 'nextCrew') &&
    count(v, 'dispatchTick'),
  police: (v) => list(v, 'units') && count(v, 'nextUnit') && count(v, 'seenTick') && count(v, 'dispatchTick'),
  enforcers: (v) => list(v, 'units') && count(v, 'nextUnit') && count(v, 'sentTick'),
  crimes: (v) => list(v, 'settled'),
  captured: (v) => Array.isArray(v) && v.every((block) => typeof block === 'number' && Number.isFinite(block)),
};

function fields(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown, name: string): boolean {
  return Array.isArray(fields(value)?.[name]);
}

function count(value: unknown, name: string): boolean {
  const at = fields(value)?.[name];
  return typeof at === 'number' && Number.isFinite(at);
}

/** An update as it arrived, or null where what arrived is not one. */
export function readWorld(value: unknown): WorldUpdate | null {
  const body = fields(value);
  if (body === null) return null;
  const tick = body.tick;
  const sent = fields(body.parts);
  if (typeof tick !== 'number' || !Number.isSafeInteger(tick) || tick < 0) return null;
  if (typeof body.full !== 'boolean' || sent === null) return null;
  const parts: Partial<Record<DivergenceKey, unknown>> = {};
  let held = 0;
  for (const key of DIVERGENCE_KEYS) {
    const part = sent[key];
    if (part === undefined || !SHAPES[key](part)) continue;
    parts[key] = part;
    held += 1;
  }
  return held === 0 ? null : { tick, full: body.full, parts };
}

/**
 * Write an update into the record. The parts are copied through JSON, so what
 * the record ends up holding is plain data of its own rather than an object
 * another browser's message still points at.
 */
export function applyWorld(state: SimState, update: WorldUpdate): void {
  for (const key of DIVERGENCE_KEYS) {
    const part = update.parts[key];
    if (part === undefined) continue;
    const copy = plain(part);
    if (copy === null) continue;
    if (key === 'captured') state.factions.captured = copy as number[];
    else if (key === 'traffic' || key === 'pedestrians') {
      // Who gives way to whom is each peer's own, round its own player.
      Object.assign(state, { [key]: { ...(copy as object), held: state[key].held } });
    } else Object.assign(state, { [key]: copy });
  }
}

/** A part copied through JSON, or null where it will not go through it. */
function plain(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return null;
  }
}

/**
 * The host's side: what to send this tick, and nothing until one is due. It
 * keeps the text of each part as it last went out, which is both how a change
 * is noticed and what makes the comparison cheap.
 */
export class WorldSender {
  /** Each part as it last went out, so a part that did not change is not sent again. */
  private readonly sent = new Map<DivergenceKey, string>();
  private lastDelta: number;
  private lastSnapshot: number;
  /** Where the round of parts starts next, so a delta that is full does not starve the rest. */
  private next = 0;
  /** Whether the next update owed is a correction whatever the period says. */
  private forced = false;

  constructor(tick: number) {
    this.lastDelta = tick;
    // The first snapshot goes out a whole period after the room opens: until
    // then every part is new, so the deltas carry the whole set anyway.
    this.lastSnapshot = tick;
  }

  /**
   * Make the next update a correction snapshot. A peer that has just taken the
   * room over calls it, so the rest of the room is put on the world it holds
   * rather than waiting out the period (spec section 21.4).
   */
  correct(): void {
    this.forced = true;
  }

  /** The update owed at this tick, or null while none is. */
  due(state: SimState, tick: number): WorldUpdate | null {
    if (this.forced || tick - this.lastSnapshot >= SNAPSHOT_TICKS) {
      this.forced = false;
      this.lastSnapshot = tick;
      this.lastDelta = tick;
      return this.snapshot(state, tick);
    }
    if (tick - this.lastDelta < DELTA_TICKS) return null;
    this.lastDelta = tick;
    return this.delta(state, tick);
  }

  /** Every part, whatever changed: the correction of spec section 21.4. */
  private snapshot(state: SimState, tick: number): WorldUpdate {
    const parts: Partial<Record<DivergenceKey, unknown>> = {};
    for (const key of DIVERGENCE_KEYS) {
      const part = partOf(state, key);
      this.sent.set(key, JSON.stringify(part));
      parts[key] = part;
    }
    return { tick, full: true, parts };
  }

  /** The parts that changed, capped, taking the parts in turn. */
  private delta(state: SimState, tick: number): WorldUpdate | null {
    const parts: Partial<Record<DivergenceKey, unknown>> = {};
    let held = 0;
    // Where the round starts is read once: moving it inside the loop would
    // step over the part after each one taken.
    const start = this.next;
    for (let i = 0; i < DIVERGENCE_KEYS.length && held < PARTS_PER_DELTA; i++) {
      const at = (start + i) % DIVERGENCE_KEYS.length;
      const key = DIVERGENCE_KEYS[at] as DivergenceKey;
      const part = partOf(state, key);
      const text = JSON.stringify(part);
      if (text === this.sent.get(key)) continue;
      this.sent.set(key, text);
      parts[key] = part;
      held += 1;
      this.next = (at + 1) % DIVERGENCE_KEYS.length;
    }
    return held === 0 ? null : { tick, full: false, parts };
  }
}

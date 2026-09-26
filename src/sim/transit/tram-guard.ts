/**
 * Traffic that waits while a tram crosses its path (spec sections 13.1, 13.2).
 *
 * The tram goes through a junction with lights on the green of the road it
 * runs down. The traffic across is held on red, but the traffic on the same
 * green is not: a vehicle from the other way that turns across the track, or
 * one beside the tram when the tram turns across its lane, drove through the
 * tram (issue #301).
 *
 * Every tram drives the same timing, a whole number of signal cycles behind
 * the one before, and that timing takes whole cycles too. So the ticks of the
 * cycle a tram is in a junction are the same on every lap of every tram: one
 * window per pass of the loop through the junction. A movement the tram's path
 * crosses is held for that window on every cycle, whether or not a tram comes
 * on that one. That keeps the traffic a function of the tick, as the lights
 * are, and costs a turning vehicle at most one window of its green.
 *
 * Which movements the tram crosses depends on how both turn. The track is the
 * right half of the reserved lane in the middle of the road, so the tram is
 * the innermost vehicle of its direction:
 *
 * - A vehicle that turns left or turns back crosses the tram whatever it does.
 * - A vehicle beside the tram that turns right swings its tail into the track.
 * - A tram that turns left crosses the traffic coming straight the other way.
 * - A tram that turns right crosses every lane beside it.
 * - The roads across are held on red already; they are held here too, so the
 *   clearance before and after a window counts for them as well.
 */
import { atan2 } from '../../core/libm.ts';
import { TICK_RATE } from '../clock.ts';
import { SIGNAL_CYCLE, STOP_BACK, type SignalApproach, type SignalJunction, type TrafficSignals } from '../traffic/signals.ts';
import type { Tour } from '../traffic/traffic-timing.ts';
import type { TramMotion } from './tram-motion.ts';
import { TRAM_LENGTH } from './tram.ts';
import { timeTram } from './tram-timing.ts';
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import type { TramDescription } from '../../world/types.ts';

/** Ticks before the tram's nose reaches the junction that a crossing vehicle has to be over its line by. */
const GUARD_BEFORE = 3 * TICK_RATE;
/** Ticks after the tram's tail has left the junction before a crossing vehicle may cross its line. */
const GUARD_AFTER = 1 * TICK_RATE;

/** How a movement through a junction turns. `back` is a U-turn. */
type Turn = 'straight' | 'left' | 'right' | 'back';

/** One pass of the loop through a junction with lights. */
interface TramPass {
  /** The edge the tram arrives on. */
  edge: number;
  axis: 0 | 1;
  turn: Turn;
  /** The tick of the signal cycle the window opens on. */
  start: number;
  /** Ticks the window lasts. */
  length: number;
}

/**
 * The guard of a world's tram line, timed as `TramLine` times it; undefined
 * where no tram runs or no light stands.
 */
export function tramGuardOf(graph: RoadGraph, signals: TrafficSignals | undefined, tram: Pick<TramDescription, 'edges' | 'stops' | 'crossings'> | undefined): TramGuard | undefined {
  if (signals === undefined || tram === undefined || tram.edges.length < 2 || tram.stops.length === 0) return undefined;
  const crossings = tram.crossings.map((crossing) => crossing.node);
  const timing = timeTram(graph, tram.edges, TRAM_LENGTH, tram.stops, crossings, signals);
  return new TramGuard(graph, signals, timing.tour, timing.motion, TRAM_LENGTH);
}

export class TramGuard {
  /** The passes through each junction, by index into {@link TrafficSignals.junctions}. */
  private readonly passes: TramPass[][];
  /** The heading of the traffic leaving along each edge, NaN until it is read. */
  private readonly leaving: Float64Array;
  /** 1 on each edge that arrives at a junction some tram passes through. */
  private readonly guarded: Uint8Array;
  /** The windows of each movement once read, keyed by its two edges. */
  private readonly known = new Map<number, Int32Array>();
  private readonly graph: RoadGraph;
  private readonly signals: TrafficSignals;

  /** `tour` and `motion` are the tram's loop as `tram-timing.ts` times it, for a tram `length` metres long. */
  constructor(graph: RoadGraph, signals: TrafficSignals, tour: Tour, motion: TramMotion, length: number) {
    this.graph = graph;
    this.signals = signals;
    this.leaving = new Float64Array(graph.edges.length).fill(Number.NaN);
    this.passes = signals.junctions.map(() => []);
    const count = tour.edges.length;
    for (let i = 0; i < count; i++) {
      const edge = graph.edges[tour.edges[i] as number] as RoadEdge;
      const approach = signals.approachOf(edge.id);
      if (approach === undefined) continue;
      const next = graph.edges[tour.edges[(i + 1) % count] as number] as RoadEdge;
      const cutIn = edge.length - approach.stop - STOP_BACK;
      const back = next.twin < 0 ? undefined : signals.approachOf(next.twin);
      const cutOut = back === undefined ? cutIn : (graph.edges[back.edge] as RoadEdge).length - back.stop - STOP_BACK;
      const enter = motion.tickAt((tour.startDistance[i] as number) + edge.length - cutIn);
      const exit = motion.tickAt((tour.startDistance[i] as number) + edge.length + cutOut + length);
      const inside = mod(exit - enter, tour.period);
      (this.passes[approach.junction] as TramPass[]).push({
        edge: edge.id,
        axis: approach.axis,
        turn: turnOf(approach.heading, this.headingOut(next.id)),
        start: mod(tour.sync + enter - GUARD_BEFORE, SIGNAL_CYCLE),
        length: Math.min(SIGNAL_CYCLE, inside + GUARD_BEFORE + GUARD_AFTER),
      });
    }
    this.guarded = new Uint8Array(graph.edges.length);
    for (let j = 0; j < signals.junctions.length; j++) {
      if ((this.passes[j] as TramPass[]).length === 0) continue;
      for (const a of (signals.junctions[j] as SignalJunction).approaches) this.guarded[(signals.approaches[a] as SignalApproach).edge] = 1;
    }
  }

  /** True where some tram crosses the junction a vehicle arriving on `edge` meets. */
  guards(edge: number): boolean {
    return this.guarded[edge] === 1;
  }

  /**
   * True when a vehicle that crosses the line of `edge` on its way to `next`
   * on any tick from `tick` to `tick + ahead` would meet a tram in the junction.
   */
  blocks(edge: number, next: number, tick: number, ahead = 0): boolean {
    if (this.guarded[edge] !== 1) return false;
    const windows = this.windows(edge, next);
    for (let w = 0; w < windows.length; w += 2) {
      const into = mod(tick - (windows[w] as number), SIGNAL_CYCLE);
      if (into < (windows[w + 1] as number) || into + ahead >= SIGNAL_CYCLE) return true;
    }
    return false;
  }

  /**
   * The windows that hold a vehicle from `edge` to `next`, as pairs: the tick
   * of the cycle each opens on, and the ticks it lasts. Empty for a movement
   * no tram crosses.
   */
  windows(edge: number, next: number): Int32Array {
    const key = edge * this.graph.edges.length + next;
    const known = this.known.get(key);
    if (known !== undefined) return known;
    const approach = this.signals.approachOf(edge);
    const found: number[] = [];
    if (approach !== undefined) {
      for (const pass of this.passes[approach.junction] as TramPass[]) {
        if (this.crosses(pass, approach, next)) found.push(pass.start, pass.length);
      }
    }
    const windows = Int32Array.from(found);
    this.known.set(key, windows);
    return windows;
  }

  /** True when a vehicle from `approach` to `next` crosses the path of a tram's pass. */
  private crosses(pass: TramPass, approach: SignalApproach, next: number): boolean {
    if (approach.axis !== pass.axis) return true;
    const turn = turnOf(approach.heading, this.headingOut(next));
    if (turn === 'left' || turn === 'back') return true;
    const beside = approach.edge === pass.edge;
    if (beside) return turn === 'right' || pass.turn === 'right' || pass.turn === 'back';
    return turn === 'straight' && (pass.turn === 'left' || pass.turn === 'back');
  }

  /** The heading of the traffic that leaves a junction along an edge. */
  private headingOut(edge: number): number {
    const known = this.leaving[edge] as number;
    if (!Number.isNaN(known)) return known;
    const run = this.graph.edges[edge] as RoadEdge;
    const back = run.twin < 0 ? undefined : this.signals.approachOf(run.twin);
    let heading: number;
    if (back !== undefined) heading = wrap(back.heading + Math.PI);
    else {
      const points = this.graph.edgePoints(edge);
      const a = points[0];
      const b = points[1] ?? a;
      heading = a === undefined || b === undefined ? 0 : atan2(b.y - a.y, b.x - a.x);
    }
    this.leaving[edge] = heading;
    return heading;
  }
}

/**
 * How a movement turns, from the heading it arrives on to the one it leaves
 * on. The right hand of travel is a quarter turn anticlockwise of the heading
 * on the map (`route-sample.ts`), so a turn that grows the heading is a turn
 * to the right.
 */
function turnOf(arrive: number, leave: number): Turn {
  const d = wrap(leave - arrive);
  if (Math.abs(d) < Math.PI / 4) return 'straight';
  if (Math.abs(d) > (3 * Math.PI) / 4) return 'back';
  return d > 0 ? 'right' : 'left';
}

/** An angle in radians brought into -π to π. */
function wrap(angle: number): number {
  return mod(angle + Math.PI, 2 * Math.PI) - Math.PI;
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

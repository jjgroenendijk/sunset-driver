/**
 * The traffic lights of the city (spec section 13.1).
 *
 * Every junction where an arterial meets other roads on the ground carries a
 * signal. The roads into it fall into two axes, the one the arterial arrives
 * on and the one across it, and the axes take turns: green, amber, then a
 * moment where both are red so the junction clears. The arterial carries the
 * most traffic, so its axis has the longer green. The whole cycle is
 * {@link SIGNAL_CYCLE} ticks at every junction, shifted by an offset each
 * junction draws from the seed, so the lights of one street do not all change
 * on one tick.
 *
 * A light is a function of the tick alone. Nothing here is stepped or stored,
 * so a replay, a save and a vehicle evaluated far in the future all read the
 * same colour. A highway takes no signal of its own: it meets other roads only
 * at interchanges.
 *
 * A level crossing of the tram (spec section 13.2) always takes a signal, even
 * where only an alley joins the arterial, and even where an arterial meets a
 * highway at an interchange. The tram crosses on the green of the road it runs
 * down, so the light is what holds the crossing traffic while it passes. A
 * crossing without one is a crossing nobody obeys: the tram halts and rings,
 * and the traffic across it drives on (issue #302).
 */
import { hashInts } from '../core/hash.ts';
import { rngFor, Subsystem } from '../core/rng.ts';
import { atan2, cos } from '../core/libm.ts';
import type { RoadGraph, RoadEdge } from '../world/graph.ts';
import type { JunctionMap } from '../world/junctions.ts';
import { TIERS } from '../world/tiers.ts';
import type { RoadCurve, RoadTier } from '../world/types.ts';
import { TICK_RATE } from './clock.ts';

/** Ticks each axis is green: the arterial's axis, then the one across it. */
export const SIGNAL_GREEN: readonly [number, number] = [24 * TICK_RATE, 12 * TICK_RATE];
/** Ticks each axis is amber after its green. */
export const SIGNAL_AMBER = 3 * TICK_RATE;
/** Ticks both axes are red after an amber, so a vehicle still in the junction clears it. */
export const SIGNAL_CLEAR = 2 * TICK_RATE;
/** Ticks of one whole cycle: both axes, each green, amber and clear. */
export const SIGNAL_CYCLE = SIGNAL_GREEN[0] + SIGNAL_GREEN[1] + 2 * (SIGNAL_AMBER + SIGNAL_CLEAR);

/** The tick of the cycle each axis's green starts on. */
const GREEN_START: readonly [number, number] = [0, SIGNAL_GREEN[0] + SIGNAL_AMBER + SIGNAL_CLEAR];

/**
 * Metres before the stop line the middle of a stopped vehicle stands: half a
 * long car and a gap.
 */
export const STOP_BACK = 3.5;

/** Metres of road an approach needs before its stop line to take a signal at all. */
const MIN_APPROACH = 4;

/** Cosine of the widest angle a road may make with the axis and still be on it. */
const ON_AXIS = cos(Math.PI / 4);

/** The tiers a road across an arterial has to be for the junction to take a light. */
const SIGNALLED_CROSS: readonly RoadTier[] = ['arterial', 'street'];

/** The stream of `Subsystem.Traffic` the offsets are drawn from; 1 and 2 belong to `traffic.ts`. */
const SIGNAL_STREAM = 3;

export type Light = 'green' | 'amber' | 'red';

/** One road into a signalled junction, and the head that faces it. */
export interface SignalApproach {
  /** The edge that arrives at the junction. */
  edge: number;
  /** Index of its junction in {@link TrafficSignals.junctions}. */
  junction: number;
  axis: 0 | 1;
  /** Metres along the edge the middle of a vehicle stops at on red. */
  stop: number;
  /** The stop line on the road's centreline, where the head stands. `y` is the map's. */
  x: number;
  y: number;
  /** The road's height there. */
  height: number;
  /** The heading of the traffic that arrives. */
  heading: number;
  /** Metres from the centreline to the kerb. */
  kerb: number;
}

/** One junction under signals. */
export interface SignalJunction {
  node: number;
  x: number;
  y: number;
  /** Ticks the junction's cycle is ahead of the clock. */
  offset: number;
  /** Indices into {@link TrafficSignals.approaches}. */
  approaches: number[];
}

/** The height of a road, `t` along a segment of a curve that stands at `(x, y)`. */
export type RoadHeight = (curve: number, segment: number, t: number, x: number, y: number) => number;

export class TrafficSignals {
  readonly junctions: readonly SignalJunction[];
  readonly approaches: readonly SignalApproach[];
  /** The approach each edge is, or -1 where the edge arrives at no signal. */
  private readonly byEdge: Int32Array;
  /** 1 on each node a queue must keep out of: a junction with lights, or a level crossing of the tram. */
  private readonly clear: Uint8Array;

  /** `crossings` are the nodes of the tram's level crossings, which take a light whatever joins them. */
  constructor(seed: number, roads: readonly RoadCurve[], graph: RoadGraph, map: JunctionMap, heightAt: RoadHeight, crossings: readonly number[] = []) {
    const junctions: SignalJunction[] = [];
    const level = new Uint8Array(graph.nodes.length);
    for (const node of crossings) level[node] = 1;
    const approaches: SignalApproach[] = [];
    this.byEdge = new Int32Array(graph.edges.length).fill(-1);
    for (const junction of map.junctions) {
      if (junction.mouths.length < 3) continue;
      // A highway takes no signal of its own, but a level crossing takes one
      // wherever it stands: without it nothing holds the traffic while the tram
      // passes, so the crossing is not one traffic obeys (spec section 6.3).
      if (level[junction.node] !== 1 && junction.mouths.some((mouth) => mouth.tier === 'highway')) continue;
      const main = junction.mouths.find((mouth) => mouth.tier === 'arterial');
      if (main === undefined) continue;
      const found: SignalApproach[] = [];
      for (const mouth of junction.mouths) {
        const out = outgoing(graph, junction.node, mouth.curve, mouth.point, mouth.direction);
        if (out === undefined || out.twin < 0) continue;
        const arriving = graph.edges[out.twin] as RoadEdge;
        const stop = arriving.length - mouth.cut - STOP_BACK;
        if (stop < MIN_APPROACH) continue;
        const points = (roads[mouth.curve] as RoadCurve).points;
        const a = points[mouth.segment];
        const b = points[mouth.segment + 1];
        let t = 0;
        if (a !== undefined && b !== undefined) {
          const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
          t = l2 > 0 ? Math.min(1, Math.max(0, ((mouth.at.x - a.x) * (b.x - a.x) + (mouth.at.y - a.y) * (b.y - a.y)) / l2)) : 0;
        }
        found.push({
          edge: arriving.id,
          junction: junctions.length,
          axis: Math.abs(mouth.dx * main.dx + mouth.dy * main.dy) >= ON_AXIS ? 0 : 1,
          stop,
          x: mouth.at.x,
          y: mouth.at.y,
          height: heightAt(mouth.curve, mouth.segment, t, mouth.at.x, mouth.at.y),
          heading: atan2(-mouth.dy, -mouth.dx),
          kerb: TIERS[mouth.tier].width / 2,
        });
      }
      // A junction whose roads all lie on one axis has nobody to take turns with,
      // and an alley or a dirt track that joins an arterial gives way without a light.
      const crossed = (f: SignalApproach): boolean => f.axis === 1 && (level[junction.node] === 1 || SIGNALLED_CROSS.includes(tierOf(graph, f.edge)));
      if (!found.some((f) => f.axis === 0) || !found.some(crossed)) continue;
      const indices: number[] = [];
      for (const approach of found) {
        this.byEdge[approach.edge] = approaches.length;
        indices.push(approaches.length);
        approaches.push(approach);
      }
      const offset = rngFor(seed, 0, Subsystem.Traffic, hashInts(SIGNAL_STREAM, junction.node)).int(0, SIGNAL_CYCLE - 1);
      junctions.push({ node: junction.node, x: junction.x, y: junction.y, offset, approaches: indices });
    }
    this.junctions = junctions;
    this.approaches = approaches;
    this.clear = level;
    for (const junction of junctions) this.clear[junction.node] = 1;
  }

  /**
   * True at a node a queue must not stand in: a junction with lights, whose
   * cross traffic has its own green, or a level crossing, where a tram may be
   * crossing. A queue for the light ahead may run back through any other node.
   */
  keepsClear(node: number): boolean {
    return this.clear[node] === 1;
  }

  /** The approach an edge is, or undefined where it arrives at no signal. */
  approachOf(edge: number): SignalApproach | undefined {
    const index = this.byEdge[edge] ?? -1;
    return index < 0 ? undefined : this.approaches[index];
  }

  /** The light an approach shows at a tick. A tick between two reads as the one before. */
  light(approach: SignalApproach, tick: number): Light {
    const green = SIGNAL_GREEN[approach.axis];
    const into = this.intoGreen(approach.junction, approach.axis, tick);
    if (into < green) return 'green';
    return into < green + SIGNAL_AMBER ? 'amber' : 'red';
  }

  /** The tick of the cycle, 0 to {@link SIGNAL_CYCLE}, on which an approach's green starts. */
  greenStart(approach: SignalApproach): number {
    const junction = this.junctions[approach.junction] as SignalJunction;
    return mod(GREEN_START[approach.axis] - junction.offset, SIGNAL_CYCLE);
  }

  /**
   * True while a pedestrian may cross the roads of one axis of a junction: the
   * traffic of that axis is held on red and the traffic beside the crossing
   * has its green. The pedestrians of spec section 13.1 wait for it.
   */
  crossingOpen(junction: number, axis: 0 | 1, tick: number): boolean {
    const beside = axis === 0 ? 1 : 0;
    return this.intoGreen(junction, beside, tick) < SIGNAL_GREEN[beside];
  }

  /** Ticks since the axis's green last started, 0 to {@link SIGNAL_CYCLE}. */
  private intoGreen(junction: number, axis: 0 | 1, tick: number): number {
    const at = this.junctions[junction] as SignalJunction;
    return mod(Math.floor(tick) + at.offset - GREEN_START[axis], SIGNAL_CYCLE);
  }
}

/** The edge that leaves a node along one mouth of its junction. */
function outgoing(graph: RoadGraph, node: number, curve: number, point: number, direction: 1 | -1): RoadEdge | undefined {
  for (const id of graph.edgesFrom(node)) {
    const edge = graph.edges[id] as RoadEdge;
    if (edge.curve === curve && edge.start === point && Math.sign(edge.end - edge.start) === direction) return edge;
  }
  return undefined;
}

function tierOf(graph: RoadGraph, edge: number): RoadTier {
  return (graph.edges[edge] as RoadEdge).tier;
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

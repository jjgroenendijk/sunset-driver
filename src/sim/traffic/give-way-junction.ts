/**
 * Giving way at a junction without lights (spec section 13.1, issue #360).
 *
 * No tour reads another, so at a junction where no light takes turns, two
 * tours cross or merge through each other. Near the player, `give-way.ts`
 * holds a car at the mouth of such a junction while its path meets that of
 * another car: one already in the junction, or one that has the right of way.
 * A car on the faster road has it, so a ramp gives way to the highway and a
 * side street to the road it joins. Between two roads of one speed the car
 * that reaches the junction first has it, and of two that reach it together
 * the lower id. So of the cars that wait at one junction, one always may go,
 * and nobody waits in a ring.
 *
 * Two cars whose paths do not meet pass together: one behind the other on
 * the same road in, and two that go straight past each other from opposite
 * sides. Any other pair of paths is taken to meet, turns to the right
 * included, since a car that waits a moment too long does no harm.
 */
import type { Junction, JunctionMap } from '../../world/junctions/junctions.ts';
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import type { TrafficSignals } from './signals.ts';
import type { AmbientTraffic, TrafficCursor } from './traffic.ts';

/** Metres the middle of a waiting car stands short of the junction, beyond half its length. */
const MOUTH_GAP = 0.5;

/**
 * Seconds ahead a car on its way into a junction counts as arriving there.
 * A car on a slower road waits for one on a faster road that arrives before
 * it has driven through, and the mouth of a ramp's merge is some 35 metres
 * long: at a crawl that takes it most of this.
 */
const HORIZON = 6;

/** Metres ahead a car counts as arriving, however slowly it drives. */
const HORIZON_MIN = 3;

/** Metres per second the time to arrive is reckoned at, at least: a car standing at the mouth arrives now. */
const ETA_SPEED = 1;

/** Where one car stands to a junction without lights, on one tick. */
interface Passage {
  /** The node of the junction, or -1 where the car is near none. */
  node: number;
  /** The edge it comes in on and the edge it leaves by. */
  from: number;
  to: number;
  /** Metres to its mouth; below 0 once it is inside. */
  left: number;
  /** Seconds until it reaches its mouth, and until it has driven out of the junction. */
  eta: number;
  clear: number;
  /** Metres its next step takes it along its road. */
  step: number;
}

export class JunctionYield {
  private readonly graph: RoadGraph;
  /** By edge, metres the junction at its end reaches back along it, or -1 where that junction has lights or is none. */
  private readonly cutIn: Float64Array;
  /** By edge, metres the junction at its start reaches along it, or -1. */
  private readonly cutOut: Float64Array;
  private passages: Passage[] = [];
  /** The cars at each junction, by node. Read by key only, never walked. */
  private readonly atNode = new Map<number, number[]>();

  constructor(graph: RoadGraph, map: JunctionMap | undefined, signals: TrafficSignals | undefined) {
    this.graph = graph;
    this.cutIn = new Float64Array(graph.edges.length).fill(-1);
    this.cutOut = new Float64Array(graph.edges.length).fill(-1);
    for (const junction of map?.junctions ?? []) {
      if (junction.mouths.length < 3) continue;
      if (signals !== undefined && signals.junctionAt(junction.node) >= 0) continue;
      this.fileCuts(junction);
    }
  }

  /** File how far a junction without lights reaches along each road in and out of it. */
  private fileCuts(junction: Junction): void {
    const graph = this.graph;
    const node = junction.node;
    for (const edge of [...graph.edgesInto(node), ...graph.edgesFrom(node)]) {
      const e = graph.edges[edge] as RoadEdge;
      const at = graph.mouthAt(edge, node);
      const mouth = junction.mouths.find((m) => m.curve === e.curve && m.point === at.point && m.direction === at.direction);
      if (mouth === undefined) continue;
      if (e.to === node) this.cutIn[edge] = mouth.cut;
      if (e.from === node) this.cutOut[edge] = mouth.cut;
    }
  }

  /** Start a tick with `count` cars in the box. */
  reset(count: number): void {
    this.passages = new Array<Passage>(count);
    this.atNode.clear();
  }

  /**
   * File car `i`: `cursor` is where it stands and `ahead` where its tour puts
   * it on the next tick, `halfLength` half its length and `speed` its pace.
   */
  place(traffic: AmbientTraffic, i: number, cursor: TrafficCursor, ahead: TrafficCursor, halfLength: number, speed: number): void {
    const tour = (traffic.vehicles[cursor.id] as AmbientTraffic['vehicles'][number]).tour;
    const legs = tour.edges.length;
    const leg = tour.stepLeg[cursor.step] as number;
    const edge = tour.edges[leg] as number;
    const metres = traffic.metresOf(cursor);
    const next = traffic.edgeOf(ahead) === edge ? traffic.metresOf(ahead) : Infinity;
    const passage: Passage = { node: -1, from: -1, to: -1, left: 0, eta: 0, clear: 0, step: next - metres };
    const out = this.cutOut[edge] as number;
    const into = this.cutIn[edge] as number;
    const e = this.graph.edges[edge] as RoadEdge;
    if (out >= 0 && metres < out + halfLength) {
      // Its back is still in the junction it has just come through.
      passage.node = e.from;
      passage.from = tour.edges[(leg + legs - 1) % legs] as number;
      passage.to = edge;
      passage.left = -1;
    } else if (into >= 0) {
      const left = e.length - into - halfLength - MOUTH_GAP - metres;
      if (left > Math.max(HORIZON_MIN, speed * HORIZON)) return this.keep(i, passage);
      passage.node = e.to;
      passage.from = edge;
      passage.to = tour.edges[(leg + 1) % legs] as number;
      passage.left = left;
      const pace = Math.max(speed, ETA_SPEED);
      const through = into + Math.max(0, this.cutOut[passage.to] as number) + 2 * halfLength + MOUTH_GAP;
      passage.eta = Math.max(0, left) / pace;
      passage.clear = (Math.max(0, left) + through) / pace;
    }
    this.keep(i, passage);
  }

  /**
   * The car that car `i` waits for at the mouth of its junction, or undefined.
   * `ids` gives the id of each car. `stop` is true when the next step of car
   * `i` would take it into the junction, and it has to stand; otherwise it
   * only slows, and only within `slowRoom` metres of the mouth.
   */
  waitFor(i: number, ids: (j: number) => number, slowRoom: number): { car: number; stop: boolean } | undefined {
    const a = this.passages[i];
    if (a === undefined || a.node < 0 || a.left < 0) return undefined;
    const stop = a.step > a.left;
    if (!stop && a.left > slowRoom) return undefined;
    for (const j of this.atNode.get(a.node) ?? []) {
      if (j === i) continue;
      const b = this.passages[j] as Passage;
      if (!this.meet(a, b)) continue;
      if (b.left < 0 || this.before(b, ids(j), a, ids(i))) return { car: j, stop };
    }
    return undefined;
  }

  private keep(i: number, passage: Passage): void {
    this.passages[i] = passage;
    if (passage.node < 0) return;
    const list = this.atNode.get(passage.node);
    if (list === undefined) this.atNode.set(passage.node, [i]);
    else list.push(i);
  }

  /** True when car `b` (with id `idB`) has the right of way over car `a`, both on their way in. */
  private before(b: Passage, idB: number, a: Passage, idA: number): boolean {
    const edges = this.graph.edges;
    const speedA = (edges[a.from] as RoadEdge).speedLimit;
    const speedB = (edges[b.from] as RoadEdge).speedLimit;
    if (speedA !== speedB) return speedB > speedA && b.eta < a.clear;
    return b.eta < a.eta || (b.eta === a.eta && idB < idA);
  }

  /** True when the paths of two cars through one junction meet. */
  private meet(a: Passage, b: Passage): boolean {
    if (a.from === b.from) return false;
    const edges = this.graph.edges;
    const twinOf = (edge: number): number => (edges[edge] as RoadEdge).twin;
    return !(b.from === twinOf(a.to) && b.to === twinOf(a.from) && a.to !== twinOf(a.from));
  }
}

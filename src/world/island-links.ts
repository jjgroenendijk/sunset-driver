/**
 * The island links of the road network (spec section 6.2): a bridge out to
 * every island that carries a district, over the strait crossings of the water
 * description, with the approach on each shore that joins it to the network.
 *
 * `roads.ts` decides when the islands are linked; this is how. `IslandLinkTrace`
 * extends `HighwayTrace`, so a link can join a highway at its interchange, and
 * `RoadTracer` extends it in turn.
 */
import { dist } from '../core/math.ts';
import { HighwayTrace } from './highways.ts';
import { DRY_MARGIN } from './road-ground.ts';
import { ANCHOR_REACH, ARTERIAL, STREET } from './road-trace.ts';
import { selfOverlap } from './self-overlap.ts';
import type { Island, Point } from './types.ts';

/** Places a bridge's near head is tried at before the crossing is given up. */
const HEAD_TRIES = 12;
/** Heads on open ground an island link looks for a way on to the network from, on one shore. */
const LINK_TRIES = 4;
/**
 * Metres from the shore a near head on the network may stand as a last resort,
 * where no head closer in reaches a road (issue #276). A highway along the
 * shore can wall in the ground a head stands on, with its interchange just out
 * of {@link ANCHOR_REACH} and higher than an arterial may climb to.
 */
const LAST_REACH = ANCHOR_REACH * 1.5;
/** Metres between the samples that find where a deck leaves the shore. */
const SHORE_STEP = 2;
/** Least metres of dry ground between a head and the water worth a point of its own. */
const MIN_SHORE = 4;
/**
 * Metres a link that would end at its far head runs on past it: the ramp of a
 * deck lifted the full clearance over a shore at sea level, at an arterial's
 * grade.
 */
const RUN_ON = 60;
/** Metres between the points of that run. */
const RUN_ON_STEP = 20;

export abstract class IslandLinkTrace extends HighwayTrace {

  /**
   * Bridge out to every island that carries a district, over the strait
   * crossings of the water description. Islands are linked outward from the
   * main one, so each bridge lands on ground the network has already reached.
   *
   * `again` is the second pass, run once the arterial fill has covered the main
   * island. It leaves alone every island a road already stands on and tries the
   * rest against the whole network rather than against the highways alone.
   */
  protected linkIslands(again = false): void {
    const islands = this.world.water.islands;
    const crossings = this.world.water.crossings;
    const count = islands.length;
    const indexOfId = (id: number): number => {
      for (let i = 0; i < count; i++) if ((islands[i] as Island).id === id) return i;
      return -1;
    };
    const endsOf = (ci: number): [number, number] => {
      const c = crossings[ci];
      if (c === undefined) return [-1, -1];
      return [indexOfId(c.fromIsland), indexOfId(c.toIsland)];
    };

    let mainIsland = 0;
    for (let i = 0; i < count; i++) if ((islands[i] as Island).main) mainIsland = i;

    // Breadth-first over the crossings: the parent of an island is the crossing
    // that first reached it, so following parents always leads back to the main island.
    const parent = new Int32Array(count).fill(-1);
    const seen = new Uint8Array(count);
    const order: number[] = [];
    const queue: number[] = [mainIsland];
    seen[mainIsland] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      const from = queue[qi] as number;
      for (let ci = 0; ci < crossings.length; ci++) {
        const [a, b] = endsOf(ci);
        const other = a === from ? b : b === from ? a : -1;
        if (other < 0 || seen[other] === 1) continue;
        seen[other] = 1;
        parent[other] = ci;
        order.push(other);
        queue.push(other);
      }
    }

    // Only the islands a district stands on are worth a bridge, and with them
    // every island on the way there.
    const needed = new Uint8Array(count);
    for (const d of this.world.districts) {
      let i = this.islandOf(d.x, d.y);
      while (i !== mainIsland && i >= 0 && needed[i] === 0) {
        needed[i] = 1;
        const ci = parent[i] as number;
        if (ci < 0) break;
        const [a, b] = endsOf(ci);
        i = a === i ? b : a;
      }
    }

    const reached = again ? this.islandsWithRoads(count) : new Uint8Array(count);
    for (const island of order) {
      if (needed[island] === 1 && reached[island] === 0) this.linkIsland(island, parent[island] as number);
    }
  }

  /** One flag per island, set where a road already stands on its dry ground. */
  private islandsWithRoads(count: number): Uint8Array {
    const on = new Uint8Array(count);
    for (const curve of this.curves) {
      for (const p of curve.points) {
        if (!this.isDry(p.x, p.y)) continue;
        const i = this.islandOf(p.x, p.y);
        if (i >= 0 && i < count) on[i] = 1;
      }
    }
    return on;
  }

  /**
   * One bridge and its approaches: network → near shore → deck → far shore →
   * the island's nearest district. Which end of the crossing is the near one is
   * decided by trying both: the near end is the one that can reach the roads
   * already laid.
   *
   * The search runs twice over the two shores. The first round gives a shore up
   * as soon as its best pair of heads reaches no road, because the other shore
   * is usually the one that can. Where neither shore has a way on at its best
   * pair, the second round works through the rest of the heads instead, and
   * routes as many of them as there are. An island that carries a district has
   * to have a road (spec section 6.2), so the cheap round is an ordering and
   * never the end of the search. In the second round a head no arterial reaches
   * is given a street instead ({@link streetApproach}).
   *
   * Where both shores are spent, the boardwalk lines reserved before the links
   * give their ground back for one more try. A reserved line runs along the
   * shore, which is where a bridge head stands, and it can shut off every way
   * on to the network. A boardwalk is laid in the runs the ground leaves it
   * (`traceBoardwalk`), so one with a road across it is still a boardwalk;
   * an island with no road at all is not a place the game can be played.
   */
  private linkIsland(island: number, crossingIndex: number): void {
    const crossing = this.world.water.crossings[crossingIndex];
    if (crossing === undefined) return;
    if (this.tryShores(island, crossingIndex)) return;
    const beaches = this.world.beaches;
    if (beaches.length === 0) return;
    beaches.forEach((_, i) => this.network.release(-1 - i));
    this.tryShores(island, crossingIndex);
    // Whatever came of it, the lines are held again: the arterial fill and the
    // minor fill after it keep off a boardwalk's ground as before.
    beaches.forEach((beach, i) => this.network.reserve(-1 - i, 'street', beach.boardwalk));
  }

  /** Both shores of a crossing, the cheap round first. True where the link was laid. */
  private tryShores(island: number, crossingIndex: number): boolean {
    for (const patient of [false, true]) {
      for (const flip of [false, true]) {
        if (this.linkOverShore(island, crossingIndex, flip, patient)) return true;
      }
    }
    return false;
  }

  /**
   * One shore of one crossing, tried as the near side of the bridge. True where
   * the link was laid. `patient` is the second round of {@link linkIsland}: it
   * routes every head rather than the first few, and never gives the shore up
   * because the best pair found no way on to the network.
   */
  private linkOverShore(island: number, crossingIndex: number, flip: boolean, patient: boolean): boolean {
    const crossing = this.world.water.crossings[crossingIndex];
    if (crossing === undefined) return false;
    const nearShore = flip ? crossing.to : crossing.from;
    const farShore = flip ? crossing.from : crossing.to;
    const { open, joined, further } = this.bridgeHeads(nearShore, farShore);
    // The best pair on open ground first. Where its approach turns back under
    // the deck, the heads on the network come next, since they need no
    // approach at all, then the rest of the open ground, and last the heads on
    // the network further from the shore.
    const pairs = [...open.slice(0, 1), ...joined, ...open.slice(1), ...further];
    const tries = patient ? HEAD_TRIES : LINK_TRIES;
    let routed = 0;
    for (const [near, far] of pairs) {
      const onNetwork = joined.some((pair) => pair[0] === near) || further.some((pair) => pair[0] === near);
      let approach: Point[] | undefined = [near];
      if (!onNetwork) {
        if (routed++ >= tries) break;
        // The approach carries on from the deck, so it is looked for first
        // among the routes that do not turn back under it.
        const shore = this.islandOf(near.x, near.y);
        approach = this.routeToNetwork(near, shore, 'arterial', ARTERIAL, undefined, false, [far, near]) ?? this.routeToNetwork(near, shore);
        // A near shore the network cannot be reached from is the other shore's
        // to try, in the round that has another shore left to try.
        if (approach === undefined && routed === 1 && !patient) break;
        if (approach === undefined) {
          // Every arterial way on is spent, so the patient round lays a street
          // instead. An island that carries a district has to have a road.
          const climbed = patient ? this.streetApproach(near, far, shore) : undefined;
          if (climbed === undefined) continue;
          approach = climbed;
        } else approach.reverse();
      }
      if (selfOverlap([...approach, far], 'arterial') !== undefined) continue;
      const landing = this.landOnIsland(far, island, [near, far]);
      // The span is a deck because it stands over water. Where the two heads
      // end up on dry, gentle ground the whole way between them — a strait that
      // runs dry at its narrowest — the link is a road on the ground, and the
      // structures it does need are found with the rest (issue #371).
      const span = this.probe(near.x, near.y, far.x, far.y);
      const onGround = span.dry && span.grade <= ARTERIAL.maxGrade;
      // A deck over water is lifted clear of the sea and ramps down each side
      // on line the road already has (`water-lift.ts`). A head on the network,
      // or at the end of the link, is a point no ramp may raise, so the dry
      // ground between each head and the water is given points of its own, and
      // a link that ends at its far head runs on past it (issue #676, D1).
      const shore = onGround ? {} : this.waterline(near, far);
      const tail = landing.length > 1 || onGround ? landing : this.runOn(near, far);
      const deck = [...(shore.leave === undefined ? [] : [shore.leave]), ...(shore.meet === undefined ? [] : [shore.meet])];
      const points = [...approach, ...deck, ...tail];
      const bridges = onGround ? [] : [approach.length - 1 + (shore.leave === undefined ? 0 : 1)];
      if (!this.structuresAtSlots(points, bridges)) continue;
      // A link cut short of its deck reaches no island, so it is laid whole or not at all.
      if (this.addCurve('arterial', points, bridges, [], true) !== undefined) return true;
    }
    return false;
  }

  /**
   * A way on to the network for a bridge head no arterial can reach: a street,
   * which climbs what an arterial may not. The head can stand in a pocket of
   * ground that steep slopes close off, and a pocket holds streets where it
   * holds no arterial (issue #277). The street is laid as a road of its own and
   * the link begins where it ends, so the bridge and the island's road are
   * still arterial. Undefined where no street reaches the head either.
   */
  private streetApproach(near: Point, far: Point, shore: number): Point[] | undefined {
    const route =
      this.routeToNetwork(near, shore, 'street', STREET, undefined, false, [far, near]) ??
      this.routeToNetwork(near, shore, 'street', STREET);
    if (route === undefined) return undefined;
    return this.addCurve('street', [...route].reverse(), []) === undefined ? undefined : [near];
  }

  /**
   * True where every structure of a link crosses a highway only at one of its
   * slots (spec section 6.2).
   *
   * {@link bridgeHeads} checks the one span the bridge was planned as, and the
   * ground rules of the trace check the approach. The segments of the approach
   * that `markStructures` turns into a deck or a bore keep neither check: a
   * structure is not on the ground, so the crossing plan asks it for a
   * clearance and nothing else, and a link whose approach ends up elevated may
   * then cross a highway anywhere. `bridges` comes back as the mark left it, so
   * the caller lays the link with the decks already found.
   */
  private structuresAtSlots(points: readonly Point[], bridges: number[]): boolean {
    const tunnels = this.markStructures(points, bridges);
    for (const i of [...bridges, ...tunnels]) {
      const a = points[i] as Point;
      const b = points[i + 1] as Point;
      if (!this.network.crossesAtSlots(a, b, 'arterial')) return false;
    }
    return true;
  }

  /**
   * The pairs of heads a bridge may stand on, the best places first. The deck
   * between them is one straight segment, and a highway it would cross away
   * from one of its slots refuses the pair.
   *
   * `open` stands on open ground. In `joined` the near head stands on a point
   * of the network an arterial may join, nearest first. That is the highway
   * that runs along the shore and took the ground a head would stand on: the
   * bridge joins it at its interchange instead of crossing it. `further` is
   * the same out to {@link LAST_REACH}, past the points `joined` holds.
   */
  private bridgeHeads(nearShore: Point, farShore: Point): { open: [Point, Point][]; joined: [Point, Point][]; further: [Point, Point][] } {
    const fars = this.dryAnchors(farShore, nearShore);
    const open: [Point, Point][] = [];
    for (const near of this.dryAnchors(nearShore, farShore).slice(0, HEAD_TRIES)) {
      const far = fars.find((p) => this.network.crossesAtSlots(near, p, 'arterial') && this.network.deckApart(near, p, 'arterial'));
      if (far !== undefined) open.push([near, far]);
    }
    const joined: [Point, Point][] = [];
    const further: [Point, Point][] = [];
    for (const hit of this.network.within(nearShore.x, nearShore.y, LAST_REACH, -1, 'arterial')) {
      const near = { x: hit.x, y: hit.y };
      if (this.network.refuses(near.x, near.y, 'arterial')) continue;
      const far = fars.find((p) => this.network.meets(near, p, 'arterial') && this.network.deckApart(near, p, 'arterial'));
      if (far === undefined) continue;
      if (dist(near.x, near.y, nearShore.x, nearShore.y) <= ANCHOR_REACH) joined.push([near, far]);
      else further.push([near, far]);
    }
    return { open, joined, further };
  }

  /**
   * The two places the straight deck from `near` to `far` leaves and meets
   * the water, a step back on the dry ground each side: points the deck can be
   * split at, so the dry ground under it carries a ramp and not a deck. Each
   * is left out where it stands too close to its head to be worth a point.
   */
  private waterline(near: Point, far: Point): { leave?: Point; meet?: Point } {
    const run = dist(near.x, near.y, far.x, far.y);
    const steps = Math.ceil(run / SHORE_STEP);
    const at = (t: number): Point => ({ x: near.x + (far.x - near.x) * t, y: near.y + (far.y - near.y) * t });
    let first = -1;
    let last = -1;
    for (let k = 1; k < steps; k++) {
      const p = at(k / steps);
      if (this.hf.sample(p.x, p.y) >= this.seaLevel + DRY_MARGIN) continue;
      if (first < 0) first = k;
      last = k;
    }
    if (first < 0) return {};
    const leave = at(Math.max(0, first - 2) / steps);
    const meet = at(Math.min(steps, last + 2) / steps);
    // A split turns that stretch of deck into road on the ground, so it keeps
    // off the roads it passes as any step on the ground does.
    const keeps = (p: Point, head: Point, a: Point, b: Point): boolean =>
      dist(p.x, p.y, head.x, head.y) >= MIN_SHORE && this.acceptAnchor(p) && this.network.stepOk(a, b, 'arterial');
    return {
      ...(keeps(leave, near, near, leave) ? { leave } : {}),
      ...(keeps(meet, far, meet, far) ? { meet } : {}),
    };
  }

  /**
   * The far head, and the line carried straight on past it over dry ground
   * the tier may drive, out to {@link RUN_ON}: the room a ramp needs to come
   * down on where the link would otherwise end at its deck.
   */
  private runOn(near: Point, far: Point): Point[] {
    const run = dist(near.x, near.y, far.x, far.y);
    const out: Point[] = [far];
    if (run === 0) return out;
    const ux = (far.x - near.x) / run;
    const uy = (far.y - near.y) / run;
    for (let s = RUN_ON_STEP; s <= RUN_ON; s += RUN_ON_STEP) {
      const prev = out[out.length - 1] as Point;
      const p = { x: far.x + ux * s, y: far.y + uy * s };
      if (!this.acceptAnchor(p) || !this.canRun(prev.x, prev.y, p.x, p.y, ARTERIAL.maxGrade)) break;
      if (!this.network.stepOk(prev, p, 'arterial')) break;
      out.push(p);
    }
    return out;
  }

  /** The far side of a bridge, carried on to the nearest district of the island it reached. */
  private landOnIsland(far: Point, island: number, deck: readonly Point[]): Point[] {
    let site: Point | undefined;
    let bestD = Infinity;
    for (const d of this.world.districts) {
      if (this.islandOf(d.x, d.y) !== island) continue;
      const dd = dist(far.x, far.y, d.x, d.y);
      if (dd >= bestD) continue;
      bestD = dd;
      site = { x: d.x, y: d.y };
    }
    if (site === undefined) return [far];
    return this.routeTo(far, site, island, deck) ?? [far];
  }
}

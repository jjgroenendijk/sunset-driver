/**
 * The road network: highways, arterials, streets, alleys and dirt roads, all
 * traced as streamlines of the tensor field (spec sections 6.1 and 6.2).
 *
 * Highways go down first: a ring round the core and the radials that leave it
 * (`highways.ts`). Each is planned as it is laid, with its decks and the slots
 * a lower road may cross it at (`highway-plan.ts`).
 *
 * Arterials come second and have somewhere to be: first the islands that carry
 * a district, then the districts themselves. They follow the field too, but
 * their heading is blended with the bearing to their target, so they arrive
 * instead of wandering off. A trace that cannot get through — a bay in the way,
 * the field turning it back — is retried as a route over land cells. That is
 * the reroute of spec section 6.1.
 *
 * The boardwalks of spec section 7.3 come next, and are the one road that does
 * not follow the field at all: a resort beach hands over the line behind its
 * dune, and the street is laid on it so the roads stay off the sand.
 *
 * Streets and dirt roads come last. They are the same fill as the arterials,
 * with two differences: the spacing comes from the density of the district
 * under the seed, so a dense district gets tight blocks, and the tier comes
 * from its zone. A road that met nothing on one side is a dead end, and a dead
 * end is trimmed to a cul-de-sac rather than left running into nothing.
 *
 * The alleys go down after them, and are not a fill at all: one service lane
 * inside one block, wherever a block is deep enough to be worth halving.
 * `alleys.ts` says where those lanes go.
 *
 * No road climbs harder than its tier allows. Every candidate step is measured
 * against `TIERS[tier].maxGrade`, and a step that is too steep is refused, so
 * the trace turns along the contour instead — the reroute of spec section 6.1.
 * Where the ground under an accepted step is not the line the road drives, the
 * segment is marked: a hill above it is tunnelled, a dip below it is decked.
 *
 * A highway is the one tier that does not take a junction wherever a road
 * reaches it. Interchanges are placed along it, and only a highway or an
 * arterial ramp may join it, only there (spec section 6.2). A street, an alley
 * or a dirt road never meets one at all. A road laid later crosses a highway
 * only at one of its slots, under its deck, and every other crossing is refused
 * while the road is traced.
 *
 * This file is the plan: which road is laid where, and in what order. How a
 * road is actually traced — the step along the field, the ground that refuses
 * it, the reroute and the bridges — is `road-trace.ts`, which `highways.ts`
 * extends, `island-links.ts` extends with the bridges out to the islands, and
 * this extends in turn. The graph every road is added to is `road-network.ts`.
 * The seed and plan the fills speak in, and the zone table they read, are
 * `fill.ts`.
 *
 * Seven invariants hold by construction, and the seed sweep checks them:
 *
 * - Every curve starts on an existing road, ends on one, or merges into one, so
 *   it shares a node with the network and the whole network is a single
 *   connected component. A trace that reaches neither is dropped rather than
 *   left dangling.
 * - No segment passes over water unless it is a bridge, and a bridge only ever
 *   spans one of the water description's strait crossings or a river
 *   (`river-decks.ts`).
 * - No segment laid on the ground exceeds its tier's maximum grade.
 * - No road shares a node with a highway away from one of its interchanges,
 *   and no street, alley or dirt road shares one with a highway at all. No
 *   road crosses a highway away from one of its slots.
 * - No road runs along another road's carriageway or ends inside it. Two roads
 *   touch only where they share a node or cross, at an angle a junction or an
 *   overpass can be built at (`network-clearance.ts`).
 * - No crossing is flat. Each is decided when its second road is added: a
 *   junction, a crossing under a deck already there, a raise of the new road,
 *   or a road shortened back from it (`crossing-plan.ts`).
 * - No road lies over its own carriageway (`self-overlap.ts`): the network
 *   refuses one that would, and the roads proposed to it have their folds cut
 *   out or turn away before they fold.
 */
import { clamp, dist, directionDelta, lerp } from '../core/math.ts';
import { atan2 } from '../core/libm.ts';
import { gateChoices } from './airfields.ts';
import { toSegment } from './crossing-line.ts';
import { alleyPlan, alleySeeds, type AlleyGround } from './alleys.ts';
import { ZONE_LOTS } from './buildings.ts';
import { districtAt, layoutZones, zoneAt } from './districts.ts';
import { crossPoint } from './network-clearance.ts';
import { ARTERIAL_CROSS_BY_ZONE, MINOR_BY_ZONE, seedAlong, type FillPlan, type FillSeed, type PlanAt, type SpacingAt } from './fill.ts';
import { zoneMinBuilt } from './parcels.ts';
import { IslandLinkTrace } from './island-links.ts';
import {
  alignTo,
  ALLEY_DENSITY,
  ARTERIAL,
  ARTERIAL_SPACING,
  DEAD_END_SPACINGS,
  DIRT,
  FILL_GENERATIONS,
  FILL_LIMIT,
  MIN_BOARDWALK,
  MIN_MERGE_STEPS,
  MINOR_GENERATIONS,
  MINOR_LIMIT,
  polylineLength,
  SERVED,
  STREET,
  type TierParams,
  type TraceOptions,
} from './road-trace.ts';
import type { TensorField } from './tensor.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { Airfield, Beach, Point, RoadCurve, RoadTier, WorldSkeleton } from './types.ts';

// The trace itself is next door, and `roads.ts` is the door onto both: the
// ground rules and the boardwalk length come out through here, as they did
// while the two halves were one file.
export { MIN_BOARDWALK } from './road-trace.ts';

/** Metres from an airfield's gate within which a road already laid serves it. */
const GATE_REACH = 40;
/** Metres round a gate searched for the points of a road that may run past it. */
const GATE_SEARCH = 200;

/**
 * One runnable run of a boardwalk line, as the trace left it: the id of the
 * road laid on it or -1, and the ways on to the network its two ends found,
 * each with the end of the run it arrives at.
 */
interface BoardwalkRun {
  id: number;
  line: readonly Point[];
  ways: [Point[], Point][];
}

/** The roads of a world, and the boardwalk each beach was given. */
export interface TracedRoads {
  roads: RoadCurve[];
  /**
   * The curve that runs along each beach's boardwalk line, indexed like
   * `world.beaches`. -1 where the beach carries no boardwalk, or where the
   * ground refused the one it asked for.
   */
  boardwalks: number[];
  /**
   * The road laid from each airfield's gate, indexed like `world.airfields`
   * (spec section 8.4). -1 on a dock, and where no road could reach the gate.
   */
  gates: number[];
  /** The gate each of those roads was laid from, which may be another side of the airfield. */
  gatePoints: Point[];
}

/** Trace every road of a world, widest tier first. Pure: same world and field, same roads. */
export function traceRoads(world: WorldSkeleton, field: TensorField): TracedRoads {
  return new RoadTracer(world, field).build();
}

class RoadTracer extends IslandLinkTrace {

  build(): TracedRoads {
    this.traceHighways();
    // The line behind each resort's dune is the boardwalk's, and the roads
    // laid before it would otherwise run along it: an island link or an
    // arterial on that line leaves the beach a boardwalk with no ground to
    // stand on. The highways go first, since every other road grows off them.
    this.world.beaches.forEach((beach, i) => this.network.reserve(-1 - i, 'street', beach.boardwalk));
    this.linkIslands();
    this.fillArterials();
    // Again, now the arterials are laid. A bridge is refused where the near
    // shore reaches no road, and the network was two highways when the islands
    // were first linked: an island whose shore stood away from both was left
    // carrying districts that no road reaches.
    this.linkIslands(true);
    this.serveDistricts();
    // Once more, now the districts are served. The arterial to a district can
    // be the first road on the stretch of shore a bridge head stands on.
    const before = this.curves.length;
    this.linkIslands(true, true);
    if (this.curves.length > before) this.serveDistricts();
    // Before the minor fill, so the fill grows around the boardwalk instead of
    // laying its own streets over the same ground.
    const boardwalks = this.world.beaches.map((beach, i) => this.traceBoardwalk(beach, i));
    // The airport next, while the fill still leaves room in front of its gate.
    // After the boardwalks: the airport's road once joined an arterial where a
    // boardwalk's way on had to cross it, and the beach was left without one.
    const fields = this.world.airfields;
    const served = fields.map((field) => (field.kind === 'airport' ? this.serveField(field) : { road: -1, gate: field.gate }));
    this.fillMinor();
    // An airstrip stands out where the dirt roads are, which the fill has just
    // laid, so its track is the short one to the nearest of them. A heliport
    // stands among the streets, so a street serves it: an arterial laid there
    // before the fill cut the blocks round it apart. An airport no road reached
    // before the fill may find a street of it at its gate now.
    fields.forEach((field, i) => {
      if (field.kind !== 'dock' && (served[i] as { road: number }).road < 0) served[i] = this.serveField(field);
    });
    const gates = served.map((s) => s.road);
    const gatePoints = served.map((s) => s.gate);
    // Every crossing was decided as its road was added (`crossing-plan.ts`), so
    // the curves are the network as it stands.
    return { roads: [...this.curves], boardwalks, gates, gatePoints };
  }

  // ------------------------------------------------------------------- fill

  /**
   * Arterials between the highways: streamlines seeded one spacing off the roads
   * already laid, running parallel to them, generation after generation until
   * the built-up zones are covered.
   *
   * The fill has two spacings, as the minor fill has (spec section 6.1). The
   * arterials that run with the field's major direction are the city's avenues
   * and stand `ARTERIAL_SPACING` apart. The ones that cross them stand
   * `ARTERIAL_CROSS_BY_ZONE` times as far apart, which in the city is four,
   * because what ties two avenues together is a street and not another
   * arterial.
   */
  private fillArterials(): void {
    const zones = layoutZones(this.size, this.world.core, this.world.water);
    const avenues = this.size * ARTERIAL_SPACING;
    const spacingAt: SpacingAt = (x, y, across) =>
      across ? avenues * ARTERIAL_CROSS_BY_ZONE[zoneAt(zones, x, y)] : avenues;
    const within = (x: number, y: number): boolean =>
      // Off the sand, like the minor fill: a beach is served from the boardwalk
      // behind its dune, never paved across (spec section 7.3).
      zoneAt(zones, x, y) !== 'wilderness' && this.offSand(x, y);
    const plan: PlanAt = (x, y, across) => ({
      tier: 'arterial',
      params: ARTERIAL,
      spacing: spacingAt(x, y, across),
      // Half the tighter of the two, never half its own spacing: a cross
      // arterial meets an avenue every 230 m, and a clearance taken from its
      // own spacing would refuse every one of them.
      clearance: avenues * 0.5,
      deadEnd: Infinity,
      within,
    });
    const seeds: FillSeed[] = [];
    for (const curve of this.curves) seedAlong(curve, this.field, spacingAt, 0, seeds, { ramps: true });
    const laid = this.grow(seeds, plan, FILL_GENERATIONS, FILL_LIMIT);
    // A highway that ends in no other road gives the fill nothing to grow
    // from: no minor road may join it, and a district beside its end counts as
    // served. So an arterial carries on from the end, after the rest of the
    // fill, where no arterial covers the ground yet (seed 1075207175).
    this.grow(this.deadEnds(), plan, FILL_GENERATIONS, FILL_LIMIT - laid.length);
  }

  /** A fill seed on each end of a highway that no other road meets. */
  private deadEnds(): FillSeed[] {
    const seeds: FillSeed[] = [];
    for (const curve of this.curves) {
      if (curve.tier !== 'highway') continue;
      const last = curve.points.length - 1;
      for (const [end, inner] of [[0, 1], [last, last - 1]] as const) {
        const node = curve.nodes[end];
        if (this.curves.some((c) => c !== curve && node !== undefined && c.nodes.includes(node))) continue;
        const at = curve.points[end] as Point;
        const from = curve.points[inner] as Point;
        const along = atan2(at.y - from.y, at.x - from.x) + Math.PI / 2;
        seeds.push({ x: at.x, y: at.y, along, parent: curve.id, depth: 0, onParent: true });
      }
    }
    return seeds;
  }

  // ------------------------------------------------------------ minor roads

  /**
   * Streets, dirt roads and alleys between the arterials (spec section 6.2).
   * The zone under a seed decides the tier and the block size it aims for, and
   * the density of the district under it decides where in that range the
   * spacing lands. The alleys come last, one service lane to a block, laid from
   * the blocks the streets have just made rather than from a spacing.
   */
  private fillMinor(): void {
    const zones = layoutZones(this.size, this.world.core, this.world.water);
    const districts = this.world.districts;
    const spacingAt: SpacingAt = (x, y, across) => {
      const spec = MINOR_BY_ZONE[zoneAt(zones, x, y)];
      const [tight, loose] = across ? spec.across : spec.along;
      return lerp(loose, tight, clamp(districtAt(districts, zones, x, y).density, 0, 1));
    };
    const tierAt = (x: number, y: number): RoadTier => MINOR_BY_ZONE[zoneAt(zones, x, y)].tier;
    // The fill is what covers the map, so it is what would otherwise pave the
    // beaches. It stops at the sand; the boardwalk behind the dune is the road
    // that serves them (spec section 7.3).
    const paved = (x: number, y: number): boolean => tierAt(x, y) === 'street' && this.offSand(x, y);
    const unpaved = (x: number, y: number): boolean => tierAt(x, y) === 'dirt' && this.offSand(x, y);

    // Streets in the built-up zones, dirt roads in the outskirts and the
    // wilderness. Each stays on its own ground, so a street never fades into a
    // track and a track never becomes a street halfway along.
    const streetPlan: PlanAt = (x, y, across) => {
      const tier = tierAt(x, y);
      const tight = spacingAt(x, y, true);
      return {
        tier,
        params: tier === 'dirt' ? DIRT : STREET,
        spacing: spacingAt(x, y, across),
        clearance: tight * 0.5,
        deadEnd: tight * DEAD_END_SPACINGS,
        within: tier === 'dirt' ? unpaved : paved,
      };
    };
    const seeds: FillSeed[] = [];
    for (const curve of [...this.curves]) seedAlong(curve, this.field, spacingAt, 0, seeds);
    const streets = this.grow(seeds, streetPlan, MINOR_GENERATIONS, MINOR_LIMIT);

    // The alleys last, one to a block (spec section 6.2). The block a lane
    // would halve is measured on the ground rather than read off the zone
    // table, so `alleys.ts` is given what the zone says and finds the rest.
    const ground: AlleyGround = {
      within: (x, y) => paved(x, y) && districtAt(districts, zones, x, y).density >= ALLEY_DENSITY,
      minStrip: (x, y) => {
        const zone = zoneAt(zones, x, y);
        const lot = ZONE_LOTS[zone];
        return { depth: lot.depth + lot.setback, area: zoneMinBuilt(zone) };
      },
      // The long side of a block is bounded by the avenues, and in the city
      // those are the arterial fill and not `MINOR_BY_ZONE.along`, which is set
      // wider than a block on purpose.
      blockLength: (x, y) => Math.min(spacingAt(x, y, false), this.size * ARTERIAL_SPACING),
      streetGap: (x, y) => spacingAt(x, y, true),
    };
    this.grow(alleySeeds(streets, this.network, ground), alleyPlan(ground), 1, MINOR_LIMIT);
  }

  // -------------------------------------------------------------------- fill

  /**
   * Grow one tier out of the roads already laid, seed by seed. A seed on ground
   * another road already covers is skipped, which is what keeps blocks near
   * their spacing, and a road is kept only if it joins the network, so the fill
   * can never leave one dangling. Roads laid here seed the next generation.
   */
  private grow(seeds: FillSeed[], planAt: PlanAt, generations: number, limit: number): RoadCurve[] {
    const laid: RoadCurve[] = [];
    for (let i = 0; i < seeds.length && laid.length < limit; i++) {
      const seed = seeds[i] as FillSeed;
      if (!this.isDry(seed.x, seed.y)) continue;
      // Which way this road will run decides which of the zone's two spacings
      // it is laid at, so the plan is read after the field, not before it.
      const major = this.field.majorAt(seed.x, seed.y);
      const across = directionDelta(major, seed.along) > Math.PI / 4;
      const plan = planAt(seed.x, seed.y, across);
      if (!plan.within(seed.x, seed.y)) continue;
      // A road begins at its seed, so a seed standing on a road this tier may
      // not junction with would make the junction anyway. A street seeded where
      // an arterial ramp meets a highway is that case (spec section 6.2).
      if (this.network.refuses(seed.x, seed.y, plan.tier)) continue;
      // Somewhere already covered: a road within the clearance, other than the parent.
      if (this.network.nearest(seed.x, seed.y, plan.clearance, seed.parent) !== undefined) continue;
      // A seed beside its parent starts a road of its own, so it has to stand
      // clear of every carriageway; one on its parent starts at a junction.
      if (!seed.onParent && !this.network.clearAt(seed.x, seed.y, plan.tier)) continue;
      this.network.takeLaid();
      const curve = this.fillRoad(seed, plan, major, across);
      if (curve === undefined) continue;
      laid.push(curve);
      if (seed.depth + 1 < generations) {
        // Every piece the network laid for the road seeds, not only the one it returned.
        for (const piece of this.network.takeLaid()) {
          if (piece.tier === plan.tier) seedAlong(piece, this.field, (x, y, a) => planAt(x, y, a).spacing, seed.depth + 1, seeds);
        }
      }
    }
    return laid;
  }

  /** One fill road, traced both ways along the field line it was seeded with. */
  private fillRoad(seed: FillSeed, plan: FillPlan, major: number, minor: boolean): RoadCurve | undefined {
    const params = plan.params;
    const line = alignTo(minor ? major + Math.PI / 2 : major, seed.along);
    const opt: TraceOptions = {
      params,
      joiner: plan.tier,
      minor,
      within: plan.within,
      mergeAfter: params.step * MIN_MERGE_STEPS,
      parentCurve: seed.parent,
      parentMergeAfter: plan.spacing,
    };
    const forward = this.trace({ x: seed.x, y: seed.y }, { ...opt, heading: line });
    // The two halves are one road, so the second may not turn back over the first.
    const backward = this.trace({ x: seed.x, y: seed.y }, { ...opt, heading: line + Math.PI, before: [...forward.points].reverse() });
    // A road that starts beside the network has to find its way back to it.
    if (!seed.onParent && !forward.merged && !backward.merged) return undefined;
    // A side that met no other road is a dead end, kept only as far as a cul-de-sac runs.
    const ahead = forward.merged ? forward.points : trimTo(forward.points, forward.clear, plan.deadEnd);
    const behind = backward.merged ? backward.points : trimTo(backward.points, backward.clear, plan.deadEnd);
    behind.reverse();
    const points = [...behind.slice(0, -1), ...ahead];
    if (polylineLength(points) < plan.clearance) return undefined;
    return this.addCurve(plan.tier, points, []);
  }

  // --------------------------------------------------------------- districts

  /**
   * An arterial from every built-up district to the nearest road, worked from
   * the core outward. Where no arterial line reaches the site — it stands in a
   * pocket of ground that steep slopes close off — a street is laid instead,
   * since a street climbs what an arterial may not (issue #398).
   */
  private serveDistricts(): void {
    const core = this.world.core;
    const sites = this.world.districts
      .filter((d) => d.zone !== 'wilderness')
      .map((d) => ({ id: d.id, x: d.x, y: d.y, d: dist(core.x, core.y, d.x, d.y) }))
      .sort((a, b) => a.d - b.d || a.id - b.id);
    for (const site of sites) {
      if (!this.isDry(site.x, site.y)) continue;
      if (this.network.nearest(site.x, site.y, SERVED) !== undefined) continue;
      const island = this.islandOf(site.x, site.y);
      // Round the beaches where it can, over them where it must: a district
      // that can only be reached across the sand is still reached.
      const at = { x: site.x, y: site.y };
      const route = this.routeToNetwork(at, island, 'arterial', ARTERIAL, this.offSand);
      if (route !== undefined) {
        this.addCurve('arterial', route, []);
        continue;
      }
      const lane = this.routeToNetwork(at, island, 'street', STREET, this.offSand) ?? this.routeToNetwork(at, island, 'street', STREET);
      if (lane !== undefined) this.addCurve('street', lane, []);
    }
  }

  // ---------------------------------------------------------------- airfields

  /** The road that serves an airfield and the gate it was laid from, trying each side in turn. */
  private serveField(field: Airfield): { road: number; gate: Point } {
    for (const gate of gateChoices(field, (x, y) => this.hf.sample(x, y))) {
      const road = this.serveGate(gate, field.kind);
      if (road >= 0) return { road, gate };
    }
    return { road: -1, gate: field.gate };
  }

  /**
   * The road that serves an airfield (spec section 8.4): from its gate to the
   * nearest road. An airport takes an arterial where one can be laid and a
   * street where not, a heliport a street, and an airstrip out in the
   * wilderness a dirt road, as the ground round it is. Its id, or -1 where no
   * route reaches the gate.
   */
  private serveGate(gate: Point, kind: Airfield['kind']): number {
    if (!this.isDry(gate.x, gate.y)) return -1;
    // A road laid earlier may already run past the gate, and then it is the
    // road that serves it: a second one would start on its carriageway.
    const passing = this.roadAtGate(gate);
    if (passing >= 0) return passing;
    const island = this.islandOf(gate.x, gate.y);
    const tiers: [RoadTier, TierParams][] =
      kind === 'airstrip' ? [['dirt', DIRT], ['street', STREET]] : kind === 'heliport' ? [['street', STREET]] : [['arterial', ARTERIAL], ['street', STREET]];
    for (const [tier, params] of tiers) {
      const route = this.routeToNetwork(gate, island, tier, params, this.offSand);
      if (route === undefined) continue;
      // The network may keep only part of a route, so the road that serves
      // the gate is whichever one now reaches it.
      if (this.addCurve(tier, route, []) === undefined) continue;
      const reached = this.roadAtGate(gate);
      if (reached >= 0) return reached;
    }
    return -1;
  }

  /**
   * The road whose centreline runs within {@link GATE_REACH} of a gate, or -1.
   * It measures to the segments, not to the points: a long straight road has
   * its points far apart and may run right past the gate between two of them.
   */
  private roadAtGate(gate: Point): number {
    let best = -1;
    let bestDistance = GATE_REACH;
    for (const hit of this.network.within(gate.x, gate.y, GATE_SEARCH)) {
      const points = (this.network.curves[hit.curve] as RoadCurve).points;
      for (const i of [hit.index - 1, hit.index]) {
        const a = points[i];
        const b = points[i + 1];
        if (a === undefined || b === undefined) continue;
        const d = toSegment(gate, a, b);
        if (d <= bestDistance) {
          bestDistance = d;
          best = hit.curve;
        }
      }
    }
    return best;
  }

  // --------------------------------------------------------------- boardwalks

  /**
   * The boardwalk of one beach (spec section 7.3): a street along the line the
   * beach plan laid behind its dune. Its id, or -1.
   *
   * The line is taken as it stands rather than traced, because a boardwalk
   * follows the coast and not the field. What the ground refuses is dropped —
   * a stretch too steep for a street, or one that has gone wet — which leaves
   * one run or several. Each end of a run then reaches for the network: a curve
   * that shares a node with no other is not part of the network at all, so a
   * run neither end can reach is not laid. The runs are tried longest first,
   * and the first one laid is the boardwalk, because a shorter boardwalk on the
   * same sand is worth more than none (issue #381).
   */
  private traceBoardwalk(beach: Beach, i: number): number {
    this.network.release(-1 - i);
    const spurs: BoardwalkRun[] = [];
    for (const line of this.runnableRuns(beach.boardwalk, STREET.maxGrade)) {
      if (polylineLength(line) < MIN_BOARDWALK) continue;
      const run = this.layBoardwalk(beach, i, line);
      if (run.id >= 0) return run.id;
      if (run.ways.length > 0) spurs.push(run);
    }
    // No run could be laid as one road with its way on. The fold that refused
    // them is in the way on and not in the boardwalk, so it is laid as a road
    // of its own instead (issue #315).
    return this.spurBoardwalk(spurs);
  }

  /**
   * Lay one runnable run of a boardwalk line as a street. The run is held while
   * its ends reach for the network, so neither end runs back along the
   * boardwalk itself. The ways on it found come back with it, for the second
   * chance {@link spurBoardwalk} gives a run that was not laid.
   */
  private layBoardwalk(beach: Beach, i: number, line: readonly Point[]): BoardwalkRun {
    this.network.reserve(-1 - i, 'street', line);
    const found = [this.reachNetwork(line[0] as Point, [...line].reverse()), this.reachNetwork(line[line.length - 1] as Point, line)];
    this.network.release(-1 - i);
    const [head, tail] = found.map((route) => this.besideOwnCrossing(line, route)) as [Point[], Point[]];
    const ways: [Point[], Point][] = [];
    if (head.length > 0) ways.push([head, line[0] as Point]);
    if (tail.length > 0) ways.push([tail, line[line.length - 1] as Point]);
    if (ways.length === 0) {
      // A way on was found and dropped because the line itself crosses the road
      // it reached: the run joins the network at that crossing. It is laid on
      // its own, whole, and only where the crossing plan gives it a junction;
      // a run shortened back from its only crossing would hang off nothing
      // (issue #676, F1).
      const crossed = found.some((route, k) => route.length > 0 && (k === 0 ? head : tail).length === 0);
      if (!crossed || !this.joinsNetwork('street', [...line], true)) return { id: -1, line, ways };
      return { id: this.addCurve('street', [...line], [], [], true)?.id ?? -1, line, ways };
    }
    // A way on to the network that turns back over the boardwalk has the turn
    // cut out of it. Where that cannot be done it is dropped, as long as the
    // other end still reaches the network.
    for (const [from, to] of [[head, tail], [[], tail], [head, []]] as const) {
      if (from.length === 0 && to.length === 0) continue;
      const points = this.untangled([...[...from].reverse(), ...line, ...to], 'street', STREET.maxGrade);
      // A cut that takes the boardwalk itself below its length leaves no boardwalk.
      if (points === undefined || keptLength(beach.boardwalk, points) < MIN_BOARDWALK) continue;
      // The network shortens a road back to the piece joined to it, from a
      // crossing it gives no junction. A way on that crosses a road so can
      // keep only its own last step and none of the boardwalk (seed 4261874245).
      const settled = this.settledLine('street', points);
      if (settled !== undefined && settled.length < points.length && keptLength(beach.boardwalk, settled) < MIN_BOARDWALK) continue;
      const laid = this.addCurve('street', points, []);
      if (laid !== undefined) return { id: laid.id, line, ways };
    }
    return { id: -1, line, ways };
  }

  /**
   * A boardwalk laid as two roads rather than one, for the runs whose way on to
   * the network folds back over them. The way on goes in as a street of its own
   * and the boardwalk starts where it ends, so the fold that one road would
   * have had cut out of it — taking the boardwalk with it — is the junction
   * between two roads instead. The id of the boardwalk, or -1.
   *
   * One way on is laid at most, however many runs are offered: it is in the
   * network as soon as it is added, and a second would have to keep off it.
   */
  private spurBoardwalk(runs: readonly BoardwalkRun[]): number {
    for (const run of runs) {
      for (const [way, end] of run.ways) {
        const spur = this.untangled([...[...way].reverse(), end], 'street', STREET.maxGrade);
        if (spur === undefined) continue;
        // A spur the network would shorten no longer reaches the boardwalk.
        const settled = this.settledLine('street', spur);
        if (settled !== undefined && settled.length < spur.length) continue;
        if (this.addCurve('street', spur, []) === undefined) continue;
        return this.addCurve('street', [...run.line], [])?.id ?? -1;
      }
    }
    return -1;
  }

  /**
   * A route from a boardwalk end to the network, or nothing where it ends on a
   * road beside a place the boardwalk line crosses that road. Two roads that
   * already meet take no second junction inside the first one, so the network
   * would shorten the boardwalk back from that crossing (`crossing-plan.ts`).
   */
  private besideOwnCrossing(line: readonly Point[], route: Point[]): Point[] {
    const end = route[route.length - 1];
    if (end === undefined) return route;
    const reach = footprintHalfWidth('street');
    for (const id of this.network.curvesAt(end)) {
      const curve = this.curves[id] as RoadCurve;
      const within = reach + footprintHalfWidth(curve.tier);
      for (let s = 0; s + 1 < curve.points.length; s++) {
        const c = curve.points[s] as Point;
        const d = curve.points[s + 1] as Point;
        if (dist(c.x, c.y, end.x, end.y) > within + dist(c.x, c.y, d.x, d.y) && dist(d.x, d.y, end.x, end.y) > within + dist(c.x, c.y, d.x, d.y)) continue;
        for (let k = 0; k + 1 < line.length; k++) {
          const at = crossPoint(line[k] as Point, line[k + 1] as Point, c, d);
          if (at !== undefined && dist(at.x, at.y, end.x, end.y) < within) return [];
        }
      }
    }
    return route;
  }

}

/** Metres of a line whose segments survive whole, both ends, in a road cut from it. */
function keptLength(line: readonly Point[], road: readonly Point[]): number {
  let kept = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i] as Point;
    const b = line[i + 1] as Point;
    const at = road.indexOf(a);
    if (at >= 0 && road[at + 1] === b) kept += dist(a.x, a.y, b.x, b.y);
  }
  return kept;
}

/**
 * The head of a polyline: its first point, and as much of it as `metres`
 * covers, ending on a point `clear` says a road may end on. A cut that lands on
 * another road's carriageway is taken back to where the road stood clear.
 */
function trimTo(points: readonly Point[], clear: readonly boolean[], metres: number): Point[] {
  let end = 0;
  let run = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    run += dist(a.x, a.y, b.x, b.y);
    if (run > metres) break;
    end = i + 1;
  }
  while (end > 0 && clear[end] !== true) end--;
  return points.slice(0, end + 1);
}

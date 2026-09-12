/**
 * The road network: highways, arterials, streets, alleys and dirt roads, all
 * traced as streamlines of the tensor field (spec sections 6.1 and 6.2).
 *
 * Highways go down first. Two of them cross at the core, one along the field's
 * major direction and one along its minor direction, and a few more branch off
 * those at right angles. A highway is a pure streamline: it bends with the
 * terrain and runs along the shore because the field does, not because anything
 * steers it.
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
 * or a dirt road never meets one at all: it runs past, and where the two cross
 * the road graph makes it an overpass.
 *
 * This file is the plan: which road is laid where, and in what order. How a
 * road is actually traced — the step along the field, the ground that refuses
 * it, the reroute and the bridges — is `road-trace.ts`, which this extends, and
 * the network laid so far is `road-index.ts`. The seed and plan the fills speak
 * in, and the zone table they read, are `fill.ts`.
 *
 * Four invariants hold by construction, and the seed sweep checks them:
 *
 * - Every curve starts on an existing road, ends on one, or merges into one, so
 *   the whole network is a single connected component. A trace that reaches
 *   neither is dropped rather than left dangling.
 * - No segment passes over water unless it is a bridge, and a bridge only ever
 *   spans one of the water description's strait crossings.
 * - No segment laid on the ground exceeds its tier's maximum grade.
 * - No road shares a point with a highway away from one of its interchanges,
 *   and no street, alley or dirt road shares one with a highway at all.
 */
import { clamp, dist, directionDelta, lerp, wrapAngle } from '../core/math.ts';
import { alleyPlan, alleySeeds, type AlleyGround } from './alleys.ts';
import { ZONE_LOTS } from './buildings.ts';
import { connectCrossings } from './connect.ts';
import { districtAt, layoutZones, zoneAt } from './districts.ts';
import { MINOR_BY_ZONE, type FillPlan, type FillSeed, type PlanAt, type SpacingAt } from './fill.ts';
import { raiseOverpasses } from './overpass.ts';
import { zoneMinBuilt } from './parcels.ts';
import { JOIN_EPSILON } from './road-index.ts';
import {
  alignTo,
  ALLEY_DENSITY,
  ANCHOR_REACH,
  ARTERIAL,
  ARTERIAL_SPACING,
  BRANCH_AT,
  DEAD_END_SPACINGS,
  DIRT,
  FILL_GENERATIONS,
  FILL_LIMIT,
  groundRule,
  HIGHWAY,
  HIGHWAY_MERGE_AFTER,
  INTERCHANGE_SPACING,
  MIN_BOARDWALK,
  MIN_HIGHWAY,
  MIN_MERGE_STEPS,
  MINOR_GENERATIONS,
  MINOR_LIMIT,
  polylineLength,
  RoadTrace,
  SERVED,
  STREET,
  type TierParams,
  type TraceOptions,
} from './road-trace.ts';
import type { TensorField } from './tensor.ts';
import { TIERS } from './tiers.ts';
import type { Beach, Island, Point, RoadCurve, RoadTier, WorldSkeleton, Zone } from './types.ts';

// The trace itself is next door, and `roads.ts` is the door onto both: the
// ground rules and the boardwalk length come out through here, as they did
// while the two halves were one file.
export { groundRule, MIN_BOARDWALK, spanProfile, type Profile } from './road-trace.ts';

/** What {@link seedAlong} lays besides the two roads parallel to the curve. */
interface SeedOptions {
  /**
   * The tier being seeded may junction with a highway. Only the arterial fill
   * sets it, and even then a seed stands on a highway only at one of its
   * interchanges (spec section 6.2).
   */
  ramps?: boolean;
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
}

/** Trace every road of a world, widest tier first. Pure: same world and field, same roads. */
export function traceRoads(world: WorldSkeleton, field: TensorField): TracedRoads {
  return new RoadTracer(world, field).build();
}

/** A highway line before it is laid: the points, and where its two halves meet. */
interface Streamline {
  points: Point[];
  seam: number;
}

class RoadTracer extends RoadTrace {

  build(): TracedRoads {
    this.traceHighways();
    this.linkIslands();
    this.fillArterials();
    // Again, now the arterials are laid. A bridge is refused where the near
    // shore reaches no road, and the network was two highways when the islands
    // were first linked: an island whose shore stood away from both was left
    // carrying districts that no road reaches.
    this.linkIslands(true);
    this.serveDistricts();
    // Before the minor fill, so the fill grows around the boardwalk instead of
    // laying its own streets over the same ground.
    const boardwalks = this.world.beaches.map((beach) => this.traceBoardwalk(beach));
    this.fillMinor();
    // The trace only ever ends a road on a point of another one, so two roads
    // that cross between their points have met nothing yet.
    const connected = connectCrossings(this.curves, groundRule(this.hf, this.seaLevel));
    // Last, on curves that no longer move: a road that crosses another one and
    // does not meet it there is carried over it (spec section 6.2).
    return { roads: raiseOverpasses(connected), boardwalks };
  }

  // ---------------------------------------------------------------- highways

  /**
   * Two highways crossing at the core, plus a branch off each arm of them. A
   * branch leaves its trunk at one of the trunk's interchanges, because that is
   * the only place a highway takes a junction (spec section 6.2).
   */

  /**
   * Two highways crossing at the core, plus a branch off each arm of them. A
   * branch leaves its trunk at one of the trunk's interchanges, because that is
   * the only place a highway takes a junction (spec section 6.2).
   */
  private traceHighways(): void {
    const core = this.world.core;
    const trunks = [this.streamline(core, false), this.streamline(core, true)];
    // The highways are the spine every other road grows off: the arterials fill
    // between them, and the minor roads between those. A map with no highway at
    // all therefore has no roads at all. So where the ground cuts both trunks
    // short of MIN_HIGHWAY, the longer of the two is laid whatever its length.
    // Nothing was added to the network while they were traced, so the lines are
    // the same two the calls above found.
    if (trunks[0] === undefined && trunks[1] === undefined) {
      const lines = [this.streamlineLine(core, false), this.streamlineLine(core, true)];
      const first = lines[0] as Streamline;
      const second = lines[1] as Streamline;
      const i = polylineLength(second.points) > polylineLength(first.points) ? 1 : 0;
      const best = lines[i] as Streamline;
      if (best.points.length > 1) {
        trunks[i] = this.addCurve('highway', best.points, [], interchangesOf(best.points, best.seam));
      }
    }
    for (let i = 0; i < trunks.length; i++) {
      const trunk = trunks[i];
      if (trunk === undefined) continue;
      for (const at of this.branchPoints(trunk, BRANCH_AT)) this.streamline(at, i === 0);
    }
  }

  /**
   * Where a branch highway leaves its trunk: the free interchange nearest each
   * of the given fractions of the trunk's length. An interchange another road
   * already stands on is not free — a branch seeded there would retrace that
   * road — and neither is an end of the trunk.
   */
  private branchPoints(trunk: RoadCurve, fractions: readonly number[]): Point[] {
    const points = trunk.points;
    const last = points.length - 1;
    const free = trunk.interchanges.filter((i) => {
      if (i === 0 || i === last) return false;
      const p = points[i] as Point;
      return this.index.nearest(p.x, p.y, JOIN_EPSILON, trunk.id) === undefined;
    });
    return atFractions(points, free, fractions);
  }

  /**
   * The line a highway would follow through a point: the field line, followed
   * both ways, with the index of the point the two halves meet at.
   */
  private streamlineLine(at: Point, minor: boolean): Streamline {
    const line = this.fieldLine(at, minor);
    const opt: TraceOptions = { params: HIGHWAY, joiner: 'highway', minor, mergeAfter: HIGHWAY_MERGE_AFTER };
    const forward = this.trace(at, { ...opt, heading: line });
    const backward = this.trace(at, { ...opt, heading: line + Math.PI });
    backward.points.reverse();
    return { points: [...backward.points.slice(0, -1), ...forward.points], seam: backward.points.length - 1 };
  }

  /** One highway: that line, laid as a curve if it runs as far as a highway has to. */
  private streamline(at: Point, minor: boolean): RoadCurve | undefined {
    const { points, seam } = this.streamlineLine(at, minor);
    if (polylineLength(points) < MIN_HIGHWAY * this.size) return undefined;
    // The point it was seeded at is an interchange, so the road it grew out of
    // and this one meet at a junction both of them allow.
    return this.addCurve('highway', points, [], interchangesOf(points, seam));
  }

  // ----------------------------------------------------------------- islands

  /**
   * Bridge out to every island that carries a district, over the strait
   * crossings of the water description. Islands are linked outward from the
   * main one, so each bridge lands on ground the network has already reached.
   *
   * `again` is the second pass, run once the arterial fill has covered the main
   * island. It leaves alone every island a road already stands on and tries the
   * rest against the whole network rather than against the highways alone.
   */
  private linkIslands(again = false): void {
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
   */
  private linkIsland(island: number, crossingIndex: number): void {
    const crossing = this.world.water.crossings[crossingIndex];
    if (crossing === undefined) return;
    for (const flip of [false, true]) {
      const nearShore = flip ? crossing.to : crossing.from;
      const farShore = flip ? crossing.from : crossing.to;
      const near = this.dryAnchor(nearShore, farShore);
      const far = this.dryAnchor(farShore, nearShore);
      if (near === undefined || far === undefined) continue;
      const approach = this.routeToNetwork(near, this.islandOf(near.x, near.y));
      if (approach === undefined) continue;
      approach.reverse();
      const landing = this.landOnIsland(far, island);
      this.addCurve('arterial', [...approach, ...landing], [approach.length - 1]);
      return;
    }
  }

  /** The far side of a bridge, carried on to the nearest district of the island it reached. */
  private landOnIsland(far: Point, island: number): Point[] {
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
    return this.routeTo(far, site, island) ?? [far];
  }

  // ------------------------------------------------------------------- fill

  /**
   * Arterials between the highways: streamlines seeded one spacing off the roads
   * already laid, running parallel to them, generation after generation until
   * the built-up zones are covered.
   */
  private fillArterials(): void {
    const zones = layoutZones(this.size, this.world.core, this.world.water);
    const spacing = this.size * ARTERIAL_SPACING;
    const plan: FillPlan = {
      tier: 'arterial',
      params: ARTERIAL,
      spacing,
      clearance: spacing * 0.5,
      deadEnd: Infinity,
      // Off the sand, like the minor fill: a beach is served from the boardwalk
      // behind its dune, never paved across (spec section 7.3).
      within: (x, y) => zoneAt(zones, x, y) !== 'wilderness' && this.offSand(x, y),
    };
    const seeds: FillSeed[] = [];
    for (const curve of this.curves) seedAlong(curve, this.field, () => spacing, 0, seeds, { ramps: true });
    this.grow(seeds, () => plan, FILL_GENERATIONS, FILL_LIMIT);
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
    this.grow(alleySeeds(streets, this.index, ground), alleyPlan(ground), 1, MINOR_LIMIT);
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
      if (this.index.refuses(seed.x, seed.y, plan.tier)) continue;
      // Somewhere already covered: a road within the clearance, other than the parent.
      if (this.index.nearest(seed.x, seed.y, plan.clearance, seed.parent) !== undefined) continue;
      const curve = this.fillRoad(seed, plan, major, across);
      if (curve === undefined) continue;
      laid.push(curve);
      if (seed.depth + 1 < generations) {
        seedAlong(curve, this.field, (x, y, a) => planAt(x, y, a).spacing, seed.depth + 1, seeds);
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
    const backward = this.trace({ x: seed.x, y: seed.y }, { ...opt, heading: line + Math.PI });
    // A road that starts beside the network has to find its way back to it.
    if (!seed.onParent && !forward.merged && !backward.merged) return undefined;
    // A side that met no other road is a dead end, kept only as far as a cul-de-sac runs.
    const ahead = forward.merged ? forward.points : trimTo(forward.points, plan.deadEnd);
    const behind = backward.merged ? backward.points : trimTo(backward.points, plan.deadEnd);
    behind.reverse();
    const points = [...behind.slice(0, -1), ...ahead];
    if (polylineLength(points) < plan.clearance) return undefined;
    return this.addCurve(plan.tier, points, []);
  }

  // --------------------------------------------------------------- districts

  /** An arterial from every built-up district to the nearest road, worked from the core outward. */
  private serveDistricts(): void {
    const core = this.world.core;
    const sites = this.world.districts
      .filter((d) => d.zone !== 'wilderness')
      .map((d) => ({ id: d.id, x: d.x, y: d.y, d: dist(core.x, core.y, d.x, d.y) }))
      .sort((a, b) => a.d - b.d || a.id - b.id);
    for (const site of sites) {
      if (!this.isDry(site.x, site.y)) continue;
      if (this.index.nearest(site.x, site.y, SERVED) !== undefined) continue;
      const island = this.islandOf(site.x, site.y);
      // Round the beaches where it can, over them where it must: a district
      // that can only be reached across the sand is still reached.
      const route = this.routeToNetwork({ x: site.x, y: site.y }, island, 'arterial', ARTERIAL, this.offSand);
      if (route !== undefined) this.addCurve('arterial', route, []);
    }
  }

  // --------------------------------------------------------------- boardwalks

  /**
   * The boardwalk of one beach (spec section 7.3): a street along the line the
   * beach plan laid behind its dune. Its id, or -1.
   *
   * The line is taken as it stands rather than traced, because a boardwalk
   * follows the coast and not the field. What the ground refuses is dropped —
   * a stretch too steep for a street, or one that has gone wet — and the
   * longest run left is kept. Each end then reaches for the network: a curve
   * that shares a point with no other is not part of the network at all, so a
   * boardwalk neither end can reach is not laid.
   */
  private traceBoardwalk(beach: Beach): number {
    const line = this.longestRunnable(beach.boardwalk, STREET.maxGrade);
    if (polylineLength(line) < MIN_BOARDWALK) return -1;
    const head = this.reachNetwork(line[0] as Point);
    const tail = this.reachNetwork(line[line.length - 1] as Point);
    if (head.length === 0 && tail.length === 0) return -1;
    const points = [...[...head].reverse(), ...line, ...tail];
    return this.addCurve('street', points, [])?.id ?? -1;
  }

}

/** The head of a polyline: its first point, and as much of it as `metres` covers. */
function trimTo(points: readonly Point[], metres: number): Point[] {
  const out: Point[] = [points[0] as Point];
  let run = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    run += dist(a.x, a.y, b.x, b.y);
    if (run > metres) break;
    out.push(b);
  }
  return out;
}

/**
 * The points of a highway a junction may stand at: its two ends, the point it
 * was seeded at, and one every {@link INTERCHANGE_SPACING} along it. Ascending.
 * Every other point of a highway takes no junction at all (spec section 6.2).
 */
function interchangesOf(points: readonly Point[], seedIndex: number): number[] {
  const at = new Array<boolean>(points.length).fill(false);
  at[0] = true;
  at[points.length - 1] = true;
  if (seedIndex > 0 && seedIndex < points.length) at[seedIndex] = true;
  let run = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    run += dist(a.x, a.y, b.x, b.y);
    if (run < INTERCHANGE_SPACING) continue;
    run = 0;
    at[i + 1] = true;
  }
  const out: number[] = [];
  for (let i = 0; i < at.length; i++) if (at[i] === true) out.push(i);
  return out;
}

/**
 * Of the points a polyline offers as `choices`, the one nearest each fraction
 * of its length. Each choice is taken at most once, so two fractions never
 * return the same place, and a fraction returns nothing once the choices run
 * out.
 */
function atFractions(points: readonly Point[], choices: readonly number[], fractions: readonly number[]): Point[] {
  const total = polylineLength(points);
  const taken: number[] = [];
  // Distance along the curve of every point, so an interchange can be measured.
  const run: number[] = [0];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    run.push((run[i] as number) + dist(a.x, a.y, b.x, b.y));
  }
  const out: Point[] = [];
  for (const f of fractions) {
    const wanted = total * f;
    let best = -1;
    let bestD = Infinity;
    for (const i of choices) {
      if (taken.includes(i)) continue;
      const d = Math.abs((run[i] as number) - wanted);
      if (d >= bestD) continue;
      bestD = d;
      best = i;
    }
    if (best < 0) continue;
    taken.push(best);
    out.push(points[best] as Point);
  }
  return out;
}

/**
 * Seeds for the next generation of the fill. Along a curve: one seed to each
 * side, pointing the same way, and one on the curve itself pointing across it.
 * The first two lay the parallel roads that carry the traffic, the third the
 * cross streets that tie them together.
 *
 * A zone has two spacings, so which one a seed is placed at depends on which
 * way the curve runs here. The side seeds go out at the spacing of the curve's
 * own family — an avenue's neighbour is another avenue — and the seeds are
 * dropped along the curve at the spacing of the other family, because that is
 * the cadence of the cross streets. Both are asked for at each point, so they
 * follow the district under it.
 */
function seedAlong(
  curve: RoadCurve,
  field: TensorField,
  spacingAt: SpacingAt,
  depth: number,
  out: FillSeed[],
  opts: SeedOptions = {},
): void {
  const points = curve.points;
  let run: number | undefined;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const seg = dist(a.x, a.y, b.x, b.y);
    if (seg === 0) continue;
    const along = Math.atan2(b.y - a.y, b.x - a.x);
    // Which family this stretch of the curve belongs to: with the field's major
    // direction, or across it.
    const runsAcross = directionDelta(field.majorAt(b.x, b.y), along) > Math.PI / 4;
    const step = spacingAt(b.x, b.y, !runsAcross);
    // A deck or a bore seeds nothing: there is no ground beside the road there.
    const structure = curve.bridges.includes(i) || curve.tunnels.includes(i);
    run = (run ?? step / 2) + seg;
    if (run < step || structure) continue;
    run -= step;
    const side = spacingAt(b.x, b.y, runsAcross);
    const nx = -Math.sin(along) * side;
    const ny = Math.cos(along) * side;
    for (const hand of [1, -1]) {
      out.push({ x: b.x + nx * hand, y: b.y + ny * hand, along, parent: curve.id, depth, onParent: false });
    }
    // A seed on the curve itself grows a road out of a junction with it. A
    // highway takes one only at an interchange, and only from an arterial ramp
    // (spec section 6.2), so the minor fill seeds nothing on one.
    const junctionable = curve.tier !== 'highway' || (opts.ramps === true && curve.interchanges.includes(i + 1));
    if (junctionable) out.push({ x: b.x, y: b.y, along: along + Math.PI / 2, parent: curve.id, depth, onParent: true });
  }
}

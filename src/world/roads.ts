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
 * Streets, alleys and dirt roads come last. They are the same fill as the
 * arterials, with two differences: the spacing comes from the density of the
 * district under the seed, so a dense district gets tight blocks, and the tier
 * comes from its zone. A road that met nothing on one side is a dead end, and a
 * dead end is trimmed to a cul-de-sac rather than left running into nothing.
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
 * the network laid so far is `road-index.ts`.
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
import { connectCrossings } from './connect.ts';
import { districtAt, layoutZones, zoneAt } from './districts.ts';
import { raiseOverpasses } from './overpass.ts';
import { JOIN_EPSILON } from './road-index.ts';
import {
  alignTo,
  ALLEY,
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

/**
 * What the minor fill lays in each zone: the tier, and the metres between
 * neighbouring roads of it. A district holds the tight spacing when its density
 * is 1 and the loose one when it is 0, so blocks shrink toward downtown.
 */
const MINOR_BY_ZONE: Record<Zone, { tier: RoadTier; tight: number; loose: number }> = {
  core: { tier: 'street', tight: 70, loose: 95 },
  inner: { tier: 'street', tight: 80, loose: 115 },
  industrial: { tier: 'street', tight: 115, loose: 155 },
  suburban: { tier: 'street', tight: 90, loose: 135 },
  outskirts: { tier: 'dirt', tight: 190, loose: 270 },
  wilderness: { tier: 'dirt', tight: 300, loose: 430 },
};

/** What the fill lays where it is seeded. */
interface FillPlan {
  tier: RoadTier;
  params: TierParams;
  /** Metres between neighbouring roads of this tier here. */
  spacing: number;
  /** Metres a road may run past its seed without meeting another road. */
  deadEnd: number;
  /** Ground this tier may stand on. */
  within: (x: number, y: number) => boolean;
}

/** Where the fill should try to lay its next road. */
interface FillSeed {
  x: number;
  y: number;
  /** Direction of the road that seeded this one; the new road runs parallel to it. */
  along: number;
  /** Curve the seed came from, which the new road may not immediately rejoin. */
  parent: number;
  /** How many arterials removed from the highways this one is. */
  depth: number;
  /** True when the seed sits on its parent, so the road it grows is joined to the network from its first point. */
  onParent: boolean;
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

class RoadTracer extends RoadTrace {

  build(): TracedRoads {
    this.traceHighways();
    this.linkIslands();
    this.fillArterials();
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

  /** One highway: the field line through a point, followed both ways. */
  private streamline(at: Point, minor: boolean): RoadCurve | undefined {
    const line = this.fieldLine(at, minor);
    const opt: TraceOptions = { params: HIGHWAY, joiner: 'highway', minor, mergeAfter: HIGHWAY_MERGE_AFTER };
    const forward = this.trace(at, { ...opt, heading: line });
    const backward = this.trace(at, { ...opt, heading: line + Math.PI });
    backward.points.reverse();
    const points = [...backward.points.slice(0, -1), ...forward.points];
    if (polylineLength(points) < MIN_HIGHWAY * this.size) return undefined;
    // The point it was seeded at is an interchange, so the road it grew out of
    // and this one meet at a junction both of them allow.
    return this.addCurve('highway', points, [], interchangesOf(points, backward.points.length - 1));
  }

  // ----------------------------------------------------------------- islands

  /**
   * Bridge out to every island that carries a district, over the strait
   * crossings of the water description. Islands are linked outward from the
   * main one, so each bridge lands on ground the network has already reached.
   */
  private linkIslands(): void {
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

    for (const island of order) {
      if (needed[island] === 1) this.linkIsland(island, parent[island] as number);
    }
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
      deadEnd: Infinity,
      // Off the sand, like the minor fill: a beach is served from the boardwalk
      // behind its dune, never paved across (spec section 7.3).
      within: (x, y) => zoneAt(zones, x, y) !== 'wilderness' && this.offSand(x, y),
    };
    const seeds: FillSeed[] = [];
    for (const curve of this.curves) seedAlong(curve, () => spacing, 0, seeds, true, true);
    this.grow(seeds, () => plan, FILL_GENERATIONS, FILL_LIMIT);
  }

  // ------------------------------------------------------------ minor roads

  /**
   * Streets, alleys and dirt roads between the arterials (spec section 6.2).
   * The zone under a seed decides the tier and the block size it aims for, and
   * the density of the district under it decides where in that range the
   * spacing lands. Alleys come last, seeded half a block off the streets, so
   * they cut through the inside of a dense block rather than doubling a street.
   */
  private fillMinor(): void {
    const zones = layoutZones(this.size, this.world.core, this.world.water);
    const districts = this.world.districts;
    const spacingAt = (x: number, y: number): number => {
      const spec = MINOR_BY_ZONE[zoneAt(zones, x, y)];
      return lerp(spec.loose, spec.tight, clamp(districtAt(districts, zones, x, y).density, 0, 1));
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
    const streetPlan = (x: number, y: number): FillPlan => {
      const tier = tierAt(x, y);
      const spacing = spacingAt(x, y);
      return {
        tier,
        params: tier === 'dirt' ? DIRT : STREET,
        spacing,
        deadEnd: spacing * DEAD_END_SPACINGS,
        within: tier === 'dirt' ? unpaved : paved,
      };
    };
    const seeds: FillSeed[] = [];
    for (const curve of [...this.curves]) seedAlong(curve, spacingAt, 0, seeds);
    const streets = this.grow(seeds, streetPlan, MINOR_GENERATIONS, MINOR_LIMIT);

    const dense = (x: number, y: number): boolean =>
      paved(x, y) && districtAt(districts, zones, x, y).density >= ALLEY_DENSITY;
    const alleyPlan = (x: number, y: number): FillPlan => {
      const spacing = spacingAt(x, y) / 2;
      return { tier: 'alley', params: ALLEY, spacing, deadEnd: spacing * DEAD_END_SPACINGS, within: dense };
    };
    const alleySeeds: FillSeed[] = [];
    for (const curve of streets) {
      if (curve.tier === 'street') seedAlong(curve, (x, y) => spacingAt(x, y) / 2, 0, alleySeeds, false);
    }
    this.grow(alleySeeds, alleyPlan, 1, MINOR_LIMIT);
  }

  // -------------------------------------------------------------------- fill

  /**
   * Grow one tier out of the roads already laid, seed by seed. A seed on ground
   * another road already covers is skipped, which is what keeps blocks near
   * their spacing, and a road is kept only if it joins the network, so the fill
   * can never leave one dangling. Roads laid here seed the next generation.
   */
  private grow(seeds: FillSeed[], planAt: (x: number, y: number) => FillPlan, generations: number, limit: number): RoadCurve[] {
    const laid: RoadCurve[] = [];
    for (let i = 0; i < seeds.length && laid.length < limit; i++) {
      const seed = seeds[i] as FillSeed;
      if (!this.isDry(seed.x, seed.y)) continue;
      const plan = planAt(seed.x, seed.y);
      if (!plan.within(seed.x, seed.y)) continue;
      // A road begins at its seed, so a seed standing on a road this tier may
      // not junction with would make the junction anyway. A street seeded where
      // an arterial ramp meets a highway is that case (spec section 6.2).
      if (this.index.refuses(seed.x, seed.y, plan.tier)) continue;
      // Somewhere already covered: a road within half a spacing, other than the parent.
      if (this.index.nearest(seed.x, seed.y, plan.spacing * 0.5, seed.parent) !== undefined) continue;
      const curve = this.fillRoad(seed, plan);
      if (curve === undefined) continue;
      laid.push(curve);
      if (seed.depth + 1 < generations) seedAlong(curve, (x, y) => planAt(x, y).spacing, seed.depth + 1, seeds);
    }
    return laid;
  }

  /** One fill road, traced both ways along the field line it was seeded with. */
  private fillRoad(seed: FillSeed, plan: FillPlan): RoadCurve | undefined {
    const params = plan.params;
    const major = this.field.majorAt(seed.x, seed.y);
    const minor = directionDelta(major, seed.along) > Math.PI / 4;
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
    if (polylineLength(points) < plan.spacing * 0.5) return undefined;
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
 * Seeds for the next generation of the fill. Every `spacing` along a curve: one
 * seed to each side, that far out and pointing the same way, and, when `across`
 * is set, one on the curve itself pointing across it. The first two lay the
 * parallel roads that carry the traffic, the third the cross streets that tie
 * them together. An alley wants only the first two: it runs down the middle of
 * a block, and a block cross-hatched with alleys is no longer a block. The
 * spacing is asked for at each point, so it can follow the district under it.
 *
 * `ramps` says the tier being seeded may junction with a highway. Only the
 * arterial fill sets it, and even then a seed stands on a highway only at one
 * of its interchanges (spec section 6.2).
 */
function seedAlong(
  curve: RoadCurve,
  spacingAt: (x: number, y: number) => number,
  depth: number,
  out: FillSeed[],
  across = true,
  ramps = false,
): void {
  const points = curve.points;
  const head = points[0] as Point;
  let run = spacingAt(head.x, head.y) / 2;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const seg = dist(a.x, a.y, b.x, b.y);
    if (seg === 0) continue;
    // A deck or a bore seeds nothing: there is no ground beside the road there.
    const structure = curve.bridges.includes(i) || curve.tunnels.includes(i);
    run += seg;
    const spacing = spacingAt(b.x, b.y);
    if (run < spacing || structure) continue;
    run -= spacing;
    const along = Math.atan2(b.y - a.y, b.x - a.x);
    const nx = -Math.sin(along) * spacing;
    const ny = Math.cos(along) * spacing;
    for (const side of [1, -1]) {
      out.push({ x: b.x + nx * side, y: b.y + ny * side, along, parent: curve.id, depth, onParent: false });
    }
    // A seed on the curve itself grows a road out of a junction with it. A
    // highway takes one only at an interchange, and only from an arterial ramp
    // (spec section 6.2), so the minor fill seeds nothing on one.
    const junctionable = curve.tier !== 'highway' || (ramps && curve.interchanges.includes(i + 1));
    if (across && junctionable) out.push({ x: b.x, y: b.y, along: along + Math.PI / 2, parent: curve.id, depth, onParent: true });
  }
}

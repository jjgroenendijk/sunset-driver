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
 * extends and this extends in turn, and
 * the graph every road is added to is `road-network.ts`. The seed and plan the fills speak
 * in, and the zone table they read, are `fill.ts`.
 *
 * Five invariants hold by construction, and the seed sweep checks them:
 *
 * - Every curve starts on an existing road, ends on one, or merges into one, so
 *   the whole network is a single connected component. A trace that reaches
 *   neither is dropped rather than left dangling.
 * - No segment passes over water unless it is a bridge, and a bridge only ever
 *   spans one of the water description's strait crossings.
 * - No segment laid on the ground exceeds its tier's maximum grade.
 * - No road shares a point with a highway away from one of its interchanges,
 *   and no street, alley or dirt road shares one with a highway at all. No
 *   road crosses a highway away from one of its slots.
 * - No road runs along another road's carriageway or ends inside it. Two roads
 *   touch only where they share a point or cross, at an angle a junction or an
 *   overpass can be built at (`network-clearance.ts`).
 */
import { clamp, dist, directionDelta, lerp, wrapAngle } from '../core/math.ts';
import { alleyPlan, alleySeeds, type AlleyGround } from './alleys.ts';
import { ZONE_LOTS } from './buildings.ts';
import { connectCrossings, crossPoint } from './connect.ts';
import { districtAt, layoutZones, zoneAt } from './districts.ts';
import { MINOR_BY_ZONE, type FillPlan, type FillSeed, type PlanAt, type SpacingAt } from './fill.ts';
import { raiseOverpasses } from './overpass.ts';
import { zoneMinBuilt } from './parcels.ts';
import { HighwayTrace } from './highways.ts';
import {
  alignTo,
  ALLEY_DENSITY,
  ANCHOR_REACH,
  ARTERIAL,
  ARTERIAL_SPACING,
  DEAD_END_SPACINGS,
  DIRT,
  FILL_GENERATIONS,
  FILL_LIMIT,
  groundRule,
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
import { footprintHalfWidth, TIERS } from './tiers.ts';
import type { Beach, Island, Point, RoadCurve, RoadTier, WorldSkeleton, Zone } from './types.ts';

// The trace itself is next door, and `roads.ts` is the door onto both: the
// ground rules and the boardwalk length come out through here, as they did
// while the two halves were one file.
export { groundRule, MIN_BOARDWALK, spanProfile, type Profile } from './road-trace.ts';

/** Places a bridge's near head is tried at before the crossing is given up. */
const HEAD_TRIES = 12;

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

class RoadTracer extends HighwayTrace {

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
    // Before the minor fill, so the fill grows around the boardwalk instead of
    // laying its own streets over the same ground.
    const boardwalks = this.world.beaches.map((beach, i) => this.traceBoardwalk(beach, i));
    this.fillMinor();
    // The trace only ever ends a road on a point of another one, so two roads
    // that cross between their points have met nothing yet.
    const connected = connectCrossings(this.curves, groundRule(this.hf, this.seaLevel));
    // Last, on curves that no longer move: a road that crosses another one and
    // does not meet it there is carried over it (spec section 6.2).
    return { roads: raiseOverpasses(connected), boardwalks };
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
      const heads = this.bridgeHeads(nearShore, farShore);
      if (heads === undefined) continue;
      const [near, far, joined] = heads;
      // A head on the network is where the bridge joins it already.
      const approach = joined ? [near] : this.routeToNetwork(near, this.islandOf(near.x, near.y));
      if (approach === undefined) continue;
      approach.reverse();
      const landing = this.landOnIsland(far, island);
      this.addCurve('arterial', [...approach, ...landing], [approach.length - 1]);
      return;
    }
  }

  /**
   * The two heads of a bridge, the best places first, and whether the near head
   * is a point of the network. The deck between them is one straight segment,
   * and a highway it would cross away from one of its slots refuses the pair.
   *
   * Where no pair on open ground will do, the near head may stand on a point of
   * the network an arterial may join, nearest first. That is the highway that
   * runs along the shore and took the ground a head would stand on: the bridge
   * joins it at its interchange instead of crossing it.
   */
  private bridgeHeads(nearShore: Point, farShore: Point): [Point, Point, boolean] | undefined {
    const fars = this.dryAnchors(farShore, nearShore);
    for (const near of this.dryAnchors(nearShore, farShore).slice(0, HEAD_TRIES)) {
      const far = fars.find((p) => this.network.crossesAtSlots(near, p, 'arterial'));
      if (far !== undefined) return [near, far, false];
    }
    for (const hit of this.network.within(nearShore.x, nearShore.y, ANCHOR_REACH, -1, 'arterial')) {
      const near = { x: hit.x, y: hit.y };
      if (this.network.refuses(near.x, near.y, 'arterial')) continue;
      const far = fars.find((p) => this.network.meets(near, p, 'arterial'));
      if (far !== undefined) return [near, far, true];
    }
    return undefined;
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
    const ahead = forward.merged ? forward.points : trimTo(forward.points, forward.clear, plan.deadEnd);
    const behind = backward.merged ? backward.points : trimTo(backward.points, backward.clear, plan.deadEnd);
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
      if (this.network.nearest(site.x, site.y, SERVED) !== undefined) continue;
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
  private traceBoardwalk(beach: Beach, i: number): number {
    this.network.release(-1 - i);
    const line = this.longestRunnable(beach.boardwalk, STREET.maxGrade);
    if (polylineLength(line) < MIN_BOARDWALK) return -1;
    // The line is held while its ends reach for the network, so neither end
    // runs back along the boardwalk itself.
    this.network.reserve(-1 - i, 'street', line);
    const head = this.besideOwnCrossing(line, this.reachNetwork(line[0] as Point));
    const tail = this.besideOwnCrossing(line, this.reachNetwork(line[line.length - 1] as Point));
    this.network.release(-1 - i);
    if (head.length === 0 && tail.length === 0) return -1;
    const points = [...[...head].reverse(), ...line, ...tail];
    return this.addCurve('street', points, [])?.id ?? -1;
  }

  /**
   * A route from a boardwalk end to the network, or nothing where it ends on a
   * road beside a place the boardwalk line crosses that road. `connect.ts`
   * gives two roads that already meet no second junction inside the first
   * one, so that crossing would stay a crossing on the ground.
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

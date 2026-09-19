/**
 * The police (spec section 14): who comes, how they drive and what ends a
 * chase.
 *
 * The heat of `crime.ts` says how many units are out and what kind. A unit is
 * dispatched a district's response time after the force finds itself short of
 * one, comes in on a road near the player, and from then on is routed over the
 * road graph by `unit-route.ts`. It is routed to a place, never along the
 * player's own path: one car drives at where the player was last seen, another
 * at a junction ahead of them, and a third parks across one as a roadblock.
 * That is what lets the police cut a player off rather than trail them.
 *
 * What the police know is `PoliceState.lastKnown`, and they only know it while
 * somebody can see it. A unit sees the player inside its own range; the
 * helicopter's is much longer. The tick of the last sighting is what
 * {@link decayHeat} cools the heat from, so breaking away and wrecking the
 * pursuers are the same rule reached two ways, which is the pair of exits the
 * spec allows.
 *
 * Everything here is plain data stepped from `(seed, tick)`: no wall clock, no
 * unseeded randomness, and the units are stepped in id order, so a replayed
 * run is chased by the same cars over the same streets.
 */
import { rngFor, Subsystem } from '../core/rng.ts';
import { atan2, cos, hypot, sin } from '../core/libm.ts';
import { districtAt, layoutZones } from '../world/districts.ts';
import type { District, WorldDescription } from '../world/types.ts';
import { TICK_RATE } from './clock.ts';
import { CRIME_HEAT, decayHeat, heatStars, raiseHeat, type Crime } from './crime.ts';
import { dropPoliceCar } from './pickup.ts';
import { UnitRoads, type DrivePose } from './unit-route.ts';
import type { SimState } from './simulation.ts';
import type { TrafficRoads } from './traffic.ts';
import { headingOf } from './vehicle.ts';

/** What a unit is: a car of the force, or the helicopter of high heat. */
export type PoliceKind = 'patrol' | 'interceptor' | 'swat' | 'helicopter';

/** What a unit is doing (spec section 14). */
export type PoliceTask =
  /** Driving at where the player was last seen. */
  | 'chase'
  /** Driving at a junction ahead of the player, to meet them coming. */
  | 'cutoff'
  /** Driving at a junction further ahead, and standing across it once there. */
  | 'block'
  /** Nobody has seen the player for a while: casting about the last sighting. */
  | 'search';

/** One police unit, as the record carries it. */
export interface PoliceUnit {
  id: number;
  kind: PoliceKind;
  task: PoliceTask;
  /** Where it stands on the map, and which way it faces. */
  x: number;
  y: number;
  heading: number;
  /** The road height under it; the helicopter flies {@link HELICOPTER_HEIGHT} over it. */
  height: number;
  /** Metres per second it covered over the last tick. */
  speed: number;
  /** What the car has left, of {@link UNIT_ARMOUR}. A unit at 0 is wrecked and gone. */
  health: number;
  /** The edges of the drive it is on, in order. Empty on the helicopter, which flies. */
  edges: number[];
  /** Metres covered along that drive. */
  distance: number;
  /** The tick the drive was planned at, so it is planned again on a cadence. */
  planned: number;
  /** Where it is driving to. */
  goalX: number;
  goalY: number;
}

/** What the police know and who is out (spec section 14). */
export interface PoliceState {
  units: PoliceUnit[];
  /** The id the next unit is given, so no two units of a session share one. */
  nextUnit: number;
  /** Where the player was last seen, or null while the police have never seen them. */
  lastKnown: { x: number; y: number } | null;
  /** The tick a unit last saw the player. Long in the past when none has. */
  seenTick: number;
  /** The earliest tick the next unit may come out on, which is the response time. */
  dispatchTick: number;
}

/**
 * What a police car takes before it is wrecked, in the shares `damage.ts`
 * measures a vehicle in: 1 is a whole civilian car, so a patrol car stands a
 * little more shooting than the one the player drives.
 */
export const UNIT_ARMOUR = 1.4;

/** Metres a car sees the player over, and the much longer sight of the helicopter. */
export const SIGHT_RANGE = 70;
export const HELICOPTER_SIGHT = 220;

/** Metres over the ground the helicopter flies. */
export const HELICOPTER_HEIGHT = 45;

/** Metres per second each kind drives or flies at. */
export const UNIT_SPEED: Record<PoliceKind, number> = {
  patrol: 26,
  interceptor: 34,
  swat: 24,
  helicopter: 40,
};

/** How much of a road's speed limit a unit drives, which is over it: they are in a hurry. */
const URGENCY = 1.25;

/** Units out at each star of heat, from none at all to the full force. */
export const UNITS_BY_STAR: readonly number[] = [0, 1, 2, 3, 4, 6, 8];

/** Stars at which the helicopter comes up, and at which the heavy units come out. */
export const HELICOPTER_STARS = 4;
export const INTERCEPTOR_STARS = 3;
export const SWAT_STARS = 5;

/** Ticks between one dispatch and the next, on top of the district's response time. */
const DISPATCH_GAP = 2 * TICK_RATE;

/** Ticks a unit drives before its route is planned again against what the police now know. */
const REPLAN = 2 * TICK_RATE;

/** Metres from the player a unit comes in at, which is beyond what the camera shows. */
const SPAWN_RANGE = 260;

/** Metres ahead of the player a cut-off and a roadblock are aimed. */
const CUTOFF_LEAD = 120;
const BLOCK_LEAD = 260;

/**
 * Metres from its goal a unit pulls up at. A car that has arrived stands there
 * — across the road at a block, beside the player at the end of a chase — and
 * does not drive round the block it is already on.
 */
const HOLD_RANGE = 8;

/** Metres round the last sighting a searching unit casts about in. */
const SEARCH_RADIUS = 120;

/** Ticks with nobody in sight before the units give up the chase and search. */
const SEARCH_DELAY = 5 * TICK_RATE;

/** Metres a unit takes a player on foot in from, and the speed they have to be under. */
const ARREST_RANGE = 6;
const ARREST_SPEED = 4;

/** Metres a unit stands off the player before it is taken off the map once the heat is out. */
const STAND_DOWN_RANGE = 150;

/** Seconds of response, before the district is counted. */
const RESPONSE_BASE = 6;

/** How long each zone takes to answer, as a share of {@link RESPONSE_BASE}: downtown is immediate. */
export const ZONE_RESPONSE: Record<District['zone'], number> = {
  core: 0.5,
  inner: 0.8,
  industrial: 1.6,
  suburban: 1.4,
  outskirts: 2.4,
  wilderness: 4,
};

/** A place on the map with a way of facing: what the police are chasing. */
interface Quarry {
  x: number;
  y: number;
  heading: number;
  speed: number;
}

/** What the district a place stands in says about how fast the police answer. */
export type Response = Pick<District, 'zone' | 'wealth'>;

/** What the world tells the police about where the player stands. */
export type DistrictAt = (x: number, y: number) => Response;

/** The districts of a generated world, as the police read them: how fast each answers. */
export function policeDistrictsOf(world: WorldDescription): DistrictAt {
  const zones = layoutZones(world.size, world.core, world.water);
  return (x, y) => districtAt(world.districts, zones, x, y);
}

export function createPoliceState(): PoliceState {
  return { units: [], nextUnit: 0, lastKnown: null, seenTick: -1_000_000, dispatchTick: 0 };
}

/**
 * Call every unit off at once and forget where the player was, as an arrest or
 * a death does. `nextUnit` carries on, because it keys the stream of each unit.
 */
export function standDownAll(state: SimState): void {
  const fresh = createPoliceState();
  state.police.units = [];
  state.police.lastKnown = fresh.lastKnown;
  state.police.seenTick = fresh.seenTick;
  state.police.dispatchTick = state.tick;
}

/**
 * Seconds before a unit is dispatched where the player stands. A wealthy
 * district downtown answers at once; the wilderness takes the best part of a
 * minute (spec section 14).
 */
export function responseTicks(district: Response): number {
  const wealth = 1.3 - 0.6 * district.wealth;
  return Math.round(RESPONSE_BASE * TICK_RATE * ZONE_RESPONSE[district.zone] * wealth);
}

/**
 * Report something the player has done: it raises the heat, and it tells the
 * police where it happened. The cooling of `crime.ts` is measured from the last
 * thing they know, so a crime nobody was standing next to still starts the
 * clock where it was committed. Every raise of the heat goes through here.
 */
export function report(state: SimState, amount: number): void {
  state.heat = raiseHeat(state.heat, amount);
  if (amount <= 0) return;
  const quarry = quarryOf(state);
  state.police.lastKnown = { x: quarry.x, y: quarry.y };
  state.police.seenTick = state.tick;
}

/** Add what a crime is worth to the heat. The one door every crime goes through. */
export function commitCrime(state: SimState, crime: Crime): void {
  report(state, CRIME_HEAT[crime]);
}

/**
 * Put a round or a blast into a unit: what it costs the car, and what shooting
 * at officers costs the player. A whole car's worth of damage is one assault,
 * and wrecking the car is a killing on top of it, which is the hard escalation
 * the spec asks for. A wrecked unit reports nothing, so destroying the
 * pursuers ends the sighting and starts the heat cooling: that is the second of
 * the spec's two exits.
 */
export function shootUnit(state: SimState, id: number, share: number): void {
  report(state, CRIME_HEAT.officerAssault * share);
  if (hurtUnit(state, id, share)) report(state, CRIME_HEAT.officerKilling);
}

/**
 * Put a blast into every unit inside its radius, in id order. `falloff` answers
 * how much of the blast is felt at a distance, which is `weapon.ts`'s own rule.
 */
export function blastUnits(state: SimState, x: number, y: number, severity: number, falloff: (distance: number) => number): void {
  for (const unit of [...state.police.units]) {
    if (unit.kind === 'helicopter') continue;
    const share = falloff(hypot(unit.x - x, unit.y - y));
    if (share <= 0) continue;
    shootUnit(state, unit.id, severity * share);
  }
}

/**
 * Take health off a unit, and take the unit off the map once it has none left.
 * Answers true when this took the last of it.
 */
export function hurtUnit(state: SimState, id: number, amount: number): boolean {
  const units = state.police.units;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i] as PoliceUnit;
    if (unit.id !== id) continue;
    unit.health -= amount;
    if (unit.health > 0) return false;
    // What the car was carrying is left where it stopped (spec section 11.6),
    // which is how a player arms themselves off the force.
    dropPoliceCar(state, unit.id, unit.x, unit.y, unit.height);
    units.splice(i, 1);
    return true;
  }
  return false;
}

/** Where the player is as the police see them: their car when they are driving, themselves when not. */
export function quarryOf(state: SimState): Quarry {
  const p = state.player;
  if (!p.driving) return { x: p.x, y: p.y, heading: p.heading, speed: Math.abs(p.speed) };
  const v = state.vehicle;
  return { x: v.x, y: v.z, heading: headingOf(v), speed: Math.abs(v.speed) };
}

/**
 * The police of one session: the road network they drive and the districts they
 * answer from. It holds no state of the chase — that is all on the record — so
 * a save is loaded and the same force carries on from it.
 */
export class PoliceForce {
  private readonly roads: UnitRoads;
  private readonly districtAt: DistrictAt;
  private readonly pose: DrivePose = { x: 0, y: 0, height: 0, heading: 0 };
  /** The units that were out last tick, so the routes of the ones that have gone are forgotten. */
  private out: number[] = [];

  constructor(roads: TrafficRoads, districtAt: DistrictAt) {
    this.roads = new UnitRoads(roads);
    this.districtAt = districtAt;
  }

  /**
   * One tick of the whole system: what the police can see, what the heat does
   * about it, who comes out, and where every unit gets to. Called from the
   * physics, after the world has been stepped, so the units answer the tick the
   * player has just driven.
   */
  step(state: SimState): void {
    const police = state.police;
    const quarry = quarryOf(state);
    this.look(state, quarry);
    state.heat = decayHeat(state.heat, state.tick, police.seenTick);
    this.dispatch(state, quarry);
    const searching = state.tick - police.seenTick >= SEARCH_DELAY;
    for (let i = 0; i < police.units.length; i++) {
      const unit = police.units[i] as PoliceUnit;
      unit.task = this.taskOf(i, searching);
      this.aim(state, unit, quarry);
      if (unit.kind === 'helicopter') this.fly(unit);
      else this.drive(state, unit);
    }
    this.arrest(state, quarry);
    this.standDown(state, quarry);
    this.sweep(state);
  }

  /**
   * Forget the route of every unit that is no longer out — one that was wrecked,
   * or stood down — so the cache does not grow with the session.
   */
  private sweep(state: SimState): void {
    const ids = state.police.units.map((unit: PoliceUnit) => unit.id);
    for (const id of this.out) {
      if (!ids.includes(id)) this.roads.forget(id);
    }
    this.out = ids;
  }

  /**
   * What every unit can see. A sighting writes the place down and stamps the
   * tick, which is the only thing that holds the heat up.
   */
  private look(state: SimState, quarry: Quarry): void {
    for (const unit of state.police.units) {
      const range = unit.kind === 'helicopter' ? HELICOPTER_SIGHT : SIGHT_RANGE;
      if (hypot(unit.x - quarry.x, unit.y - quarry.y) > range) continue;
      state.police.lastKnown = { x: quarry.x, y: quarry.y };
      state.police.seenTick = state.tick;
      return;
    }
  }

  /**
   * Bring a unit out when the force is short of one and the district has had
   * time to answer. A unit comes in on a road {@link SPAWN_RANGE} from the
   * player, on a bearing of the tick's own stream, so it arrives from a
   * different quarter each time.
   */
  private dispatch(state: SimState, quarry: Quarry): void {
    const police = state.police;
    const stars = heatStars(state.heat);
    const wanted = UNITS_BY_STAR[Math.min(stars, UNITS_BY_STAR.length - 1)] as number;
    if (police.units.length >= wanted) {
      police.dispatchTick = Math.max(police.dispatchTick, state.tick);
      return;
    }
    if (state.tick < police.dispatchTick) return;
    const id = police.nextUnit;
    const kind = this.kindFor(state, stars);
    const rng = rngFor(state.seed, state.tick, Subsystem.Police, id);
    const bearing = rng.float() * Math.PI * 2;
    // A unit comes in round what the police know, which is where the player was
    // last seen and not where they now are: a car sent out after the player has
    // broken away must not arrive on top of them.
    const known = police.lastKnown ?? { x: quarry.x, y: quarry.y };
    const x = known.x + cos(bearing) * SPAWN_RANGE;
    const y = known.y + sin(bearing) * SPAWN_RANGE;
    const unit = this.raise(id, kind, x, y);
    if (unit === undefined) return;
    police.nextUnit = id + 1;
    police.units.push(unit);
    police.dispatchTick = state.tick + DISPATCH_GAP + responseTicks(this.districtAt(quarry.x, quarry.y));
  }

  /**
   * A unit standing on the road nearest a place, or undefined where there is no
   * road to come in on. The helicopter needs none: it starts in the air where
   * it was called to.
   */
  private raise(id: number, kind: PoliceKind, x: number, y: number): PoliceUnit | undefined {
    const unit: PoliceUnit = {
      id,
      kind,
      task: 'chase',
      x,
      y,
      heading: 0,
      height: 0,
      speed: 0,
      health: UNIT_ARMOUR,
      edges: [],
      distance: 0,
      planned: -REPLAN,
      goalX: x,
      goalY: y,
    };
    if (kind === 'helicopter') return unit;
    const edge = this.roads.edgeNear(x, y);
    if (edge < 0) return undefined;
    unit.edges = [edge];
    this.roads.pose(id, unit.edges, 0, this.pose);
    unit.x = this.pose.x;
    unit.y = this.pose.y;
    unit.height = this.pose.height;
    unit.heading = this.pose.heading;
    return unit;
  }

  /** The kind the next unit is, which is what the heat has escalated to (spec section 14). */
  private kindFor(state: SimState, stars: number): PoliceKind {
    const flying = state.police.units.some((unit: PoliceUnit) => unit.kind === 'helicopter');
    // The helicopter comes up over a chase that is already running, so the
    // first car to answer is always a car.
    if (stars >= HELICOPTER_STARS && !flying && state.police.units.length >= 2) return 'helicopter';
    if (stars >= SWAT_STARS && state.police.units.length % 3 === 2) return 'swat';
    if (stars >= INTERCEPTOR_STARS) return 'interceptor';
    return 'patrol';
  }

  /**
   * What the unit in a place in the line is doing. The first two drive at the
   * player, the third comes round to meet them and the fourth parks across the
   * road; the rest chase. Nobody chases what nobody has seen for a while: they
   * all search instead.
   */
  private taskOf(index: number, searching: boolean): PoliceTask {
    if (searching) return 'search';
    if (index === 2) return 'cutoff';
    if (index === 3) return 'block';
    return 'chase';
  }

  /**
   * Where a unit is driving. A chase is aimed at the last sighting, a cut-off
   * and a roadblock at a place ahead of the way the player was going, and a
   * search at a place round the last sighting that its own stream picks.
   */
  private aim(state: SimState, unit: PoliceUnit, quarry: Quarry): void {
    const known = state.police.lastKnown ?? { x: quarry.x, y: quarry.y };
    if (unit.task === 'search') {
      // The place is picked once every replan, so a searching car drives a leg
      // and then casts about again rather than twitching every tick.
      const round = Math.floor(state.tick / REPLAN);
      const rng = rngFor(state.seed, round, Subsystem.Police, unit.id);
      const bearing = rng.float() * Math.PI * 2;
      const reach = rng.range(0.3, 1) * SEARCH_RADIUS;
      unit.goalX = known.x + cos(bearing) * reach;
      unit.goalY = known.y + sin(bearing) * reach;
      return;
    }
    const lead = unit.task === 'cutoff' ? CUTOFF_LEAD : unit.task === 'block' ? BLOCK_LEAD : 0;
    // A player standing still is not going anywhere, so the lead is dropped
    // rather than aimed at the way they happen to be pointing.
    const reach = quarry.speed > 2 ? lead : 0;
    unit.goalX = known.x + cos(quarry.heading) * reach;
    unit.goalY = known.y + sin(quarry.heading) * reach;
  }

  /** One tick of a car: route it if it is due, run it along the road, and put it where that is. */
  private drive(state: SimState, unit: PoliceUnit): void {
    const due = state.tick - unit.planned >= REPLAN;
    const length = this.roads.length(unit.edges);
    const arrived = unit.distance >= length;
    if (due || arrived) this.replan(state, unit);
    const held =
      hypot(unit.x - unit.goalX, unit.y - unit.goalY) < HOLD_RANGE ||
      (unit.task === 'block' && unit.distance >= this.roads.length(unit.edges));
    const limit = this.roads.limitAt(unit.id, unit.edges, unit.distance);
    const speed = held ? 0 : Math.min(UNIT_SPEED[unit.kind], limit * URGENCY);
    unit.distance = Math.min(unit.distance + speed / TICK_RATE, this.roads.length(unit.edges));
    this.roads.pose(unit.id, unit.edges, unit.distance, this.pose);
    unit.x = this.pose.x;
    unit.y = this.pose.y;
    unit.height = this.pose.height;
    // A car standing at a roadblock keeps the heading it arrived on rather than
    // reading one off a line it is no longer moving along.
    if (!held) unit.heading = this.pose.heading;
    unit.speed = speed;
  }

  /**
   * Route a car to its goal from the road it is on, so it finishes the run it
   * is driving rather than turning round in the street. A goal the graph cannot
   * be routed to leaves the drive as it was.
   */
  private replan(state: SimState, unit: PoliceUnit): void {
    const from = unit.edges.length > 0 ? this.roads.edgeAt(unit.id, unit.edges, unit.distance) : { edge: this.roads.edgeNear(unit.x, unit.y), into: 0 };
    if (from.edge < 0) return;
    const edges = this.roads.plan(from.edge, unit.goalX, unit.goalY);
    unit.planned = state.tick;
    if (edges === undefined) return;
    unit.edges = edges;
    unit.distance = from.into;
  }

  /** One tick of the helicopter, which flies the straight line the roads are not on. */
  private fly(unit: PoliceUnit): void {
    const dx = unit.goalX - unit.x;
    const dy = unit.goalY - unit.y;
    const gap = hypot(dx, dy);
    const step = UNIT_SPEED.helicopter / TICK_RATE;
    if (gap <= step) {
      unit.x = unit.goalX;
      unit.y = unit.goalY;
      unit.speed = 0;
      return;
    }
    unit.x += (dx / gap) * step;
    unit.y += (dy / gap) * step;
    unit.heading = atan2(dy, dx);
    unit.speed = UNIT_SPEED.helicopter;
  }

  /**
   * A player on foot who lets a car get to them is taken in (spec section
   * 11.7). The respawn of the same tick is what carries it out; a player in a
   * car is not taken, because they are still driving away.
   */
  private arrest(state: SimState, quarry: Quarry): void {
    if (state.heat <= 0 || state.player.driving || quarry.speed > ARREST_SPEED) return;
    for (const unit of state.police.units) {
      if (unit.kind === 'helicopter') continue;
      if (hypot(unit.x - quarry.x, unit.y - quarry.y) > ARREST_RANGE) continue;
      state.arrested = true;
      return;
    }
  }

  /**
   * The call is off once the heat is out: a unit far enough away to go without
   * being seen to vanish is taken off the map, and the near ones drive on until
   * they are.
   */
  private standDown(state: SimState, quarry: Quarry): void {
    if (state.heat > 0) return;
    const units = state.police.units;
    for (let i = units.length - 1; i >= 0; i--) {
      const unit = units[i] as PoliceUnit;
      if (hypot(unit.x - quarry.x, unit.y - quarry.y) < STAND_DOWN_RANGE) continue;
      units.splice(i, 1);
    }
    if (units.length === 0) state.police.lastKnown = null;
  }
}

export { raiseHeat };

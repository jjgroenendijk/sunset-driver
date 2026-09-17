/**
 * The enforcers a faction sends after the player (spec section 17.2).
 *
 * Taking a block calls a wave, and taking it calls the next one: that is the
 * retaliation the spec asks for, and it is what a capture costs. An enforcer
 * comes in on a street a couple of blocks away, walks the road graph at the
 * player through `unit-route.ts` — the same routing the police drive — and
 * shoots once they are close enough. They carry their own faction's arsenal
 * (`faction.ts`), so being hunted by the Bratva is not being hunted by the
 * Syndicate.
 *
 * They are people rather than cars, so the crowd mesh draws them and they cost
 * no draw call of their own (`src/ui/enforcers.ts`), exactly as the dealers of
 * spec section 16.2 do.
 *
 * Two things they do not do yet, and both are limits of what is around them
 * rather than of this file. Nobody on foot in this game carries a collider, so
 * an enforcer cannot be shot back at; and there is no line of sight in the
 * record, so they fire only inside {@link ENFORCER_RANGE}, which is short
 * enough that a wall is rarely between them. The player's answer is the one the
 * spec gives them: hold the ground and take it, or get in a car and leave.
 *
 * Everything here is plain data stepped from `(seed, tick)`, and the units are
 * stepped in id order, so a replayed session is met by the same people on the
 * same corners.
 */
import { rngFor, Subsystem } from '../core/rng.ts';
import { TICK_RATE } from './clock.ts';
import { FACTIONS, type Faction } from './faction.ts';
import { hurt } from './on-foot.ts';
import type { SimState } from './simulation.ts';
import { blockAt, blockMiddle, type TerritoryMap } from './territory.ts';
import type { TrafficRoads } from './traffic.ts';
import { UnitRoads, type DrivePose } from './unit-route.ts';
import { weaponOf, type WeaponId } from './weapon.ts';

/** One enforcer, as the record carries one. */
export interface EnforcerUnit {
  id: number;
  /** The faction that sent them; the row of {@link FACTIONS}. */
  faction: number;
  /** The weapon in their hands, off their faction's arsenal. */
  weapon: WeaponId;
  x: number;
  y: number;
  /** The road height under them. */
  height: number;
  heading: number;
  /** Metres per second they covered over the last tick. */
  speed: number;
  /** How far through their stride they are, so the crowd mesh draws a walk. */
  cycle: number;
  /** The edges of the walk they are on, in order. */
  edges: number[];
  /** Metres covered along it. */
  distance: number;
  /** The tick the walk was planned at, so it is planned again on a cadence. */
  planned: number;
  /** The tick they last fired on. */
  fired: number;
  goalX: number;
  goalY: number;
}

/** The enforcers that are out (spec section 17.2). */
export interface EnforcerState {
  units: EnforcerUnit[];
  /** The id the next one is given, so no two of a session share one. */
  nextUnit: number;
  /** The earliest tick the next one may come out on. */
  sentTick: number;
}

/** Enforcers one wave puts on the street. A later round sends one more. */
export const WAVE_UNITS = 3;

/** Ticks between one enforcer arriving and the next. */
const SEND_GAP = 3 * TICK_RATE;

/** Metres from the player one comes in at, which is past what the camera shows. */
const SPAWN_RANGE = 180;

/** Metres per second an enforcer walks at, which is a hurried one. */
const ENFORCER_SPEED = 4.2;

/** Metres one stride of that walk covers, so the crowd mesh moves their legs with them. */
const STRIDE = 1.5;

/** Ticks one walks before its route is planned again against where the player now is. */
const REPLAN = 2 * TICK_RATE;

/**
 * Metres they shoot over. It is far shorter than the weapons carry, because
 * nothing in the record says whether a wall is in the way: inside this, on a
 * street they walked down to get here, one rarely is.
 */
export const ENFORCER_RANGE = 16;

/** Metres they hold off at, so they stand and shoot rather than walking into the player. */
const HOLD_RANGE = 3;

/** How much of a weapon's damage one shot of theirs takes off the player. */
const HIT_SHARE = 0.55;

/** Metres from the block they were called to at which they give up and go home. */
const GIVE_UP_RANGE = 420;

/** Metres past the player one is taken off the map at, once the wave is over. */
const STAND_DOWN_RANGE = 160;

export function createEnforcerState(): EnforcerState {
  return { units: [], nextUnit: 0, sentTick: 0 };
}

/** Ticks between two shots of a weapon, from its rate of fire. Never less than one. */
function fireGap(weapon: WeaponId): number {
  const rpm = weaponOf(weapon).rpm;
  return Math.max(1, Math.round((60 * TICK_RATE) / Math.max(1, rpm)));
}

/**
 * The enforcers of one session: the road network they walk and the turf they
 * are called out over. It holds no state of the fight — that is all on the
 * record — so a save is loaded and the same people carry on walking.
 */
export class EnforcerGang {
  private readonly roads: UnitRoads;
  private readonly territory: TerritoryMap;
  private readonly pose: DrivePose = { x: 0, y: 0, height: 0, heading: 0 };
  /** The units that were out last tick, so the routes of the ones that have gone are forgotten. */
  private out: number[] = [];

  constructor(roads: TrafficRoads, territory: TerritoryMap) {
    this.roads = new UnitRoads(roads);
    this.territory = territory;
  }

  /**
   * One tick of the whole system: who is sent, where each of them gets to, and
   * what they do when they arrive. Called from the physics after the world has
   * been stepped, so they answer the tick the player has just walked.
   */
  step(state: SimState): void {
    const wave = state.factions.wave;
    if (wave !== null && this.lost(state)) state.factions.wave = null;
    this.send(state);
    for (const unit of state.enforcers.units) {
      this.aim(state, unit);
      this.walk(state, unit);
      this.shoot(state, unit);
    }
    this.standDown(state);
    this.sweep(state);
  }

  /**
   * True once the wave has nothing left to come for: the player has left the
   * quarter the block stands in, so the faction is not chasing them across the
   * city over one street corner.
   */
  private lost(state: SimState): boolean {
    const wave = state.factions.wave;
    if (wave === null) return false;
    const at = blockAt(wave.block);
    const middle = blockMiddle(at.bx, at.by);
    return Math.hypot(state.player.x - middle.x, state.player.y - middle.y) > GIVE_UP_RANGE;
  }

  /**
   * Bring one out while the wave is short of its number. A later round sends
   * one more than the round before it, so standing your ground gets harder
   * rather than the same again.
   */
  private send(state: SimState): void {
    const wave = state.factions.wave;
    const enforcers = state.enforcers;
    if (wave === null) return;
    const wanted = WAVE_UNITS + wave.round - 1;
    if (enforcers.units.length >= wanted) {
      enforcers.sentTick = Math.max(enforcers.sentTick, state.tick);
      return;
    }
    if (state.tick < enforcers.sentTick) return;
    const id = enforcers.nextUnit;
    const rng = rngFor(state.seed, state.tick, Subsystem.Enforcers, id);
    const bearing = rng.float() * Math.PI * 2;
    const x = state.player.x + Math.cos(bearing) * SPAWN_RANGE;
    const y = state.player.y + Math.sin(bearing) * SPAWN_RANGE;
    const unit = this.raise(id, wave.faction, x, y, rng.float());
    if (unit === undefined) return;
    enforcers.nextUnit = id + 1;
    enforcers.units.push(unit);
    enforcers.sentTick = state.tick + SEND_GAP;
  }

  /** One enforcer on the road nearest a place, or undefined where there is no road to come in on. */
  private raise(id: number, faction: number, x: number, y: number, draw: number): EnforcerUnit | undefined {
    const spec = FACTIONS[faction] as Faction | undefined;
    if (spec === undefined) return undefined;
    const arsenal = spec.arsenal;
    const weapon = arsenal[Math.min(arsenal.length - 1, Math.floor(draw * arsenal.length))] as WeaponId;
    const edge = this.roads.edgeNear(x, y);
    if (edge < 0) return undefined;
    const unit: EnforcerUnit = {
      id,
      faction,
      weapon,
      x,
      y,
      height: 0,
      heading: 0,
      speed: 0,
      cycle: 0,
      edges: [edge],
      distance: 0,
      planned: -REPLAN,
      fired: -1_000_000,
      goalX: x,
      goalY: y,
    };
    this.roads.pose(id, unit.edges, 0, this.pose);
    unit.x = this.pose.x;
    unit.y = this.pose.y;
    unit.height = this.pose.height;
    unit.heading = this.pose.heading;
    return unit;
  }

  /** Where one is walking: at the player, who is the whole of what they came for. */
  private aim(state: SimState, unit: EnforcerUnit): void {
    const p = state.player;
    unit.goalX = p.driving ? state.vehicle.x : p.x;
    unit.goalY = p.driving ? state.vehicle.z : p.y;
  }

  /** One tick of a walk: route it if it is due, run it along the street, and put it where that is. */
  private walk(state: SimState, unit: EnforcerUnit): void {
    const due = state.tick - unit.planned >= REPLAN;
    if (due || unit.distance >= this.roads.length(unit.edges)) this.replan(state, unit);
    const gap = Math.hypot(unit.x - unit.goalX, unit.y - unit.goalY);
    const speed = gap < HOLD_RANGE ? 0 : ENFORCER_SPEED;
    unit.distance = Math.min(unit.distance + speed / TICK_RATE, this.roads.length(unit.edges));
    this.roads.pose(unit.id, unit.edges, unit.distance, this.pose);
    unit.x = this.pose.x;
    unit.y = this.pose.y;
    unit.height = this.pose.height;
    // Somebody standing still keeps the way they were facing rather than
    // reading one off a line they are no longer walking along.
    if (speed > 0) unit.heading = this.pose.heading;
    unit.speed = speed;
    // The stride is carried on the record so a save catches them mid-step.
    unit.cycle = speed === 0 ? unit.cycle : (unit.cycle + speed / TICK_RATE / STRIDE) % 1;
  }

  /** Route one to the player from the street it is on, the way a police car is routed. */
  private replan(state: SimState, unit: EnforcerUnit): void {
    const from =
      unit.edges.length > 0
        ? this.roads.edgeAt(unit.id, unit.edges, unit.distance)
        : { edge: this.roads.edgeNear(unit.x, unit.y), into: 0 };
    if (from.edge < 0) return;
    const edges = this.roads.plan(from.edge, unit.goalX, unit.goalY);
    unit.planned = state.tick;
    if (edges === undefined) return;
    unit.edges = edges;
    unit.distance = from.into;
  }

  /**
   * A shot, where one is close enough to take it. A player in a car is left
   * alone: they are already driving away, and the ground is not being taken
   * from a seat (`territory.ts`).
   */
  private shoot(state: SimState, unit: EnforcerUnit): void {
    const p = state.player;
    if (p.driving || p.health <= 0) return;
    if (Math.hypot(unit.x - p.x, unit.y - p.y) > ENFORCER_RANGE) return;
    if (state.tick - unit.fired < fireGap(unit.weapon)) return;
    unit.fired = state.tick;
    unit.heading = Math.atan2(p.y - unit.y, p.x - unit.x);
    hurt(p, weaponOf(unit.weapon).damage * HIT_SHARE);
  }

  /** With no wave out, the ones far enough away to go unseen are taken off the map. */
  private standDown(state: SimState): void {
    if (state.factions.wave !== null) return;
    const units = state.enforcers.units;
    const p = state.player;
    for (let i = units.length - 1; i >= 0; i--) {
      const unit = units[i] as EnforcerUnit;
      if (Math.hypot(unit.x - p.x, unit.y - p.y) < STAND_DOWN_RANGE) continue;
      units.splice(i, 1);
    }
  }

  /** Forget the route of every enforcer that has gone, so the cache does not grow with the session. */
  private sweep(state: SimState): void {
    const ids = state.enforcers.units.map((unit: EnforcerUnit) => unit.id);
    for (const id of this.out) {
      if (!ids.includes(id)) this.roads.forget(id);
    }
    this.out = ids;
  }

  /** The turf the gang was built over, for whoever holds the gang and needs it. */
  get turf(): TerritoryMap {
    return this.territory;
  }
}

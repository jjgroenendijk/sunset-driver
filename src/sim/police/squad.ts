/**
 * The police on foot, moved (spec sections 11.7, 14).
 *
 * `police.ts` drives the cars; this is the people who get out of them. Each
 * tick it looks for the player through every officer's eyes, lets `duty.ts`
 * say who gets out, who gets back in and what each officer is going for, moves
 * each of them there, lets them shoot (`officer-fire.ts`) and lets the nearest
 * one put the cuffs on (`arrest.ts`).
 *
 * An officer off the roads walks the straight line to where they are going,
 * and a wall in the way is walked round rather than through: the physics
 * answers how far a person can go along a heading before something solid
 * stops them (`CasualtyGround.reach`), and an officer turns further and further
 * off the straight line, always to the same side, until the way is clear. That
 * is the whole of their path finding, and in a city of blocks it is enough to
 * bring them round a corner after the player. The same question answers
 * whether an officer can see the player at all, which is what the enforcers of
 * spec section 17.2 still cannot ask.
 *
 * An officer on a beat walks the road graph instead, the way the enforcers do.
 *
 * Everything is plain data stepped from `(seed, tick)`, and the officers are
 * stepped in the order of the record, so a replay is walked the same way.
 */
import { atan2, cos, hypot, sin } from '../../core/libm.ts';
import type { CasualtyGround } from '../crowd/casualty.ts';
import { TICK_RATE } from '../clock.ts';
import { assignDuty, bailOut, beatGoal, board, patrolBeats, swingDoors, type Duty } from './duty.ts';
import { startCuffs } from './arrest.ts';
import { officerFire } from './officer-fire.ts';
import {
  BEAT_SPEED,
  EYE_HEIGHT,
  forgetOfficerRecords,
  OFFICER_RUN,
  OFFICER_SIGHT,
  RUN_STRIDE,
  WALK_STRIDE,
  type Officer,
} from './officer.ts';
import type { DistrictAt } from './police.ts';
import type { SimState } from '../simulation.ts';
import type { TrafficRoads } from '../traffic/traffic.ts';
import { UnitRoads, type DrivePose } from './unit-route.ts';

/** A place with a way of facing and a pace: what the police are after. */
export interface Quarry {
  x: number;
  y: number;
  heading: number;
  speed: number;
}

/** Radians each try turns further off the straight line when a wall is in the way. */
const DETOUR_STEP = 0.45;

/** Tries at a way round, each side, before an officer stands and waits. */
const DETOUR_TRIES = 5;

/** Metres ahead an officer looks for a wall, at the least. */
const FEELER = 1.1;

/** Metres over their feet an officer feels for a wall: over a kerb, under a car roof. */
const FEEL_HEIGHT = 0.9;

/** Ticks a beat is walked before its route is planned again. */
const REPLAN = 3 * TICK_RATE;

/**
 * True where nothing solid stands on the line between two places, `eye`
 * metres over the ground `from` stands on: an officer's eyes, or a police
 * car's over its own roof.
 */
export function inSight(
  ground: CasualtyGround | undefined,
  from: { x: number; y: number; height: number },
  x: number,
  y: number,
  distance: number,
  eye = EYE_HEIGHT,
): boolean {
  if (ground === undefined || distance < 1) return true;
  const dir = atan2(y - from.y, x - from.x);
  // The ray stops a little short: the player's own body is solid to it.
  return ground.reach(from.x, from.height + eye, from.y, dir, distance) >= distance - 1;
}

export class Squad {
  private readonly roads: UnitRoads;
  private readonly districtAt: DistrictAt;
  private readonly pose: DrivePose = { x: 0, y: 0, height: 0, heading: 0 };
  /** The officers who saw the player this tick, by id: who may shoot. */
  private seeing: number[] = [];
  /** The officers out last tick, so the beats of the ones who have gone are forgotten. */
  private out: number[] = [];
  private readonly duty: Duty = { goalX: 0, goalY: 0, stop: 0, run: true };

  constructor(roads: TrafficRoads, districtAt: DistrictAt) {
    this.roads = new UnitRoads(roads);
    this.districtAt = districtAt;
  }

  /**
   * What every officer on foot can see: the player inside their sight, with
   * no wall in between. A sighting writes the place down and stamps the tick,
   * exactly as a car's does.
   */
  look(state: SimState, quarry: Quarry, ground: CasualtyGround | undefined): void {
    this.seeing = [];
    for (const officer of state.police.officers) {
      if (officer.stunned > state.tick) continue;
      const distance = hypot(quarry.x - officer.x, quarry.y - officer.y);
      if (distance > OFFICER_SIGHT || !inSight(ground, officer, quarry.x, quarry.y, distance)) continue;
      this.seeing.push(officer.id);
      state.police.lastKnown = { x: quarry.x, y: quarry.y };
      state.police.seenTick = state.tick;
    }
  }

  /** One tick of everybody on foot, once the cars have moved. */
  step(state: SimState, quarry: Quarry, ground: CasualtyGround | undefined): void {
    forgetOfficerRecords(state);
    bailOut(state, quarry, ground);
    patrolBeats(state, this.roads, this.districtAt, this.pose);
    for (const officer of state.police.officers) {
      const sees = this.seeing.includes(officer.id);
      assignDuty(state, officer, quarry, sees, this.duty);
      if (officer.stunned > state.tick) {
        officer.speed = 0;
        officer.aiming = false;
        continue;
      }
      if (officer.task === 'beat') this.walkBeat(state, officer, ground);
      else this.move(officer, this.duty, ground);
      officerFire(state, officer, quarry, sees, ground);
    }
    board(state);
    swingDoors(state);
    startCuffs(state);
    this.sweep(state);
  }

  /** Walk an officer toward the goal their duty set, round whatever wall is in the way. */
  private move(officer: Officer, duty: Duty, ground: CasualtyGround | undefined): void {
    const pace = duty.run ? OFFICER_RUN[officer.kind] : BEAT_SPEED;
    const gap = hypot(duty.goalX - officer.x, duty.goalY - officer.y);
    officer.goalX = duty.goalX;
    officer.goalY = duty.goalY;
    // Anybody off the roads has left the beat they were on.
    officer.edges = [];
    if (gap <= duty.stop) {
      officer.speed = 0;
      // Standing, an officer faces what they came for.
      if (gap > 0.05) officer.heading = atan2(duty.goalY - officer.y, duty.goalX - officer.x);
      return;
    }
    const step = Math.min(pace / TICK_RATE, gap - duty.stop);
    const want = atan2(duty.goalY - officer.y, duty.goalX - officer.x);
    const dir = this.wayRound(officer, want, step, gap, ground);
    if (dir === undefined) {
      // Boxed in: they wait a tick and try the other way round next.
      officer.detour = -officer.detour;
      officer.speed = 0;
      return;
    }
    officer.x += cos(dir) * step;
    officer.y += sin(dir) * step;
    if (ground !== undefined) officer.height = ground.heightAt(officer.x, officer.y);
    officer.heading = dir;
    officer.speed = step * TICK_RATE;
    const stride = duty.run ? RUN_STRIDE : WALK_STRIDE;
    officer.cycle = (officer.cycle + step / stride) % 1;
  }

  /**
   * The heading an officer can walk this tick: the straight one where it is
   * clear, else the nearest one off it on their own side, then on the other.
   * Undefined where every way is shut.
   */
  private wayRound(officer: Officer, want: number, step: number, gap: number, ground: CasualtyGround | undefined): number | undefined {
    if (ground === undefined) return want;
    // Not further than the goal: the player's own body is solid to the ray.
    const feel = Math.min(Math.max(FEELER, step * 3), gap - 0.4);
    if (feel <= 0.2) return want;
    const h = officer.height + FEEL_HEIGHT;
    for (const side of [officer.detour, -officer.detour]) {
      for (let i = side === officer.detour ? 0 : 1; i <= DETOUR_TRIES; i++) {
        const dir = want + side * i * DETOUR_STEP;
        if (ground.reach(officer.x, h, officer.y, dir, feel) >= feel) return dir;
      }
    }
    return undefined;
  }

  /** One tick of a beat: route it if due, walk it along the street, and put the officer where that is. */
  private walkBeat(state: SimState, officer: Officer, ground: CasualtyGround | undefined): void {
    officer.aiming = false;
    const roads = this.roads;
    if (officer.edges.length === 0) return;
    // A beat walked to its end is sent on somewhere else.
    if (officer.distance >= roads.length(officer.edges) - 0.5) beatGoal(state, officer, roads);
    else if (state.tick - officer.planned >= REPLAN) {
      const from = roads.edgeAt(officer.id, officer.edges, officer.distance);
      const edges = from.edge < 0 ? undefined : roads.plan(from.edge, officer.goalX, officer.goalY);
      officer.planned = state.tick;
      if (edges !== undefined) {
        officer.edges = edges;
        officer.distance = from.into;
      }
    }
    const step = BEAT_SPEED / TICK_RATE;
    officer.distance = Math.min(officer.distance + step, roads.length(officer.edges));
    roads.pose(officer.id, officer.edges, officer.distance, this.pose);
    officer.x = this.pose.x;
    officer.y = this.pose.y;
    officer.height = ground?.heightAt(officer.x, officer.y) ?? this.pose.height;
    officer.heading = this.pose.heading;
    officer.speed = BEAT_SPEED;
    officer.cycle = (officer.cycle + step / WALK_STRIDE) % 1;
  }

  /** Forget the beat of every officer who has gone, so the cache does not grow with the session. */
  private sweep(state: SimState): void {
    const ids = state.police.officers.map((officer: Officer) => officer.id);
    for (const id of this.out) {
      if (!ids.includes(id)) this.roads.forget(id);
    }
    this.out = ids;
  }
}

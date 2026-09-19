/**
 * What each officer on foot is doing (spec section 14): who gets out of a car,
 * who gets back in, where each one goes, and who walks a beat.
 *
 * A crew gets out of a car that has pulled up near the player, and gets back
 * in once the player has driven off, so the car can take up the chase again.
 * The crew of a roadblock stands behind the car rather than in front of it,
 * with the car between them and the way the player comes. Pairs of officers
 * walk a beat downtown while nothing is going on, and answer a crime near them.
 *
 * `squad.ts` moves them to the place this sets. Nothing here moves anybody.
 */
import { rngFor, Subsystem } from '../core/rng.ts';
import { atan2, cos, hypot, sin } from '../core/libm.ts';
import type { CasualtyGround } from './casualty.ts';
import { TICK_RATE } from './clock.ts';
import { heatStars } from './crime.ts';
import { bark, createOfficer, CREW, officerWeapon, type Officer, type OfficerKind, type OfficerTask } from './officer.ts';
import { officerRange } from './officer-fire.ts';
import type { DistrictAt, PoliceUnit } from './police.ts';
import type { SimState } from './simulation.ts';
import type { Quarry } from './squad.ts';
import type { District } from '../world/types.ts';
import type { DrivePose, UnitRoads } from './unit-route.ts';

/** Where an officer is going this tick, how close they stop, and whether they run. */
export interface Duty {
  goalX: number;
  goalY: number;
  stop: number;
  run: boolean;
}

/** Metres from the player a car stopped near them lets its crew out at. */
const BAIL_RANGE = 35;

/** Metres a car at a roadblock lets its crew out at: they stand ready before the player comes. */
const BLOCK_BAIL_RANGE = 110;

/** Metres per second a car must be under for its crew to get out. */
const BAIL_SPEED = 0.5;

/** Metres per second the player's car must be under for a crew to come and drag them out. */
export const DRAG_SPEED = 2;

/** Metres from their car at which a crew gives the player up on foot and goes back to drive after them. */
const RECALL_RANGE = 45;

/** Metres from the player inside which a crew at a roadblock leaves cover and goes for them on foot. */
const RUSH_RANGE = 18;

/** Metres behind their car the crew of a roadblock stands, and apart from each other. */
const COVER_BACK = 2.6;
const COVER_APART = 1.5;

/** Metres from their car at which an officer is in it. */
const BOARD_RANGE = 1.6;

/** Metres from where they are going an officer stops at: close enough to cuff, and at the car. */
export const CUFF_REACH = 1.05;
const GOAL_REACH = 0.4;

/** Metres from the last sighting a beat officer answers a chase from. */
const ANSWER_RANGE = 130;

/** Metres an officer who is going home walks away before they are taken off the map. */
const LEAVE_RANGE = 115;

/** Share of their gun's range the officers hold off at, once the heat has them shooting to stop. */
const STAND_OFF = 0.6;

/** Pairs of officers on the beat round the player, by zone: downtown only (spec section 14). */
const BEAT_PAIRS: Record<District['zone'], number> = {
  core: 2,
  inner: 1,
  industrial: 0,
  suburban: 0,
  outskirts: 0,
  wilderness: 0,
};

/** Ticks between two pairs starting a beat. */
const BEAT_GAP = 10 * TICK_RATE;

/** Metres from the player a pair starts a beat at, which is just past what the camera shows. */
const BEAT_SPAWN = 135;

/** Metres from the player a beat officer is taken off the map at. */
const BEAT_DROP = 230;

/** Metres a beat walks to before it is planned again somewhere else. */
const BEAT_REACH = 160;

/** The car an officer came in, while it is still out. */
export function carOf(state: SimState, officer: Officer): PoliceUnit | undefined {
  if (officer.unit < 0) return undefined;
  return state.police.units.find((unit: PoliceUnit) => unit.id === officer.unit);
}

/**
 * Let the crew out of every car that has pulled up near the player, and out of
 * every roadblock that has got into place. A car the player is driving past
 * at speed keeps its crew in: they only get out to drag a driver out of a car
 * that has stopped.
 */
export function bailOut(state: SimState, quarry: Quarry, ground: CasualtyGround | undefined): void {
  if (state.heat <= 0) return;
  const police = state.police;
  const driving = state.player.driving;
  for (const unit of police.units) {
    if (unit.crew <= 0 || unit.kind === 'helicopter' || unit.speed > BAIL_SPEED) continue;
    const gap = hypot(unit.x - quarry.x, unit.y - quarry.y);
    const block = unit.task === 'block' && gap < BLOCK_BAIL_RANGE;
    const near = gap < BAIL_RANGE && (!driving || quarry.speed < DRAG_SPEED);
    if (!block && !near) continue;
    const kind: OfficerKind = unit.kind === 'swat' ? 'swat' : 'patrol';
    for (let seat = 0; seat < unit.crew; seat++) {
      // Two sit in front and two behind, and each gets out of their own side.
      const along = seat < 2 ? 0.4 : -1.2;
      const side = seat % 2 === 0 ? 1 : -1;
      const x = unit.x + cos(unit.heading) * along - sin(unit.heading) * side * 1.35;
      const y = unit.y + sin(unit.heading) * along + cos(unit.heading) * side * 1.35;
      const height = ground?.heightAt(x, y) ?? unit.height;
      police.officers.push(createOfficer(police.nextOfficer, kind, unit.id, block ? 'cover' : 'pursue', x, y, height, unit.heading));
      police.nextOfficer += 1;
    }
    unit.crew = 0;
    // The first thing said getting out on a player who is only wanted for questioning.
    if (!block && heatStars(state.heat) < 2) bark(state, 'freeze', unit.x, unit.y);
  }
}

/**
 * Say what an officer is doing this tick and where it takes them, into `out`.
 * The one who has hold of the player stays on them; the rest go after the
 * player, stand behind their roadblock, walk back to their car or walk a beat.
 */
export function assignDuty(state: SimState, officer: Officer, quarry: Quarry, sees: boolean, out: Duty): void {
  const car = carOf(state, officer);
  if (car === undefined) officer.unit = -1;
  officer.task = taskOf(state, officer, car, quarry);
  out.run = true;
  out.stop = GOAL_REACH;
  switch (officer.task) {
    case 'cuff':
      out.goalX = quarry.x;
      out.goalY = quarry.y;
      out.stop = CUFF_REACH;
      return;
    case 'board': {
      const at = car ?? officer;
      out.goalX = at.x;
      out.goalY = at.y;
      out.stop = 0.2;
      return;
    }
    case 'cover':
      coverPlace(state, officer, car as PoliceUnit, quarry, out);
      return;
    case 'leave':
      leavePlace(state, officer, out);
      return;
    case 'beat':
      out.run = false;
      out.goalX = officer.goalX;
      out.goalY = officer.goalY;
      return;
    case 'pursue':
      pursuePlace(state, officer, quarry, sees, out);
      return;
  }
}

function taskOf(state: SimState, officer: Officer, car: PoliceUnit | undefined, quarry: Quarry): OfficerTask {
  const police = state.police;
  if (police.cuffs?.officer === officer.id) return 'cuff';
  if (state.heat <= 0) return car !== undefined ? 'board' : officer.task === 'beat' ? 'beat' : 'leave';
  if (officer.task === 'beat') {
    const known = police.lastKnown;
    if (known === null || hypot(known.x - officer.x, known.y - officer.y) > ANSWER_RANGE) return 'beat';
  }
  if (car !== undefined) {
    const gone = state.player.driving && quarry.speed >= DRAG_SPEED && hypot(car.x - quarry.x, car.y - quarry.y) > RECALL_RANGE;
    if (gone) return 'board';
    const rushed = !state.player.driving && hypot(officer.x - quarry.x, officer.y - quarry.y) < RUSH_RANGE;
    if (car.task === 'block' && !rushed) return 'cover';
  }
  return 'pursue';
}

/**
 * Where an officer going after the player makes for: the player where they
 * can see them, else the last sighting. Once the heat has them shooting to
 * stop, they hold off at a share of their gun's range rather than run in;
 * below that, and at a player who has stopped their car, they run in to cuff.
 */
function pursuePlace(state: SimState, officer: Officer, quarry: Quarry, sees: boolean, out: Duty): void {
  const known = sees ? quarry : (state.police.lastKnown ?? quarry);
  out.goalX = known.x;
  out.goalY = known.y;
  out.stop = CUFF_REACH;
  if (!sees) return;
  const stars = heatStars(state.heat);
  const stopped = !state.player.driving || quarry.speed < DRAG_SPEED;
  const standOff = officer.kind === 'swat' || stars >= 3 || !stopped;
  if (standOff && !state.police.surrendered) out.stop = officerRange(officerWeapon(officer.kind, stars)) * STAND_OFF;
}

/**
 * The place behind a roadblock an officer takes: on the far side of their car
 * from the player, the crew spread along it.
 */
function coverPlace(state: SimState, officer: Officer, car: PoliceUnit, quarry: Quarry, out: Duty): void {
  const away = atan2(car.y - quarry.y, car.x - quarry.x);
  let seat = 0;
  for (const other of state.police.officers) {
    if (other.id === officer.id) break;
    if (other.unit === officer.unit) seat += 1;
  }
  const spread = (seat - 0.5) * COVER_APART * (seat % 2 === 0 ? 1 : -1);
  out.goalX = car.x + cos(away) * COVER_BACK - sin(away) * spread;
  out.goalY = car.y + sin(away) * COVER_BACK + cos(away) * spread;
}

/** Straight away from the player, who is who they are going home from. */
function leavePlace(state: SimState, officer: Officer, out: Duty): void {
  const p = state.player;
  const away = atan2(officer.y - p.y, officer.x - p.x);
  out.run = false;
  out.goalX = officer.x + cos(away) * 20;
  out.goalY = officer.y + sin(away) * 20;
}

/**
 * Put the crew back in any car they have walked back to, and take off the map
 * everybody who has walked far enough off to go unseen.
 */
export function board(state: SimState): void {
  const police = state.police;
  const p = state.player;
  const x = p.driving ? state.vehicle.x : p.x;
  const y = p.driving ? state.vehicle.z : p.y;
  for (let i = police.officers.length - 1; i >= 0; i--) {
    const officer = police.officers[i] as Officer;
    const car = carOf(state, officer);
    if (officer.task === 'board' && car !== undefined && hypot(car.x - officer.x, car.y - officer.y) < BOARD_RANGE) {
      car.crew = Math.min(CREW[car.kind], car.crew + 1);
      police.officers.splice(i, 1);
      continue;
    }
    const far = hypot(officer.x - x, officer.y - y);
    if ((officer.task === 'leave' && far > LEAVE_RANGE) || (officer.task === 'beat' && far > BEAT_DROP)) {
      police.officers.splice(i, 1);
    }
  }
}

/**
 * Keep the beat downtown walked: while the player is in a district that has
 * one and fewer pairs are out than it wants, a pair starts a beat on a street
 * just out of sight, and walks the roads from there.
 */
export function patrolBeats(state: SimState, roads: UnitRoads, districtAt: DistrictAt, pose: DrivePose): void {
  const police = state.police;
  const p = state.player;
  const x = p.driving ? state.vehicle.x : p.x;
  const y = p.driving ? state.vehicle.z : p.y;
  if (state.tick < police.beatTick) return;
  police.beatTick = state.tick + BEAT_GAP;
  const wanted = BEAT_PAIRS[districtAt(x, y).zone] * 2;
  const walking = police.officers.filter((officer: Officer) => officer.task === 'beat').length;
  if (walking >= wanted) return;
  // A pair starts on an even id, so each of them can name the pair by it.
  const id = police.nextOfficer + (police.nextOfficer % 2);
  const rng = rngFor(state.seed, state.tick, Subsystem.Officers, id);
  const bearing = rng.float() * Math.PI * 2;
  const edge = roads.edgeNear(x + cos(bearing) * BEAT_SPAWN, y + sin(bearing) * BEAT_SPAWN);
  if (edge < 0) return;
  for (let i = 0; i < 2; i++) {
    const officer = createOfficer(id + i, 'patrol', -1, 'beat', 0, 0, 0, 0);
    officer.edges = [edge];
    // The second walks a stride behind the first.
    officer.distance = i === 0 ? 1.6 : 0;
    roads.pose(officer.id, officer.edges, officer.distance, pose);
    officer.x = pose.x;
    officer.y = pose.y;
    officer.height = pose.height;
    officer.heading = pose.heading;
    beatGoal(state, officer, roads);
    police.officers.push(officer);
  }
  police.nextOfficer = id + 2;
}

/**
 * Send a beat officer on to a place of their pair's own stream, planned over
 * the roads. Both of a pair draw the same place, so they walk on together.
 */
export function beatGoal(state: SimState, officer: Officer, roads: UnitRoads): void {
  const round = Math.floor(state.tick / BEAT_GAP);
  const rng = rngFor(state.seed, round, Subsystem.Officers, officer.id - (officer.id % 2));
  const bearing = rng.float() * Math.PI * 2;
  officer.goalX = officer.x + cos(bearing) * BEAT_REACH;
  officer.goalY = officer.y + sin(bearing) * BEAT_REACH;
  officer.planned = state.tick;
  const from = roads.edgeAt(officer.id, officer.edges, officer.distance);
  const edges = from.edge < 0 ? undefined : roads.plan(from.edge, officer.goalX, officer.goalY);
  if (edges === undefined) return;
  officer.edges = edges;
  officer.distance = from.into;
}

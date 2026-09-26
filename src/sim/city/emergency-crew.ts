/**
 * The crew of an emergency unit (spec section 20.3): the firefighters of an
 * engine and the medics of an ambulance, as the record carries them.
 *
 * A unit that pulls up at a scene opens its doors, and once they stand open
 * the crew climb down and walk to what they came for: a place a throw short of
 * the fire for a firefighter, the body itself for a medic. They work it until
 * the unit's `until`, walk back to the door they came out of, and board. The
 * unit drives off once the last of them is aboard and the doors are shut, so
 * nobody is left standing in the street.
 *
 * They are on the record rather than worked out from `(unit, tick)`, because
 * they are people of the city like any other: `unit-bodies.ts` stands each of
 * them in a capsule, and a round or a blast puts one down and leaves a body
 * (`fallen`), exactly as it does a police officer. A crew that is shot at
 * abandons the scene and boards.
 *
 * Everything here is a pure function of the record and the tick. The screen
 * reads it and adds nothing: `render/services/emergency-crew.ts` lays the hose from
 * where a firefighter stands, `ui/hud/emergency-crews.ts` walks their bodies in
 * the crowd's mesh, and `render/people/casualties.ts` kneels a medic who has reached
 * a body.
 */
import { atan2, cos, hypot, sin } from '../../core/libm.ts';
import { casualtyPose, emptyCasualtyPose, type Casualty } from '../crowd/casualty-motion.ts';
import { TICK_RATE } from '../clock.ts';
import { COLLECT_RANGE, HOSE_RANGE, UNIT_BODY, type EmergencyKind, type EmergencyUnit } from './emergency.ts';
import { MAX_HEALTH } from '../player/on-foot.ts';
import { strideOf, type Gait } from '../crowd/pedestrian-look.ts';
import { commitCrime } from '../police/police.ts';
import type { SimState } from '../simulation.ts';

/** What a member of a crew is: a firefighter off an engine, or a medic off an ambulance. */
export type CrewRole = 'firefighter' | 'medic';

/** What a member of a crew is doing. */
type CrewTask =
  /** Out of the door and walking to their place. */
  | 'out'
  /** At their place, working the scene. */
  | 'work'
  /** Walking back to the door they came out of. */
  | 'back';

/** One firefighter or medic on the street, as the record carries them. */
export interface CrewMember {
  id: number;
  /** The unit they came out of. */
  unit: number;
  role: CrewRole;
  /** Which of the crew they are, which is the door they use and the side they work. */
  member: number;
  task: CrewTask;
  x: number;
  y: number;
  /** The road under their feet. */
  height: number;
  heading: number;
  /** Metres per second they covered over the last tick. */
  speed: number;
  /** How far through their stride they are, so the crowd mesh draws a walk. */
  cycle: number;
  gait: Gait;
  /** What is left of them, out of {@link CREW_HEALTH}. At zero they fall. */
  health: number;
  /** True for a medic knelt at a body: the casualty mesh draws them, not the crowd's. */
  kneeling: boolean;
  /** Where they are walking to. */
  goalX: number;
  goalY: number;
  /** The tick they climb down on, so the second of a crew follows the first. */
  start: number;
  /** The door they came out of and go back to. */
  doorX: number;
  doorY: number;
}

/** A member of a crew who has been put down: the body on the ground, and what they wore. */
export interface FallenCrew {
  role: CrewRole;
  body: Casualty;
}

/** People each kind of unit carries. */
export const CREW_SIZE: Record<EmergencyKind, number> = { engine: 2, ambulance: 2 };

/** The role each kind's crew are. */
const CREW_ROLE: Record<EmergencyKind, CrewRole> = { engine: 'firefighter', ambulance: 'medic' };

/** What one of them can take before they fall, on the player's own scale. */
export const CREW_HEALTH = MAX_HEALTH;

/** How tall each role is, in metres: a firefighter in boots and helmet, a medic as they come. */
export const CREW_HEIGHT: Record<CrewRole, number> = { firefighter: 1.8, medic: 1.78 };

/** Ticks a unit's doors take to swing open, and to shut again. */
const DOOR_TICKS = 0.7 * TICK_RATE;

/** Ticks the second of a crew climbs down after the first. */
const STAGGER = 20;

/** Metres per second a crew member covers the ground at, going out and coming back. */
const CREW_PACE = 3.8;

/** Metres from their place a crew member counts as having reached it. */
const ARRIVE = 0.2;

/**
 * Where the crew of each kind climb down, in the unit's own frame: metres
 * along it from the middle, and metres out from the flank. A firefighter steps
 * out of the cab onto the flank that faces the scene; a medic steps out of the
 * back, which is where the stretcher goes.
 */
export function doorAlong(kind: EmergencyKind): number {
  return kind === 'engine' ? UNIT_BODY.engine.halfLength - 1.5 : -UNIT_BODY.ambulance.halfLength - 0.7;
}

/** Metres out from the flank of an engine its crew climb down at. */
const DOOR_OUT = 0.5;

/** Metres to each side of the tail the two medics step down at, and how far behind it they wait. */
const TAIL_APART = 0.55;
const TAIL_STAND = 1.2;

/**
 * Where a hose is coupled to an engine, in its own frame: metres along it from
 * the middle and metres over the road, with one on each flank. The crew use
 * the one on the side of the scene, and the water leaves the nozzle in their
 * hands rather than the engine (`render/services/emergency-crew.ts`).
 */
export const OUTLET_ALONG = -0.05;
export const OUTLET_UP = 0.9;

/** Metres out from the flank a hose reaches the road. */
export const OUTLET_OUT = 0.45;

/**
 * Metres short of the scene a firefighter stands: the water covers the rest.
 * A scene close to the engine is met halfway, so they stand clear of it.
 */
const THROW = 6;

/** Metres out from the coupling a firefighter stands at least, and how far short of its reach at most. */
const NEAREST = 1.5;
const FURTHEST_BACK = 2;

/** Metres to either side of the line to the scene the two stand, and how far the second stands back. */
const APART = 0.9;
const BEHIND = 0.7;

/** Metres from the line of a body a medic kneels at, and how far up the body from the hips. */
export const MEDIC_SIDE = 0.95;
const MEDIC_UP = 0.35;

/** Ticks a fallen crew member lies before the body is taken away, and how many lie at once. */
const FALLEN_TICKS = 90 * TICK_RATE;
const FALLEN_CAP = 8;

/** Metres per second a round pushes one of them over at, and how far it can carry them. */
const FALL_PUSH = 1.6;
const FALL_REACH = 1.4;

/** A place in the world, which is what a station and a door both are. */
interface Spot {
  x: number;
  y: number;
}

/** The crew of one unit, in the order the record holds them. */
export function crewOf(state: SimState, unit: number): CrewMember[] {
  return state.emergency.crew.filter((member) => member.unit === unit);
}

/**
 * Whether an engine has water on the scene this tick: a firefighter of its
 * crew is at their place with the nozzle up. No water reaches a fire before
 * somebody is standing there to play it on.
 */
export function hosing(state: SimState, unit: EmergencyUnit): boolean {
  if (unit.kind !== 'engine') return false;
  return state.emergency.crew.some((member) => member.unit === unit.id && member.task === 'work');
}

/**
 * One tick of a unit standing at a scene: its doors, and the crew that come
 * out of them. Called only while the unit is working one.
 */
export function stepUnitCrew(state: SimState, unit: EmergencyUnit): void {
  const crew = crewOf(state, unit.id);
  const recalled = state.tick >= unit.until;
  // The doors stand open from the moment the unit pulls up until the last of
  // the crew is aboard, and shut behind them.
  const open = !recalled || crew.length > 0;
  unit.doors = Math.max(0, Math.min(1, unit.doors + (open ? 1 : -1) / DOOR_TICKS));
  if (!unit.deployed && unit.doors >= 1 && !recalled) raiseCrew(state, unit);
  for (const member of crew) {
    if (recalled && member.task !== 'back') send(member, member.doorX, member.doorY, 'back');
    step(state, unit, member);
  }
  board(state, unit);
}

/** Whether a unit has finished with its crew: the work is done, they are aboard and the doors are shut. */
export function crewAboard(state: SimState, unit: EmergencyUnit): boolean {
  if (state.tick < unit.until) return false;
  if (unit.doors > 0) return false;
  return !state.emergency.crew.some((member) => member.unit === unit.id);
}

/**
 * Take health off a crew member, and put them down once they have none left.
 * They are civilians, so a hit is the assault and a kill the killing that
 * hitting anybody else in the street is. `dir` is the way the round was going,
 * which is the way they fall. The rest of the crew abandon the scene and board:
 * nobody works a fire while they are being shot at. Answers true where this was
 * the hit that put them down.
 */
export function hurtCrew(state: SimState, id: number, amount: number, dir: number, ground?: FallGround): boolean {
  const crew = state.emergency.crew;
  for (let i = 0; i < crew.length; i++) {
    const member = crew[i] as CrewMember;
    if (member.id !== id) continue;
    const first = member.health >= CREW_HEALTH;
    member.health -= Math.min(Math.max(0, amount), member.health);
    if (first) commitCrime(state, 'assault');
    if (member.health > 0) return false;
    fall(state, member, dir, ground);
    crew.splice(i, 1);
    commitCrime(state, 'killing');
    flee(state, member.unit);
    return true;
  }
  return false;
}

/**
 * Put a blast into every crew member inside its radius, in the order the
 * record holds them. `falloff` answers how much of it is felt at a distance.
 */
export function blastCrew(state: SimState, x: number, y: number, damage: number, falloff: (distance: number) => number): void {
  for (const member of [...state.emergency.crew]) {
    const share = falloff(hypot(member.x - x, member.y - y));
    if (share <= 0) continue;
    hurtCrew(state, member.id, damage * share, atan2(member.y - y, member.x - x));
  }
}

/** Forget the bodies that have been taken away. Once a tick. */
export function forgetFallenCrew(state: SimState): void {
  const fallen = state.emergency.fallen;
  let keep = 0;
  while (keep < fallen.length && state.tick - (fallen[keep] as FallenCrew).body.first >= FALLEN_TICKS) keep++;
  if (keep > 0) fallen.splice(0, keep);
}

/** Take the crew of a unit off the street: the unit has gone, and so have they. */
export function dropCrew(state: SimState, unit: number): void {
  const crew = state.emergency.crew;
  for (let i = crew.length - 1; i >= 0; i--) {
    if ((crew[i] as CrewMember).unit === unit) crew.splice(i, 1);
  }
}

/** What the physics tells a fall: how far a body pushed along a line gets before something stops it. */
export interface FallGround {
  reach(x: number, h: number, y: number, dir: number, max: number): number;
}

/** Put a unit's crew on the street, at the doors they climb down from. */
function raiseCrew(state: SimState, unit: EmergencyUnit): void {
  unit.deployed = true;
  const role = CREW_ROLE[unit.kind];
  for (let member = 0; member < CREW_SIZE[unit.kind]; member++) {
    const door = doorSpot(unit, member);
    const id = state.emergency.nextCrew;
    state.emergency.nextCrew = id + 1;
    state.emergency.crew.push({
      id,
      unit: unit.id,
      role,
      member,
      task: 'out',
      x: door.x,
      y: door.y,
      height: unit.height,
      heading: unit.heading,
      speed: 0,
      cycle: 0,
      gait: 'stand',
      health: CREW_HEALTH,
      kneeling: false,
      goalX: door.x,
      goalY: door.y,
      start: state.tick + member * STAGGER,
      doorX: door.x,
      doorY: door.y,
    });
  }
}

/**
 * Put a unit's crew straight at their places, doors open and the work under
 * way. A still picture has no ticks to walk them out over, so the preview of
 * `render/preview/preview.ts` and a test stand them where a tick of work would have.
 */
export function placeCrew(state: SimState, unit: EmergencyUnit): void {
  unit.doors = 1;
  raiseCrew(state, unit);
  for (const member of crewOf(state, unit.id)) {
    const station = stationOf(state, unit, member);
    member.start = state.tick;
    member.task = 'work';
    member.goalX = station.x;
    member.goalY = station.y;
    member.x = station.x;
    member.y = station.y;
    arrive(state, unit, member);
  }
}

/** One tick of one of them: where they are going, and how far they got. */
function step(state: SimState, unit: EmergencyUnit, member: CrewMember): void {
  member.height = unit.height;
  if (member.task === 'out') {
    // A medic walks at whichever body the ambulance can still reach, so one
    // that crawls while they cross the road is still the one they kneel at.
    const station = stationOf(state, unit, member);
    member.goalX = station.x;
    member.goalY = station.y;
  }
  if (state.tick < member.start) {
    stand(member, unit.heading);
    return;
  }
  const dx = member.goalX - member.x;
  const dy = member.goalY - member.y;
  const gap = hypot(dx, dy);
  const stride = CREW_PACE / TICK_RATE;
  if (gap > Math.max(ARRIVE, stride)) {
    member.heading = atan2(dy, dx);
    member.x += (dx / gap) * stride;
    member.y += (dy / gap) * stride;
    member.speed = CREW_PACE;
    member.gait = 'run';
    member.kneeling = false;
    const cycles = member.cycle + stride / strideOf('run', CREW_HEIGHT[member.role]);
    member.cycle = cycles - Math.floor(cycles);
    return;
  }
  member.x = member.goalX;
  member.y = member.goalY;
  if (member.task === 'out') member.task = 'work';
  arrive(state, unit, member);
}

/** What one of them does once they are standing at their place. */
function arrive(state: SimState, unit: EmergencyUnit, member: CrewMember): void {
  if (member.task === 'back') {
    stand(member, unit.heading);
    return;
  }
  member.speed = 0;
  member.cycle = 0;
  if (member.role === 'medic') {
    // A medic kneels at the body, facing it; the casualty mesh draws them.
    member.kneeling = bodyNear(state, unit) !== undefined;
    member.gait = 'stand';
    member.heading = atan2(unit.goalY - member.y, unit.goalX - member.x);
    return;
  }
  // A firefighter faces the scene with the nozzle held out in front of them.
  member.gait = 'aim';
  member.heading = atan2(unit.goalY - member.y, unit.goalX - member.x);
}

/** Stand still, facing a way. */
function stand(member: CrewMember, heading: number): void {
  member.speed = 0;
  member.cycle = 0;
  member.gait = 'stand';
  member.heading = heading;
  member.kneeling = false;
}

/** Send one of them somewhere, on a task. */
function send(member: CrewMember, x: number, y: number, task: CrewTask): void {
  member.task = task;
  member.goalX = x;
  member.goalY = y;
  member.kneeling = false;
}

/** Take aboard everybody who has walked back to their door. */
function board(state: SimState, unit: EmergencyUnit): void {
  const crew = state.emergency.crew;
  for (let i = crew.length - 1; i >= 0; i--) {
    const member = crew[i] as CrewMember;
    if (member.unit !== unit.id || member.task !== 'back') continue;
    if (hypot(member.x - member.doorX, member.y - member.doorY) > ARRIVE) continue;
    crew.splice(i, 1);
  }
}

/** Call the rest of a unit's crew back to their doors: one of them has been shot. */
function flee(state: SimState, unit: number): void {
  for (const member of state.emergency.crew) {
    if (member.unit !== unit) continue;
    send(member, member.doorX, member.doorY, 'back');
  }
  for (const out of state.emergency.units) {
    // The unit leaves as soon as they are aboard rather than working out its time.
    if (out.id === unit && out.task === 'work') out.until = Math.min(out.until, state.tick);
  }
}

/** The door member `member` of a unit climbs down from, in the world. */
function doorSpot(unit: EmergencyUnit, member: number): Spot {
  if (unit.kind === 'ambulance') {
    // Both medics step out of the back, one each side of the tail.
    return local(unit, doorAlong('ambulance'), (member === 0 ? 1 : -1) * TAIL_APART, 1);
  }
  return local(unit, doorAlong('engine'), UNIT_BODY.engine.halfWidth + DOOR_OUT, sceneSide(unit));
}

/** Where member `member` of a unit's crew works, in the world. */
function stationOf(state: SimState, unit: EmergencyUnit, member: CrewMember): Spot {
  return unit.kind === 'engine' ? hoseStation(unit, member.member) : medicStation(state, unit, member.member);
}

/**
 * Where a firefighter stands: out along the line from the hose's foot to the
 * scene, a throw short of it, the two of them abreast with the second a step
 * back.
 */
function hoseStation(unit: EmergencyUnit, member: number): Spot {
  const side = sceneSide(unit);
  const ground = local(unit, OUTLET_ALONG, UNIT_BODY.engine.halfWidth + OUTLET_OUT, side);
  let lineX = unit.goalX - ground.x;
  let lineY = unit.goalY - ground.y;
  const reach = hypot(lineX, lineY);
  lineX = reach > 0.01 ? lineX / reach : -side * sin(unit.heading);
  lineY = reach > 0.01 ? lineY / reach : side * cos(unit.heading);
  const stand = Math.min(HOSE_RANGE - FURTHEST_BACK, Math.max(NEAREST, reach - Math.min(THROW, reach / 2)));
  const across = member === 0 ? APART : -APART;
  const back = member === 0 ? 0 : BEHIND;
  return {
    x: ground.x + lineX * (stand - back) - lineY * across,
    y: ground.y + lineY * (stand - back) + lineX * across,
  };
}

/**
 * Where a medic kneels: one each side of the body nearest the ambulance, a
 * little up it from the hips. With nobody down at the scene they stand behind
 * the ambulance instead, which is where the stretcher comes out: walking to a
 * scene with nothing to do at it would only leave them standing in the road.
 */
function medicStation(state: SimState, unit: EmergencyUnit, member: number): Spot {
  const body = bodyNear(state, unit);
  if (body === undefined) {
    return local(unit, doorAlong('ambulance') - TAIL_STAND, (member === 0 ? 1 : -1) * MEDIC_SIDE, 1);
  }
  const toward = body.dir + (member === 0 ? 1 : -1) * (Math.PI / 2);
  return {
    x: body.x + cos(body.dir) * MEDIC_UP + cos(toward) * MEDIC_SIDE,
    y: body.y + sin(body.dir) * MEDIC_UP + sin(toward) * MEDIC_SIDE,
  };
}

/**
 * The body a unit's medics work at: the nearest one within {@link COLLECT_RANGE}
 * of it, of those lying or crawling. A body still in the air or going over is
 * not one to kneel at yet.
 */
function bodyNear(state: SimState, unit: EmergencyUnit): { x: number; y: number; dir: number } | undefined {
  const pose = emptyCasualtyPose();
  let best: { x: number; y: number; dir: number } | undefined;
  let nearest = COLLECT_RANGE;
  for (const record of state.pedestrians.casualties) {
    if (record.gone) continue;
    casualtyPose(record, state.tick, pose);
    if (pose.phase !== 'lie' && pose.phase !== 'crawl') continue;
    const gap = hypot(pose.x - unit.x, pose.y - unit.y);
    if (gap > nearest) continue;
    nearest = gap;
    best = { x: pose.x, y: pose.y, dir: pose.dir };
  }
  return best;
}

/** The flank of a unit that faces the scene it is working: 1 is its left. */
export function sceneSide(unit: EmergencyUnit): number {
  const toX = unit.goalX - unit.x;
  const toY = unit.goalY - unit.y;
  return -toX * sin(unit.heading) + toY * cos(unit.heading) >= 0 ? 1 : -1;
}

/** A place in a unit's own frame — metres along it and out from `side` — as a place in the world. */
export function local(unit: EmergencyUnit, along: number, across: number, side: number): Spot {
  return {
    x: unit.x + along * cos(unit.heading) - side * across * sin(unit.heading),
    y: unit.y + along * sin(unit.heading) + side * across * cos(unit.heading),
  };
}

/** The body left where one of them fell. */
function fall(state: SimState, member: CrewMember, dir: number, ground?: FallGround): void {
  const reach = ground?.reach(member.x, member.height + 1, member.y, dir, FALL_REACH) ?? FALL_REACH;
  const body: Casualty = {
    id: member.id,
    since: state.tick,
    first: state.tick,
    cause: 'shot',
    health: 0,
    x: member.x,
    y: member.y,
    height: member.height,
    rest: member.height,
    heading: member.heading,
    dir,
    push: FALL_PUSH,
    lift: 0,
    reach,
    down: -1,
    side: member.id % 2 === 0 ? 1 : -1,
    cash: 0,
    gone: false,
    bumped: -1,
    ragdoll: null,
  };
  const fallen = state.emergency.fallen;
  fallen.push({ role: member.role, body });
  if (fallen.length > FALLEN_CAP) fallen.splice(0, fallen.length - FALLEN_CAP);
}

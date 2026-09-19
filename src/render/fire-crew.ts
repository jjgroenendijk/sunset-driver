/**
 * The crew of a fire engine at work (spec section 20.3), placed from the
 * record alone.
 *
 * Two firefighters climb down from the cab and run a hose each from the
 * coupling on the engine's flank to a place a throw short of the scene. They
 * hold the nozzle out in front of them, and the water leaves it there
 * (`hose.ts`): nothing sprays from the engine itself. At the end of the work
 * they turn the water off and carry the hose back.
 *
 * Where each of them stands, and where their hose lies, is worked out from
 * the unit and the tick, so a still frame and a replay show the same crew.
 * `sim/emergency.ts` says when the water is on (`hosing`), and this file only
 * says where it comes from. The bodies are drawn in the crowd's mesh
 * (`ui/fire-crews.ts`); the hose and the water in `emergency.ts`.
 */
import { DEPLOY_TICKS, HOSE_RANGE, hosing, STOW_TICKS, UNIT_BODY, workedTicks, type EmergencyUnit } from '../sim/emergency.ts';
import { STRIDE_HEIGHT, strideOf, type Gait, type PedestrianLook } from '../sim/pedestrian-look.ts';
import type { PedestrianPose } from '../sim/pedestrians.ts';
import { SKIN_TONES } from '../sim/character.ts';
import { TICK_RATE } from '../sim/clock.ts';
import { vary } from './casualty-pose.ts';
import { HANDS, REACH } from './officer-guns.ts';

/** Firefighters an engine at work puts on the street. */
export const CREW = 2;

/** How tall a firefighter is, in metres, boots and helmet on. */
export const FIREFIGHTER_HEIGHT = 1.8;

/** What a firefighter wears: a yellow helmet, a tan coat and tan trousers. */
const HELMET = 0xf0c419;
const COAT = 0x9c8350;
const TROUSERS = 0x6f5d38;

/**
 * Where the hose is coupled to the engine, in the engine's own frame: metres
 * along it from the middle, and metres over the road. There is one on each
 * flank, and a crew use the one on the side of the scene.
 */
export const OUTLET_ALONG = -0.05;
export const OUTLET_UP = 0.9;

/** Metres out from the flank a hose reaches the road. */
const OUTLET_OUT = 0.45;

/** Metres along the engine from the middle, and out from its flank, the crew climb down at. */
const DOOR_ALONG = UNIT_BODY.engine.halfLength - 1.5;
const DOOR_OUT = 0.5;

/**
 * Metres short of the scene a firefighter stands: the water covers the rest.
 * A scene close to the engine is met halfway, so they stand clear of it.
 */
const THROW = 6;

/** Metres out from the coupling a firefighter stands at least, and at most. */
const NEAREST = 1.5;
const FURTHEST = HOSE_RANGE - 2;

/** Metres to either side of the line to the scene the two stand, and how far the second stands back. */
const APART = 0.9;
const BEHIND = 0.7;

/** Ticks the second firefighter climbs down after the first. */
const STAGGER = 20;

/**
 * Ticks a firefighter stands at their place with the nozzle up before the
 * water comes, so they are never still walking when it does.
 */
const SETTLE = 30;

/** Metres from a firefighter's feet, towards the engine, the hose lies before it rises to the nozzle. */
const TRAIL = 0.4;

/** Points along the stretch of hose on the road. */
const LAID = 9;

/** How far the hose on the road bows out of a straight line, as a share of its length. */
const BOW = 0.12;

/** One firefighter as a frame draws them. */
export interface Firefighter {
  pose: PedestrianPose;
  /** Where the nozzle is: the map's x and y, and its height. */
  nozzleX: number;
  nozzleY: number;
  nozzleHeight: number;
  /** Whether water is leaving the nozzle this tick. */
  spraying: boolean;
  /** The hose from the coupling to the nozzle, as points of x, height and the map's y. */
  hose: number[];
}

/** A firefighter to be filled in by {@link fireCrew}. */
export function emptyFirefighter(): Firefighter {
  return {
    pose: { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' },
    nozzleX: 0,
    nozzleY: 0,
    nozzleHeight: 0,
    spraying: false,
    hose: [],
  };
}

/** The look of firefighter `member` of engine `id`: their own face, in turnout gear. */
export function firefighterLook(id: number, member: number): PedestrianLook {
  const skin = (SKIN_TONES[Math.floor(vary(id * CREW + member, 40) * SKIN_TONES.length)] as { colour: number }).colour;
  return { skin, hair: HELMET, top: COAT, legs: TROUSERS, height: FIREFIGHTER_HEIGHT, gait: 'brisk', speed: 1.6 };
}

/**
 * The crew of an engine on a tick, written into `out`, and how many of them
 * are on the street. None is out while the engine is not working a scene.
 */
export function fireCrew(unit: EmergencyUnit, tick: number, out: Firefighter[]): number {
  if (unit.kind !== 'engine') return 0;
  const worked = workedTicks(unit, tick);
  if (worked < 0) return 0;
  const cos = Math.cos(unit.heading);
  const sin = Math.sin(unit.heading);
  // The flank that faces the scene: +1 is the engine's left.
  const toX = unit.goalX - unit.x;
  const toY = unit.goalY - unit.y;
  const side = -toX * sin + toY * cos >= 0 ? 1 : -1;
  const out_ = UNIT_BODY.engine.halfWidth;
  const local = (along: number, across: number): [number, number] => [
    unit.x + along * cos - side * across * sin,
    unit.y + along * sin + side * across * cos,
  ];
  const [couplingX, couplingY] = local(OUTLET_ALONG, out_ + 0.08);
  const [groundX, groundY] = local(OUTLET_ALONG, out_ + OUTLET_OUT);
  const [doorX, doorY] = local(DOOR_ALONG, out_ + DOOR_OUT);
  // The line from where the hose meets the road to the scene.
  let lineX = unit.goalX - groundX;
  let lineY = unit.goalY - groundY;
  const reach = Math.hypot(lineX, lineY);
  lineX = reach > 0.01 ? lineX / reach : -side * sin;
  lineY = reach > 0.01 ? lineY / reach : side * cos;
  const stand = Math.min(FURTHEST, Math.max(NEAREST, reach - Math.min(THROW, reach / 2)));
  const water = hosing(unit, tick);
  const left = unit.until - tick;
  const scale = FIREFIGHTER_HEIGHT / STRIDE_HEIGHT;
  for (let member = 0; member < CREW; member++) {
    const f = (out[member] ??= emptyFirefighter());
    const across = member === 0 ? APART : -APART;
    const back = member === 0 ? 0 : BEHIND;
    const placeX = groundX + lineX * (stand - back) - lineY * across;
    const placeY = groundY + lineY * (stand - back) + lineX * across;
    // Out from the door at the start, and back to it at the end.
    const delay = member * STAGGER;
    const outward = (worked - delay) / (DEPLOY_TICKS - SETTLE - delay);
    const homeward = (STOW_TICKS - left - delay) / (STOW_TICKS - STAGGER - delay);
    const going = homeward > 0;
    const t = Math.min(1, Math.max(0, going ? 1 - homeward : outward));
    const path = Math.hypot(placeX - doorX, placeY - doorY);
    const pose = f.pose;
    pose.x = doorX + (placeX - doorX) * t;
    pose.y = doorY + (placeY - doorY) * t;
    pose.height = unit.height;
    const moving = t > 0 && t < 1;
    if (moving) {
      const ticks = going ? STOW_TICKS - STAGGER - delay : DEPLOY_TICKS - SETTLE - delay;
      pose.speed = (path / ticks) * TICK_RATE;
      pose.heading = going ? Math.atan2(doorY - placeY, doorX - placeX) : Math.atan2(placeY - doorY, placeX - doorX);
      const gait: Gait = pose.speed > 2.5 ? 'run' : 'brisk';
      pose.gait = gait;
      const cycles = (path * t) / strideOf(gait, FIREFIGHTER_HEIGHT);
      pose.cycle = cycles - Math.floor(cycles);
    } else {
      pose.speed = 0;
      pose.cycle = 0;
      // At their place they face the scene with the nozzle up; at the door, the engine.
      pose.gait = t >= 1 ? 'aim' : 'stand';
      pose.heading = t >= 1 ? Math.atan2(unit.goalY - pose.y, unit.goalX - pose.x) : Math.atan2(-side * cos, side * sin);
    }
    const hx = Math.cos(pose.heading);
    const hy = Math.sin(pose.heading);
    f.nozzleX = pose.x + hx * REACH * scale;
    f.nozzleY = pose.y + hy * REACH * scale;
    f.nozzleHeight = pose.height + HANDS * scale;
    f.spraying = water && t >= 1;
    // The hose trails from their feet back towards the engine, whichever way they face.
    const fromX = pose.x - groundX;
    const fromY = pose.y - groundY;
    const fromLength = Math.max(0.01, Math.hypot(fromX, fromY));
    const trail = Math.min(TRAIL, fromLength);
    const feetX = pose.x - (fromX / fromLength) * trail;
    const feetY = pose.y - (fromY / fromLength) * trail;
    layHose(f, unit.height, couplingX, couplingY, groundX, groundY, feetX, feetY, member);
  }
  return CREW;
}

/**
 * The hose of one firefighter: down from the coupling to the road, along the
 * road in a shallow bow to just behind their feet, and up to the nozzle.
 */
function layHose(f: Firefighter, road: number, cx: number, cy: number, gx: number, gy: number, fx: number, fy: number, member: number): void {
  const hose = f.hose;
  hose.length = 0;
  hose.push(cx, road + OUTLET_UP, cy);
  const dx = fx - gx;
  const dy = fy - gy;
  const bow = BOW * (member === 0 ? 1 : -1);
  for (let i = 0; i < LAID; i++) {
    const s = i / (LAID - 1);
    // A hose on the road lies in a curve, not a rod: out to one side and back.
    const off = 4 * s * (1 - s) * bow;
    hose.push(gx + dx * s - dy * off, road + 0.06, gy + dy * s + dx * off);
  }
  hose.push(f.nozzleX, f.nozzleHeight, f.nozzleY);
}

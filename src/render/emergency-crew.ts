/**
 * The crew of an emergency unit, drawn (spec section 20.3): what a
 * firefighter and a medic wear, and the hose that runs from the engine to the
 * nozzle in a firefighter's hands.
 *
 * Where each of them stands is the record's (`sim/emergency-crew.ts`), which
 * walks them out of the doors and back again. This file adds only what the
 * screen needs and the record does not carry: the face and the clothes, and
 * the line of the hose between the coupling on the engine's flank and the
 * nozzle. The water leaves that nozzle (`hose.ts`); nothing sprays from the
 * engine itself.
 *
 * The bodies are drawn in the crowd's own mesh (`ui/emergency-crews.ts`), and
 * a medic knelt at a body in the casualties' (`casualties.ts`).
 */
import {
  hosing,
  local,
  OUTLET_ALONG,
  OUTLET_OUT,
  OUTLET_UP,
  sceneSide,
  CREW_HEIGHT,
  type CrewMember,
  type CrewRole,
} from '../sim/emergency-crew.ts';
import { UNIT_BODY, type EmergencyUnit } from '../sim/emergency.ts';
import { STRIDE_HEIGHT, type PedestrianLook } from '../sim/pedestrian-look.ts';
import type { SimState } from '../sim/simulation.ts';
import { SKIN_TONES } from '../sim/character.ts';
import { vary } from './casualty-pose.ts';
import { HANDS, REACH } from './officer-guns.ts';

/** What a firefighter wears: a yellow helmet, a tan coat and tan trousers. */
const HELMET = 0xf0c419;
const COAT = 0x9c8350;
const TROUSERS = 0x6f5d38;

/** What a medic wears: a white or a pale green top, dark trousers, and their own hair. */
const MEDIC_TOPS = [0xf1f3ef, 0xb6dcc2] as const;
const MEDIC_LEGS = 0x1c2230;
const MEDIC_HAIR = [0x1b1410, 0x3a2716, 0x6b4a2b] as const;

/** Metres from a firefighter's feet, towards the engine, the hose lies before it rises to the nozzle. */
const TRAIL = 0.4;

/** Points along the stretch of hose on the road. */
const LAID = 9;

/** How far the hose on the road bows out of a straight line, as a share of its length. */
const BOW = 0.12;

/** One firefighter's hose as a frame draws it. */
export interface Hose {
  /** Where the nozzle is: the map's x and y, and its height. */
  nozzleX: number;
  nozzleY: number;
  nozzleHeight: number;
  /** Whether water is leaving the nozzle this tick. */
  spraying: boolean;
  /** The hose from the coupling to the nozzle, as points of x, height and the map's y. */
  points: number[];
}

/** A hose to be filled in by {@link hoseOf}. */
export function emptyHose(): Hose {
  return { nozzleX: 0, nozzleY: 0, nozzleHeight: 0, spraying: false, points: [] };
}

/** The look one of them wears: their own face, in the gear of their role. */
export function crewLook(id: number, role: CrewRole): PedestrianLook {
  const skin = (SKIN_TONES[Math.floor(vary(id, 40) * SKIN_TONES.length)] as { colour: number }).colour;
  const height = CREW_HEIGHT[role];
  if (role === 'firefighter') return { skin, hair: HELMET, top: COAT, legs: TROUSERS, height, gait: 'brisk', speed: 1.6 };
  return {
    skin,
    hair: MEDIC_HAIR[Math.floor(vary(id, 21) * MEDIC_HAIR.length)] as number,
    top: MEDIC_TOPS[id % MEDIC_TOPS.length] as number,
    legs: MEDIC_LEGS,
    height,
    gait: 'brisk',
    speed: 1.6,
  };
}

/**
 * The hose of one firefighter of `unit`, written into `out`: down from the
 * coupling on the flank that faces the scene to the road, along the road in a
 * shallow bow to just behind their feet, and up to the nozzle in their hands.
 */
export function hoseOf(state: SimState, unit: EmergencyUnit, member: CrewMember, out: Hose): Hose {
  const side = sceneSide(unit);
  const flank = UNIT_BODY.engine.halfWidth;
  const coupling = local(unit, OUTLET_ALONG, flank + 0.08, side);
  const ground = local(unit, OUTLET_ALONG, flank + OUTLET_OUT, side);
  const scale = CREW_HEIGHT[member.role] / STRIDE_HEIGHT;
  const working = member.task === 'work';
  out.nozzleX = member.x + Math.cos(member.heading) * REACH * scale;
  out.nozzleY = member.y + Math.sin(member.heading) * REACH * scale;
  out.nozzleHeight = member.height + HANDS * scale;
  out.spraying = working && hosing(state, unit);
  // The hose trails from their feet back towards the engine, whichever way they face.
  const fromX = member.x - ground.x;
  const fromY = member.y - ground.y;
  const fromLength = Math.max(0.01, Math.hypot(fromX, fromY));
  const trail = Math.min(TRAIL, fromLength);
  const feetX = member.x - (fromX / fromLength) * trail;
  const feetY = member.y - (fromY / fromLength) * trail;
  const points = out.points;
  points.length = 0;
  points.push(coupling.x, unit.height + OUTLET_UP, coupling.y);
  const dx = feetX - ground.x;
  const dy = feetY - ground.y;
  const bow = BOW * (member.member === 0 ? 1 : -1);
  for (let i = 0; i < LAID; i++) {
    const s = i / (LAID - 1);
    // A hose on the road lies in a curve, not a rod: out to one side and back.
    const off = 4 * s * (1 - s) * bow;
    points.push(ground.x + dx * s - dy * off, unit.height + 0.06, ground.y + dy * s + dx * off);
  }
  points.push(out.nozzleX, out.nozzleHeight, out.nozzleY);
  return out;
}

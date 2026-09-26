/**
 * The police on foot `--police` lays into a preview (spec section 14): a
 * patrol pair aiming at the player, a SWAT officer in armour, an officer
 * walking a beat, and one who has been put down. Each is written into the
 * record as `squad.ts` and `officer.ts` would have written them, so the frame
 * draws them through the game's own views.
 */
import { createOfficer, type Officer, type OfficerKind } from '../../sim/police/officer.ts';
import type { SimState } from '../../sim/simulation.ts';
import type { StandingPerson } from '../people/pedestrians.ts';
import { officerLook, officerPerson } from '../services/uniform.ts';

/** One officer to lay: where, ahead of and beside the player, what they are, and whether they aim. */
interface Lay {
  ahead: number;
  beside: number;
  kind: OfficerKind;
  aiming: boolean;
  speed: number;
}

const LAYS: readonly Lay[] = [
  { ahead: 4.5, beside: 3, kind: 'patrol', aiming: true, speed: 0 },
  { ahead: 5.5, beside: -2.5, kind: 'patrol', aiming: true, speed: 0 },
  { ahead: -4.5, beside: 3.5, kind: 'swat', aiming: true, speed: 0 },
  { ahead: -1, beside: -4.5, kind: 'patrol', aiming: false, speed: 1.45 },
];

/** Where the fallen officer lies, ahead of and beside the player. */
const FALLEN_AT = { ahead: -5, beside: -3 };

/** Lay the officers into the record, before a place facing `heading`, and answer them as the crowd draws them. */
export function layPolice(
  record: SimState,
  x: number,
  y: number,
  heading: number,
  heightAt: (x: number, y: number) => number,
  tick: number,
): StandingPerson[] {
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const at = (ahead: number, beside: number): { x: number; y: number } => ({
    x: x + cos * ahead - sin * beside,
    y: y + sin * ahead + cos * beside,
  });
  // Two stars and a shotgun's worth of heat: the patrol are armed.
  record.heat = 3.2;
  const people: StandingPerson[] = [];
  LAYS.forEach((lay, id) => {
    const place = at(lay.ahead, lay.beside);
    const facing = lay.aiming ? Math.atan2(y - place.y, x - place.x) : heading + Math.PI / 2;
    const officer: Officer = createOfficer(id, lay.kind, -1, lay.aiming ? 'pursue' : 'beat', place.x, place.y, heightAt(place.x, place.y), facing);
    officer.aiming = lay.aiming;
    officer.speed = lay.speed;
    officer.cycle = 0.3;
    record.police.officers.push(officer);
    people.push(officerPerson(officer, officerLook(record.seed, id, lay.kind)));
  });
  const place = at(FALLEN_AT.ahead, FALLEN_AT.beside);
  const ground = heightAt(place.x, place.y);
  record.police.fallen.push({
    kind: 'patrol',
    body: {
      id: LAYS.length,
      since: tick - 600,
      first: tick - 600,
      cause: 'shot',
      health: 0,
      x: place.x,
      y: place.y,
      height: ground,
      rest: ground,
      heading,
      dir: heading + 2,
      push: 1.6,
      lift: 0,
      reach: 1.4,
      down: -1,
      side: 1,
      cash: 0,
      gone: false,
      bumped: -1,
      ragdoll: null,
    },
  });
  return people;
}

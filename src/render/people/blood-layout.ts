/**
 * Where the blood on the ground lies, worked out from the record and the tick.
 *
 * Three kinds of mark, every one a flat patch on the ground:
 *
 * - A **pool** under a body lying still. It spreads over {@link POOL_TICKS}
 *   from the tick the body came to rest. The dead bleed most; the wounded
 *   bleed less the less they are hurt, and their pool fades once they get up.
 * - A **smear** where a car threw somebody: a streak along the way they slid,
 *   from where they came down to where they stopped, and a mark where they
 *   were struck.
 * - **Spatter**: small spots around the place a round or a blow met a person.
 *
 * Pools and smears are a function of the casualty's record, so a loaded save
 * shows them. The record keeps no hit once it is a few ticks old, so the view
 * keeps its own short list of them for the spatter (`blood.ts`).
 *
 * The gore level sets every size (`gore.ts`). Off lays nothing.
 */
import { hashInts } from '../../core/hash.ts';
import { casualtyPose, emptyCasualtyPose, restDistance, restTicks, throwOf } from '../../sim/crowd/casualty-motion.ts';
import { dead, PERSON_HEALTH, type Casualty } from '../../sim/crowd/casualty.ts';
import { TICK_RATE } from '../../sim/clock.ts';
import { GORE, type Gore } from './gore.ts';

/** Marks one batch draws: pools, smears and spots together. */
export const BLOOD_CAP = 128;

/** Spots of spatter drawn at once. The oldest go first. */
export const SPATTER_CAP = 64;

/** Ticks a pool takes to spread to its full size, and ticks it takes to dry dark. */
export const POOL_TICKS = 30 * TICK_RATE;
const DRY_TICKS = 3 * 60 * TICK_RATE;

/** Ticks the pool of a wounded person takes to fade once they are up again. */
const POOL_FADE = 8 * TICK_RATE;

/** The share of its full size a pool starts at, so the first frame shows something. */
const POOL_START = 0.15;

/** How big the pool of the worst wounded is, as a share of the pool of the dead. */
const WOUND_SHARE = 0.45;

/** Metres of slide below which a throw leaves no smear. */
const SMEAR_MIN = 0.4;

/** How big the mark where a car struck is, as a share of the smear's width. */
const IMPACT_SHARE = 1.6;

/** Ticks a spot of spatter lasts, and the ticks at the end of that it fades over. */
const SPATTER_LIFE = 3 * 60 * TICK_RATE;
const SPATTER_FADE = 20 * TICK_RATE;

/** One mark on the ground. `y` is the map's; `h` is the ground's height. */
export interface BloodMark {
  /** The casualty it belongs to, or -1 for a spot of spatter. */
  owner: number;
  x: number;
  y: number;
  h: number;
  /** Radians on the map the long side of the mark lies along. */
  angle: number;
  /** Metres along its angle, and metres across. */
  length: number;
  width: number;
  /** How much of it shows, 0 to 1. */
  alpha: number;
  /** A number of its own, 0 to 1, which gives the mark its own outline. */
  variant: number;
  /** 0 for a round blot, 1 for a streak. */
  streak: number;
  /** 0 while fresh, 1 once dried dark. */
  age: number;
}

/** A place a round or a blow met a person, as the view remembers it. */
export interface Spatter {
  tick: number;
  x: number;
  y: number;
  /** The height of the ground under it, not of the hit. */
  h: number;
  /** How hard it was, 0 to 1. */
  strength: number;
}

export function emptyMark(): BloodMark {
  return { owner: -1, x: 0, y: 0, h: 0, angle: 0, length: 0, width: 0, alpha: 0, variant: 0, streak: 0, age: 0 };
}

/** A hash as a number from 0 to 1. */
function unit(hash: number): number {
  return hash / 0x100000000;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** The next mark of `out` to write, made on first use. */
function slot(out: BloodMark[], index: number): BloodMark {
  let mark = out[index];
  if (mark === undefined) {
    mark = emptyMark();
    out[index] = mark;
  }
  return mark;
}

const pose = emptyCasualtyPose();

/**
 * Lay the pools and smears of every casualty still on the record into `out`,
 * from `start`, and answer how many there are now. A body taken away lays
 * nothing, and nor does anything past {@link BLOOD_CAP}.
 */
export function casualtyMarks(
  casualties: readonly Casualty[],
  tick: number,
  gore: Gore,
  out: BloodMark[],
  start = 0,
): number {
  const scale = GORE[gore];
  let n = start;
  if (scale.pool <= 0) return n;
  for (const record of casualties) {
    if (record.gone) continue;
    if (n < BLOOD_CAP && scale.smear > 0 && record.cause === 'car') n = smear(record, tick, scale.smear, scale.smearLength, out, n);
    if (n < BLOOD_CAP) n = pool(record, tick, scale.pool, out, n);
  }
  return n;
}

/** The pool under a body lying still, if there is one. */
function pool(record: Casualty, tick: number, full: number, out: BloodMark[], n: number): number {
  const rest = record.since + restTicks(record);
  if (tick < rest) return n;
  const killed = dead(record);
  // A stagger never takes them off their feet, so they bleed nowhere.
  if (!killed && record.down === 0) return n;
  const up = killed || record.down < 0 ? Infinity : rest + record.down;
  const spread = clamp01((Math.min(tick, up) - rest) / POOL_TICKS);
  const harm = clamp01(1 - record.health / PERSON_HEALTH);
  const size = killed ? full : full * WOUND_SHARE * (0.4 + 0.6 * harm);
  const alpha = tick < up ? 1 : 1 - (tick - up) / POOL_FADE;
  if (alpha <= 0) return n;
  casualtyPose(record, rest, pose);
  const variant = unit(hashInts(record.id, record.since, 1));
  const mark = slot(out, n);
  mark.owner = record.id;
  mark.x = pose.x;
  mark.y = pose.y;
  mark.h = pose.height;
  mark.angle = record.dir + variant * Math.PI;
  // It spreads fast at first and slows, as a pool does on a flat road.
  mark.length = size * (POOL_START + (1 - POOL_START) * (1 - (1 - spread) * (1 - spread)));
  mark.width = mark.length * (0.7 + 0.3 * unit(hashInts(record.id, record.since, 2)));
  mark.alpha = alpha;
  mark.variant = variant;
  mark.streak = 0;
  mark.age = clamp01((tick - rest) / DRY_TICKS);
  return n + 1;
}

/**
 * The streak a thrown body leaves along the road, and the mark where the car
 * struck. The streak runs from where the body came down, and grows with the
 * slide, so it is never ahead of the body.
 */
function smear(record: Casualty, tick: number, width: number, share: number, out: BloodMark[], n: number): number {
  if (tick < record.since) return n;
  const variant = unit(hashInts(record.id, record.since, 3));
  const impact = slot(out, n++);
  impact.owner = record.id;
  impact.x = record.x;
  impact.y = record.y;
  impact.h = record.height;
  impact.angle = record.dir;
  impact.length = width * IMPACT_SHARE;
  impact.width = width * IMPACT_SHARE * 0.8;
  impact.alpha = 0.85;
  impact.variant = variant;
  impact.streak = 0;
  impact.age = clamp01((tick - record.since) / DRY_TICKS);
  if (n >= BLOOD_CAP) return n;
  const rest = restDistance(record);
  const from = Math.min(throwOf(record).airDistance, rest);
  if (rest - from < SMEAR_MIN) return n;
  // How far along the body has got, which the smear may not pass.
  casualtyPose(record, Math.min(tick, record.since + restTicks(record)), pose);
  const along = Math.min(rest, Math.hypot(pose.x - record.x, pose.y - record.y));
  const length = (along - from) * share;
  if (length <= 0) return n;
  const middle = from + length / 2;
  const mark = slot(out, n);
  mark.owner = record.id;
  mark.x = record.x + Math.cos(record.dir) * middle;
  mark.y = record.y + Math.sin(record.dir) * middle;
  mark.h = record.height + (record.rest - record.height) * (rest > 0 ? middle / rest : 1);
  mark.angle = record.dir;
  mark.length = length;
  mark.width = width * (0.8 + 0.4 * variant);
  mark.alpha = 0.9;
  mark.variant = variant;
  mark.streak = 1;
  mark.age = impact.age;
  return n + 1;
}

/**
 * Lay the spots of spatter around every remembered hit into `out`, from
 * `start`, newest first, and answer how many marks there are now. At most
 * {@link SPATTER_CAP} spots are laid, and never past {@link BLOOD_CAP}.
 */
export function spatterMarks(hits: readonly Spatter[], tick: number, gore: Gore, out: BloodMark[], start = 0): number {
  const scale = GORE[gore];
  let n = start;
  if (scale.spots <= 0) return n;
  const end = Math.min(BLOOD_CAP, start + SPATTER_CAP);
  for (let h = hits.length - 1; h >= 0 && n < end; h--) {
    const hit = hits[h] as Spatter;
    const age = tick - hit.tick;
    if (age < 0 || age >= SPATTER_LIFE) continue;
    const alpha = Math.min(1, (SPATTER_LIFE - age) / SPATTER_FADE);
    const count = Math.max(1, Math.round(scale.spots * (0.5 + hit.strength)));
    // The place is hashed to the centimetre, so two hits on one tick throw two patterns.
    const px = Math.round(hit.x * 100);
    const py = Math.round(hit.y * 100);
    for (let i = 0; i < count && n < end; i++) {
      const heading = unit(hashInts(hit.tick, px, py, i, 1)) * Math.PI * 2;
      // Most spots land close in, a few further out.
      const far = unit(hashInts(hit.tick, px, py, i, 2));
      const reach = scale.reach * (0.15 + 0.85 * far * far);
      const size = scale.spot * (0.1 + 0.22 * unit(hashInts(hit.tick, px, py, i, 3))) * (1 - 0.4 * far);
      const mark = slot(out, n++);
      mark.owner = -1;
      mark.x = hit.x + Math.cos(heading) * reach;
      mark.y = hit.y + Math.sin(heading) * reach;
      mark.h = hit.h;
      // A spot thrown far lands long, pointing away from the hit.
      mark.angle = heading;
      mark.length = size * (1 + far);
      mark.width = size;
      mark.alpha = alpha;
      mark.variant = unit(hashInts(hit.tick, px, py, i, 4));
      mark.streak = 0;
      mark.age = clamp01(age / DRY_TICKS);
    }
  }
  return n;
}

/**
 * The side work a contact hands out, and how one job is assembled from the
 * seeded world (spec section 18).
 *
 * A job is a list of legs and a clock. A leg is one place and one thing to do
 * there — arrive, arrive at the wheel of a named class of vehicle, stand your
 * ground for a while, or take the block — and the seven kinds the spec lists
 * are seven arrangements of those four. That is what makes the stream endless:
 * a kind is drawn, the places are drawn from the streets the seed laid out, and
 * the pay and the clock follow from how far apart they landed.
 *
 * Nothing here is kept. A contact's board is a pure function of the seed, the
 * contact and {@link offerIndex}, which turns over on the clock and again every
 * time a job ends, so two runs of one seed are offered the same work in the
 * same order and a player who walks away from a job is not offered it for ever.
 * What the record carries is the job the player took (`mission.ts`).
 *
 * Pure: it reads the world's districts and the record, and takes no wall-clock
 * and no unseeded randomness.
 */
import { rngFor, Subsystem } from '../core/rng.ts';
import { cos, hypot, sin } from '../core/libm.ts';
import { TICKS_PER_HOUR } from './clock.ts';
import { FACTIONS, factionIndex, type Faction } from './faction.ts';
import type { GiverPlace } from './giver.ts';
import type { Place } from './on-foot.ts';
import type { SimState } from './simulation.ts';
import { blockKeyAt, TAKEOVER_TICKS } from './territory.ts';
import { specOf, type VehicleClass } from './vehicle.ts';
import type { District } from '../world/types.ts';

/** The kinds of work spec section 18 lists. */
export type JobKind = 'delivery' | 'theft' | 'pursuit' | 'protection' | 'sabotage' | 'race' | 'territory';

/** What is asked at one place of a job. */
export type LegKind =
  /** Be there, on foot or at the wheel. */
  | 'go'
  /** Be there driving a vehicle of the job's own class. */
  | 'drive'
  /** Stand there on foot until the leg's ticks are up. */
  | 'hold'
  /** Hold the block that place stands in (spec section 17.2). */
  | 'take';

/** One leg of a job: a place, what is asked there, and what the HUD calls it. */
export interface JobLeg {
  kind: LegKind;
  x: number;
  y: number;
  /** Ticks a `hold` leg is stood for; 0 on every other kind. */
  ticks: number;
  /** The line the HUD shows while this leg is the one being worked on. */
  label: string;
}

/** A job, as the board offers it and the record carries it. */
export interface MissionJob {
  kind: JobKind;
  /** The contact who handed it out: an index into the world's contacts. */
  giver: number;
  /** The faction paying for it, and the faction it is aimed at, or -1 for none. */
  faction: number;
  against: number;
  /** What the panel and the HUD call it. */
  title: string;
  /** The legs, in the order they are to be done. */
  legs: JobLeg[];
  /** The leg being worked on. */
  leg: number;
  /** Ticks already stood on a `hold` leg, which walking away puts back to zero. */
  held: number;
  /** The tick it was taken on, or -1 while it is only an offer. */
  taken: number;
  /** Ticks allowed from the moment it is taken. */
  limit: number;
  /** Dollars it pays. */
  pay: number;
  /** The class a `drive` leg wants, or '' where any vehicle will do. */
  cls: VehicleClass | '';
  /** The block a `take` leg is for, or -1 on every other kind. */
  block: number;
  /** The chapter of the authored chain this is (`chain.ts`), or '' for side work. */
  chapter: string;
}

/** A job as a board offers it: what it is, the row that takes it, and what the giver says with it. */
export interface JobOffer {
  job: MissionJob;
  /** What the row that takes it says, which is the choice at the fork of the chain. */
  label: string;
  /** A line about the offer, which the chain's chapters carry and the side work does not. */
  note: string;
}

/** A street corner a job's legs are placed on. */
export interface JobSite extends Place {
  /** The district it stands in, which is what the job calls the place. */
  district: District;
}

/** The world a job is built from: who hands work out and where it can send them. */
export interface MissionWorld {
  givers: readonly GiverPlace[];
  sites: readonly JobSite[];
}

/** Corners kept in each district for the jobs to be placed on. */
const SITES_PER_DISTRICT = 3;

/** Metres from the middle of a district a corner is looked for, and the most it may end up at. */
const SITE_NEAR = 40;
const SITE_FAR = 220;
const SITE_LIMIT = 320;

/** Game ticks a contact's board stands before the work on it turns over. */
export const OFFER_TICKS = TICKS_PER_HOUR * 2;

/** Metres apart two legs of one job are pushed, so no job is finished by standing still. */
const MIN_RUN = 260;

/** Checkpoints a race is run over, the first of them being the start line. */
const RACE_LEGS = 4;

/** Ticks a protection job is stood out, and a sabotage job takes to set. */
const GUARD_TICKS = 45 * 60;
const SABOTAGE_TICKS = 12 * 60;

/** Metres a second the clock of a job is set by: a steady drive, and a hurried one. */
const PACE = 7.5;
const FAST_PACE = 13;

/** Ticks added to every clock, so a job is not lost to the walk to the car. */
const GRACE = 40 * 60;

/** Dollars a job pays before the distance is counted, per kind. */
const PAY_BASE: Readonly<Record<JobKind, number>> = Object.freeze({
  delivery: 250,
  theft: 600,
  pursuit: 500,
  protection: 700,
  sabotage: 650,
  race: 450,
  territory: 900,
});

/** Dollars each metre of the run adds, and the dollars a payment is rounded to. */
const PAY_PER_METRE = 1.1;
const PAY_STEP = 25;

/** The classes a theft job asks for: what somebody pays to have stolen. */
const THEFT_CLASSES: readonly VehicleClass[] = ['sports', 'saloon', 'compact', 'van', 'motorcycle', 'offroad', 'truck'];

/**
 * The corners of a world the jobs are placed on: a handful in each district,
 * snapped to the street nearest each of them. `snap` is the same one the
 * dealers and the front doors take (`dealer.ts`, `safehouse.ts`), so a
 * simulation test can lay out a world of its own.
 */
export function jobSites(
  seed: number,
  districts: readonly District[],
  snap: (x: number, y: number) => Place | undefined,
): JobSite[] {
  const sites: JobSite[] = [];
  for (const district of districts) {
    const rng = rngFor(seed, 1, Subsystem.Missions, district.id);
    const turn = rng.range(0, Math.PI * 2);
    for (let i = 0; i < SITES_PER_DISTRICT; i++) {
      const angle = turn + (i / SITES_PER_DISTRICT) * Math.PI * 2;
      const away = rng.range(SITE_NEAR, SITE_FAR);
      const place = snap(district.x + cos(angle) * away, district.y + sin(angle) * away);
      if (place === undefined) continue;
      if (hypot(place.x - district.x, place.y - district.y) > SITE_LIMIT) continue;
      sites.push({ district, x: place.x, y: place.y, heading: place.heading });
    }
  }
  return sites;
}

/**
 * Which job of the endless stream a board is showing. It steps on the clock, so
 * a contact who has nothing a player fancies has something else in two hours,
 * and it steps again whenever a job ends, so the board a player comes back to
 * after finishing one is never the board they left.
 */
export function offerIndex(state: SimState): number {
  return Math.floor(Math.max(0, state.tick) / OFFER_TICKS) + state.missions.done + state.missions.failed;
}

/**
 * The job a contact is offering, or undefined where the world gave the job
 * nowhere to send the player. It is a fresh job every time it is asked for, so
 * nothing but the record is kept: taking one is what copies it in.
 */
export function offerFor(state: SimState, world: MissionWorld, giver: GiverPlace): MissionJob | undefined {
  const sites = world.sites;
  if (sites.length < 2) return undefined;
  const rng = rngFor(state.seed, offerIndex(state), Subsystem.Missions, giver.id);
  const first = nearestSite(sites, giver.x, giver.y, rng.int(0, Math.min(2, sites.length - 1)));
  const away = furtherSite(sites, first, rng.int(0, sites.length - 1));
  const kind = kindOf(rng.int(0, 6), giver);
  const job: MissionJob = {
    kind,
    giver: giver.id,
    faction: giver.faction,
    against: rivalOf(giver.faction, rng.int(0, 1)),
    title: '',
    legs: [],
    leg: 0,
    held: 0,
    taken: -1,
    limit: 0,
    pay: 0,
    cls: kind === 'theft' ? (THEFT_CLASSES[rng.int(0, THEFT_CLASSES.length - 1)] as VehicleClass) : '',
    block: kind === 'territory' ? blockKeyAt(away.x, away.y) : -1,
    chapter: '',
  };
  job.legs = legsOf(job, first, away, sites, rng.int(0, sites.length - 1));
  job.title = titleOf(job, first, away);
  // The clock and the price are both read off the ground the job covers, and
  // that starts at the contact: a job of one leg is still a drive across town.
  const run = runOf(job, giver);
  job.limit = limitOf(job, run);
  job.pay = payOf(job, run);
  return job;
}

/** The legs of each kind of job, which is the whole of what tells them apart. */
function legsOf(job: MissionJob, first: JobSite, away: JobSite, sites: readonly JobSite[], from: number): JobLeg[] {
  const here = (site: JobSite): string => site.district.name;
  switch (job.kind) {
    case 'delivery':
      return [leg('go', first, `Collect the package in ${here(first)}`), leg('go', away, `Deliver it to ${here(away)}`)];
    case 'theft':
      return [
        leg('go', first, `Look for ${aNamed(job.cls)} in ${here(first)}`),
        leg('drive', away, `Bring the ${named(job.cls)} to ${here(away)}`),
      ];
    case 'pursuit':
      return [leg('go', first, `Pick up the trail in ${here(first)}`), leg('go', away, `Cut them off in ${here(away)}`)];
    case 'protection':
      return [hold('hold', first, GUARD_TICKS, `Stand over the pitch in ${here(first)}`)];
    case 'sabotage':
      return [hold('hold', away, SABOTAGE_TICKS, `Set the charge in ${here(away)}`)];
    case 'race':
      return raceLegs(sites, first, from);
    case 'territory':
      return [leg('take', away, `Take the block in ${here(away)}`)];
  }
}

/** The checkpoints of a race: the start line, then three more corners in order. */
function raceLegs(sites: readonly JobSite[], start: JobSite, from: number): JobLeg[] {
  const legs: JobLeg[] = [leg('drive', start, `Get to the start line in ${start.district.name}`)];
  let at = start;
  for (let i = 1; i < RACE_LEGS; i++) {
    at = furtherSite(sites, at, from + i);
    legs.push(leg('drive', at, `Checkpoint ${i} of ${RACE_LEGS - 1} in ${at.district.name}`));
  }
  return legs;
}

/** What a job calls a class of vehicle: the roster's own name, not the id (`vehicle.ts`). */
function named(cls: VehicleClass | ''): string {
  return cls === '' ? 'vehicle' : specOf(cls).name.toLowerCase();
}

/** The same with its article, because the roster holds an off-roader as well as a saloon. */
function aNamed(cls: VehicleClass | ''): string {
  const name = named(cls);
  return `${'aeiou'.includes(name[0] ?? '') ? 'an' : 'a'} ${name}`;
}

function leg(kind: LegKind, site: JobSite, label: string): JobLeg {
  return { kind, x: site.x, y: site.y, ticks: 0, label };
}

function hold(kind: LegKind, site: JobSite, ticks: number, label: string): JobLeg {
  return { kind, x: site.x, y: site.y, ticks, label };
}

/**
 * The kind of work a draw asks for. A territory job is the one kind the world
 * can refuse: a block is taken off a faction the player has crossed
 * (`territory.ts`), so a contact with no rival to point at hands out a delivery
 * instead of work nobody could do.
 */
function kindOf(draw: number, giver: GiverPlace): JobKind {
  const kinds: readonly JobKind[] = ['delivery', 'theft', 'pursuit', 'protection', 'sabotage', 'race', 'territory'];
  const kind = kinds[Math.min(draw, kinds.length - 1)] as JobKind;
  if (kind !== 'territory' && kind !== 'protection' && kind !== 'sabotage') return kind;
  return rivalOf(giver.faction, 0) < 0 ? 'delivery' : kind;
}

/** A rival of a faction, which is who the work it pays for is aimed at. */
export function rivalOf(faction: number, draw: number): number {
  const rivals = (FACTIONS[faction] as Faction | undefined)?.rivals ?? [];
  if (rivals.length === 0) return -1;
  return factionIndex(rivals[draw % rivals.length] as (typeof rivals)[number]);
}

/** The corner nearest a place, counting from the `skip`-th nearest, so two jobs do not share one. */
export function nearestSite(sites: readonly JobSite[], x: number, y: number, skip: number): JobSite {
  const order = sites.map((site, i) => ({ i, away: hypot(site.x - x, site.y - y) }));
  order.sort((a, b) => a.away - b.away || a.i - b.i);
  return sites[(order[Math.min(skip, order.length - 1)] as { i: number }).i] as JobSite;
}

/**
 * A corner at least {@link MIN_RUN} from another, walked to from a drawn place
 * in the list so the answer is a pure function of the draw. The furthest corner
 * of the world answers where nothing is far enough, which is a small world
 * rather than a broken one.
 */
export function furtherSite(sites: readonly JobSite[], from: JobSite, draw: number): JobSite {
  let best = from;
  let bestAway = -1;
  for (let i = 0; i < sites.length; i++) {
    const site = sites[(draw + i) % sites.length] as JobSite;
    const away = hypot(site.x - from.x, site.y - from.y);
    if (away >= MIN_RUN) return site;
    if (away <= bestAway) continue;
    bestAway = away;
    best = site;
  }
  return best;
}

/** What the board and the HUD call a job. */
function titleOf(job: MissionJob, first: JobSite, away: JobSite): string {
  const name = (FACTIONS[job.against] as Faction | undefined)?.name ?? 'the competition';
  switch (job.kind) {
    case 'delivery':
      return `Run a package to ${away.district.name}`;
    case 'theft':
      return `Steal ${aNamed(job.cls)} for the yard in ${away.district.name}`;
    case 'pursuit':
      return `Head off a runner from ${first.district.name}`;
    case 'protection':
      return `Stand over a corner in ${first.district.name}`;
    case 'sabotage':
      return `Burn a stash of ${name} in ${away.district.name}`;
    case 'race':
      return `Race the streets of ${first.district.name}`;
    case 'territory':
      return `Take a block off ${name} in ${away.district.name}`;
  }
}

/** Metres a job covers: the walk from the contact to the first leg, then leg to leg. */
export function runOf(job: MissionJob, from: Place): number {
  let run = 0;
  let at: { x: number; y: number } = from;
  for (const leg of job.legs) {
    run += hypot(leg.x - at.x, leg.y - at.y);
    at = leg;
  }
  return run;
}

/**
 * Ticks a job allows: the run at its own pace, everything it asks the player to
 * stand still for, and the grace every job gets. A block is one of those: the
 * takeover of spec section 17.2 is forty seconds of standing on it, and a
 * territory job that did not allow for them could not be finished.
 */
export function limitOf(job: MissionJob, run: number): number {
  let held = job.kind === 'territory' ? TAKEOVER_TICKS : 0;
  for (const leg of job.legs) held += leg.ticks;
  const pace = job.kind === 'race' || job.kind === 'pursuit' ? FAST_PACE : PACE;
  return Math.round((run / pace) * 60) + held + GRACE;
}

/** Dollars a job pays: what the kind is worth, and what the ground it covers adds. */
function payOf(job: MissionJob, run: number): number {
  const raw = (PAY_BASE[job.kind] as number) + run * PAY_PER_METRE;
  return Math.max(PAY_STEP, Math.round(raw / PAY_STEP) * PAY_STEP);
}

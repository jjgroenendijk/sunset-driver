/**
 * The authored spine of spec section 18: a short hand-written chain of work,
 * handed out by more than one contact, with a fork in the middle and an end
 * that can be lost.
 *
 * The side work of `job.ts` is drawn from the seed and never runs out. This is
 * the other half: eight chapters written by hand, walked in order, six slots
 * deep. A chapter is an ordinary {@link MissionJob} — the same legs, the same
 * clock, the same state machine in `mission.ts` — so nothing new watches the
 * player. What is written here is which contact offers it, what it asks, what
 * it says, and what losing it costs.
 *
 * It is anchored to whatever the seed produced. The chain is written between
 * two sides, a patron and a rival, and each is a faction of spec section 17.1;
 * but a seed may leave a faction without a district and so without a contact
 * (`giver.ts`), so each side falls back to a corner the seed did give. The
 * places the legs stand on are the same street corners the side work uses, and
 * no leg asks for ground a seed may not have laid: a block the seed never gave
 * a faction could not be taken, and a spine nobody can walk is not a spine.
 *
 * The fork is two chapters in one slot, offered at the same time by the two
 * sides' contacts. Finishing one is the choice: it writes the branch onto the
 * record, and from then on only that side has work. Handing one back leaves the
 * fork open.
 *
 * Pure: it reads the world and the record, and takes no wall-clock.
 */
import { hypot } from '../../core/libm.ts';
import { rngFor, Subsystem } from '../../core/rng.ts';
import { factionIndex, type FactionId } from '../crime/faction.ts';
import type { GiverPlace } from './giver.ts';
import {
  furtherSite,
  limitOf,
  nearestSite,
  rivalOf,
  runOf,
  type JobKind,
  type JobLeg,
  type JobOffer,
  type JobSite,
  type MissionJob,
  type MissionWorld,
} from './job.ts';
import type { SimState } from '../simulation.ts';
import type { VehicleClass } from '../vehicles/vehicle.ts';

/** The two sides the chain is written between, and which of them a chapter belongs to. */
export type ChainRole = 'patron' | 'rival';

/** The side the player threw in with at the fork, or '' before they did. */
type ChainBranch = '' | ChainRole;

/** How the chain finished: '' while it is still being walked. */
type ChainEnd = '' | 'done' | 'burned';

/** The factions the two sides are, where the seed gave them a corner to stand on. */
const SIDES: Readonly<Record<ChainRole, FactionId>> = Object.freeze({
  patron: 'docklands',
  rival: 'syndicate',
});

/** The tick the chain's own random stream is keyed on: 0 and 1 are the contacts and the corners. */
const CHAIN_TICK = 2;

/** Where one leg of a chapter stands. */
type ChapterWhere =
  /** A corner by the contact handing the chapter out. */
  | 'near'
  /** A corner by the other side's contact. */
  | 'other'
  /** A corner across town from the leg before it. */
  | 'far';

/** One leg of a chapter, before the seed says which corner it lands on. */
interface ChapterLeg {
  /** `take` is not among them: see the note at the top of the file. */
  kind: 'go' | 'drive' | 'hold';
  where: ChapterWhere;
  /** Ticks a `hold` leg is stood for. */
  ticks?: number;
  /** The line the HUD shows, `{where}` standing for the district the corner landed in. */
  label: string;
}

/** One chapter of the chain, as it is written. */
export interface Chapter {
  /** What the record calls it, which is what a saved job carries. */
  id: string;
  /** The slot it stands in. The chain is walked slot by slot. */
  step: number;
  /** The side it belongs to, or '' for the chapters every player walks. */
  branch: ChainBranch;
  /** Which side's contact hands it out. */
  role: ChainRole;
  /** The kind of work it is, which sets its pace and what its finish calls out. */
  kind: JobKind;
  /** What the board and the HUD call it. */
  title: string;
  /** What the contact says with it, in one line. */
  brief: string;
  /** What the row that takes it says. At the fork, this is the choice. */
  choice: string;
  legs: readonly ChapterLeg[];
  /** Dollars it pays. A chapter is written, so its price is written too. */
  pay: number;
  /** The class a `drive` leg asks for, or '' where any vehicle will do. */
  cls: VehicleClass | '';
  /** What losing it does: offered again, or the end of the chain. */
  onLoss: 'retry' | 'burn';
  /** What the HUD says when it is behind the player. */
  said: string;
  /** What the HUD says when it is lost. */
  lost: string;
}

/**
 * The chain. Three chapters every player walks, a fork of two, and two more on
 * each side of it. The last chapter of either side is the one that cannot be
 * retried: losing it ends the chain where it stands.
 */
export const CHAPTERS: readonly Chapter[] = Object.freeze([
  Object.freeze({
    id: 'debt',
    step: 0,
    branch: '' as ChainBranch,
    role: 'patron' as ChainRole,
    kind: 'delivery' as JobKind,
    title: 'Work the debt off',
    brief: 'You owe the boat that brought you in. Carry the crate, ask nothing.',
    choice: 'Take the crate',
    legs: Object.freeze([
      { kind: 'go' as const, where: 'near' as ChapterWhere, label: 'Collect the crate in {where}' },
      { kind: 'go' as const, where: 'far' as ChapterWhere, label: 'Carry the crate to {where}' },
    ]),
    pay: 400,
    cls: '' as const,
    onLoss: 'retry' as const,
    said: 'The crate is off your hands. They will call again.',
    lost: 'They will give you another go at it.',
  }),
  Object.freeze({
    id: 'plates',
    step: 1,
    branch: '' as ChainBranch,
    role: 'patron' as ChainRole,
    kind: 'theft' as JobKind,
    title: 'A van for the yard',
    brief: 'The yard is short a van. Nobody asks where it came from.',
    choice: 'Take the job',
    legs: Object.freeze([
      { kind: 'go' as const, where: 'near' as ChapterWhere, label: 'Find a van parked in {where}' },
      { kind: 'drive' as const, where: 'far' as ChapterWhere, label: 'Bring the van to the yard in {where}' },
    ]),
    pay: 750,
    cls: 'van' as const,
    onLoss: 'retry' as const,
    said: 'The van is in the yard. They are starting to trust you.',
    lost: 'They will give you another go at it.',
  }),
  Object.freeze({
    id: 'count',
    step: 2,
    branch: '' as ChainBranch,
    role: 'patron' as ChainRole,
    kind: 'protection' as JobKind,
    title: 'Stand over the count',
    brief: 'The money is counted on the corner tonight. Stand where it is counted.',
    choice: 'Stand over it',
    legs: Object.freeze([
      { kind: 'hold' as const, where: 'near' as ChapterWhere, ticks: 30 * 60, label: 'Stand over the count in {where}' },
    ]),
    pay: 950,
    cls: '' as const,
    onLoss: 'retry' as const,
    said: 'The count went out clean. Now both sides want to know whose you are.',
    lost: 'They will give you another go at it.',
  }),
  Object.freeze({
    id: 'stash',
    step: 3,
    branch: 'patron' as ChainBranch,
    role: 'patron' as ChainRole,
    kind: 'sabotage' as JobKind,
    title: 'Burn the other side out',
    brief: 'Burn their stash and the docks are ours. They will know who did it.',
    choice: 'Burn the stash',
    legs: Object.freeze([
      { kind: 'hold' as const, where: 'other' as ChapterWhere, ticks: 12 * 60, label: 'Set the charge in {where}' },
    ]),
    pay: 1300,
    cls: '' as const,
    onLoss: 'retry' as const,
    said: 'The stash is ash. You belong to the docks now.',
    lost: 'They will give you another go at it.',
  }),
  Object.freeze({
    id: 'route',
    step: 3,
    branch: 'rival' as ChainBranch,
    role: 'rival' as ChainRole,
    kind: 'delivery' as JobKind,
    title: 'Sell the route',
    brief: 'Bring us the manifest of the boat you unloaded. We pay better than they do.',
    choice: 'Sell the route',
    legs: Object.freeze([
      { kind: 'go' as const, where: 'other' as ChapterWhere, label: 'Lift the manifest in {where}' },
      { kind: 'go' as const, where: 'near' as ChapterWhere, label: 'Hand the manifest over in {where}' },
    ]),
    pay: 1300,
    cls: '' as const,
    onLoss: 'retry' as const,
    said: 'The route is sold. There is no going back to the docks.',
    lost: 'They will give you another go at it.',
  }),
  Object.freeze({
    id: 'pier',
    step: 4,
    branch: 'patron' as ChainBranch,
    role: 'patron' as ChainRole,
    kind: 'protection' as JobKind,
    title: 'Clear the pier',
    brief: 'They are coming for the pier tonight. Be standing on it when they do.',
    choice: 'Hold the pier',
    legs: Object.freeze([
      { kind: 'hold' as const, where: 'near' as ChapterWhere, ticks: 45 * 60, label: 'Hold the pier in {where}' },
    ]),
    pay: 1700,
    cls: '' as const,
    onLoss: 'retry' as const,
    said: 'The pier is quiet again, and it is quiet because of you.',
    lost: 'They will give you another go at it.',
  }),
  Object.freeze({
    id: 'market',
    step: 4,
    branch: 'rival' as ChainBranch,
    role: 'rival' as ChainRole,
    kind: 'protection' as JobKind,
    title: 'Hold the market row',
    brief: 'The row opens tonight and the docks know it. Stand on it until morning.',
    choice: 'Hold the row',
    legs: Object.freeze([
      { kind: 'hold' as const, where: 'near' as ChapterWhere, ticks: 45 * 60, label: 'Hold the market row in {where}' },
    ]),
    pay: 1700,
    cls: '' as const,
    onLoss: 'retry' as const,
    said: 'The row is quiet again, and it is quiet because of you.',
    lost: 'They will give you another go at it.',
  }),
  Object.freeze({
    id: 'boat',
    step: 5,
    branch: 'patron' as ChainBranch,
    role: 'patron' as ChainRole,
    kind: 'race' as JobKind,
    title: 'The last boat',
    brief: 'One boat out tonight, and your name on the manifest. It does not wait.',
    choice: 'Make the boat',
    legs: Object.freeze([
      { kind: 'drive' as const, where: 'other' as ChapterWhere, label: 'Collect the last bag in {where}' },
      { kind: 'drive' as const, where: 'near' as ChapterWhere, label: 'Beat the tide to the quay in {where}' },
    ]),
    pay: 2600,
    cls: '' as const,
    onLoss: 'burn' as const,
    said: 'The boat goes out with your name on it. You owe this city nothing.',
    lost: 'The boat left without you, and there is not another.',
  }),
  Object.freeze({
    id: 'exit',
    step: 5,
    branch: 'rival' as ChainBranch,
    role: 'rival' as ChainRole,
    kind: 'pursuit' as JobKind,
    title: 'The quiet exit',
    brief: 'A car, a driver and an hour of quiet. Be at both ends of it.',
    choice: 'Take the exit',
    legs: Object.freeze([
      { kind: 'drive' as const, where: 'other' as ChapterWhere, label: 'Meet the driver in {where}' },
      { kind: 'drive' as const, where: 'near' as ChapterWhere, label: 'Make the handover in {where}' },
    ]),
    pay: 2600,
    cls: '' as const,
    onLoss: 'burn' as const,
    said: 'The handover went quietly. You owe this city nothing.',
    lost: 'The driver went on without you, and there is not another.',
  }),
] as const);

/** The chain of spec section 18, as the record carries it. */
export interface ChainState {
  /** The slot the player is up to. */
  step: number;
  /** The side they threw in with at the fork, or '' before it. */
  branch: ChainBranch;
  /** Chapters lost, which is what the fail state is counted in. */
  lost: number;
  /** How it ended, or '' while it is still being walked. */
  ended: ChainEnd;
}

export function createChainState(): ChainState {
  return { step: 0, branch: '', lost: 0, ended: '' };
}

/** The contact each side of the chain speaks through, or undefined in a world with none. */
export interface ChainSides {
  patron: GiverPlace | undefined;
  rival: GiverPlace | undefined;
}

/**
 * Who the two sides are in a world.
 *
 * The faction each side is written as answers wherever the seed gave it a
 * contact. Where it did not, the side falls back to a corner the seed did give:
 * the patron takes the first contact of the world, and the rival the contact
 * standing furthest from the patron, so the two sides of the chain are two
 * corners of the city rather than one. A world with a single contact runs both
 * sides through them, which is a small city and not a broken chain.
 */
export function chainSides(world: MissionWorld): ChainSides {
  const givers = world.givers;
  const patron = speaksFor(givers, factionIndex(SIDES.patron)) ?? givers[0];
  const rival = speaksFor(givers, factionIndex(SIDES.rival)) ?? furthestFrom(givers, patron);
  return { patron, rival };
}

/** The first contact of a faction, or undefined where the seed gave it no district. */
function speaksFor(givers: readonly GiverPlace[], faction: number): GiverPlace | undefined {
  for (const giver of givers) {
    if (giver.faction === faction) return giver;
  }
  return undefined;
}

/** The contact standing furthest from another, which is the far side of the city. */
function furthestFrom(givers: readonly GiverPlace[], from: GiverPlace | undefined): GiverPlace | undefined {
  if (from === undefined) return givers[0];
  let best = from;
  let bestAway = -1;
  for (const giver of givers) {
    const away = hypot(giver.x - from.x, giver.y - from.y);
    if (away <= bestAway) continue;
    bestAway = away;
    best = giver;
  }
  return best;
}

/** The chapters standing in the slot the player is up to, on the side they are walking. */
export function chaptersNow(chain: ChainState): Chapter[] {
  if (chain.ended !== '') return [];
  return CHAPTERS.filter(
    (chapter) => chapter.step === chain.step && (chain.branch === '' || chapter.branch === '' || chapter.branch === chain.branch),
  );
}

/** A chapter by the name the record carries, or undefined for a name the chain does not hold. */
function chapterOf(id: string): Chapter | undefined {
  return CHAPTERS.find((chapter) => chapter.id === id);
}

/**
 * What the chain has for a contact now: the chapter they are holding, and at
 * the fork one of the two on offer. Every other contact in the city has
 * nothing, and answers with the side work of `job.ts` alone.
 */
export function chainOffers(state: SimState, world: MissionWorld, giver: GiverPlace): JobOffer[] {
  const sides = chainSides(world);
  const offers: JobOffer[] = [];
  for (const chapter of chaptersNow(state.missions.chain)) {
    if (sideOf(sides, chapter.role)?.id !== giver.id) continue;
    const job = chapterJob(state, world, chapter, sides);
    if (job !== undefined) offers.push({ job, label: chapter.choice, note: chapter.brief });
  }
  return offers;
}

function sideOf(sides: ChainSides, role: ChainRole): GiverPlace | undefined {
  return role === 'patron' ? sides.patron : sides.rival;
}

/**
 * A chapter built against the world: its legs put on the corners the seed laid
 * out, its clock read off the ground they cover, and its price the one written
 * for it. It is built fresh every time it is asked for, exactly as an offer of
 * side work is, so nothing of it is kept until the player takes it.
 */
export function chapterJob(
  state: SimState,
  world: MissionWorld,
  chapter: Chapter,
  sides: ChainSides,
): MissionJob | undefined {
  const giver = sideOf(sides, chapter.role);
  const sites = world.sites;
  if (giver === undefined || sites.length === 0) return undefined;
  const other = sideOf(sides, chapter.role === 'patron' ? 'rival' : 'patron') ?? giver;
  // The two sides of the chain fall on one contact only in a world with one, and
  // then the work is aimed at whoever that faction already counts as a rival.
  const against = other.id === giver.id ? rivalOf(giver.faction, 0) : other.faction;
  const rng = rngFor(state.seed, CHAIN_TICK, Subsystem.Missions, CHAPTERS.indexOf(chapter));
  const legs: JobLeg[] = [];
  let at = nearestSite(sites, giver.x, giver.y, 0);
  for (const written of chapter.legs) {
    const site = siteFor(sites, written.where, giver, other, at, rng.int(0, sites.length - 1));
    legs.push({
      kind: written.kind,
      x: site.x,
      y: site.y,
      ticks: written.ticks ?? 0,
      label: written.label.replace('{where}', site.district.name),
    });
    at = site;
  }
  const job: MissionJob = {
    kind: chapter.kind,
    giver: giver.id,
    faction: giver.faction,
    against,
    title: chapter.title,
    legs,
    leg: 0,
    held: 0,
    taken: -1,
    limit: 0,
    pay: chapter.pay,
    cls: chapter.cls,
    block: -1,
    chapter: chapter.id,
  };
  job.limit = limitOf(job, runOf(job, giver));
  return job;
}

/** The corner a written leg lands on. */
function siteFor(
  sites: readonly JobSite[],
  where: ChapterWhere,
  giver: GiverPlace,
  other: GiverPlace,
  at: JobSite,
  draw: number,
): JobSite {
  switch (where) {
    case 'near':
      return nearestSite(sites, giver.x, giver.y, draw % 2);
    case 'other':
      return nearestSite(sites, other.x, other.y, draw % 2);
    case 'far':
      return furtherSite(sites, at, draw);
  }
}

/**
 * A chapter finished: the branch it commits the player to, the step onto the
 * next slot, and the line the HUD shows. It answers '' for a job that is not a
 * chapter, and for one the chain has already walked past, which a save edited
 * by hand is the only way to carry.
 */
export function chainFinished(state: SimState, job: MissionJob): string {
  const chain = state.missions.chain;
  const chapter = chapterOf(job.chapter);
  if (chapter === undefined || chain.ended !== '' || chapter.step !== chain.step) return '';
  if (chapter.branch !== '') chain.branch = chapter.branch;
  chain.step = chapter.step + 1;
  if (chaptersNow(chain).length === 0) chain.ended = 'done';
  return chapter.said;
}

/**
 * A chapter lost: counted, and on the chapter written to burn, the end of the
 * chain. Handing one back is not losing it — the contact is still there and the
 * chapter is still theirs to offer — so it leaves the chain where it was.
 */
export function chainLost(state: SimState, job: MissionJob, gaveUp: boolean): string {
  const chain = state.missions.chain;
  const chapter = chapterOf(job.chapter);
  if (chapter === undefined || chain.ended !== '' || chapter.step !== chain.step) return '';
  if (gaveUp) return 'The offer stands.';
  chain.lost += 1;
  if (chapter.onLoss === 'burn') chain.ended = 'burned';
  return chapter.lost;
}

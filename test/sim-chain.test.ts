import { beforeAll, describe, expect, it } from 'vitest';
import { seedFromString } from '../src/core/rng.ts';
import {
  CHAPTERS,
  chainSides,
  chaptersNow,
  chapterJob,
  createChainState,
  type Chapter,
  type ChainRole,
} from '../src/sim/chain.ts';
import { factionIndex } from '../src/sim/faction.ts';
import { giverPlaces, type GiverPlace } from '../src/sim/giver.ts';
import { jobSites, type JobLeg, type MissionJob, type MissionWorld } from '../src/sim/job.ts';
import { jobOffers, jobRows } from '../src/sim/mission.ts';
import type { Place } from '../src/sim/on-foot.ts';
import { initPhysics, type Ground } from '../src/sim/physics.ts';
import { createSave, saveFromText, saveToText } from '../src/sim/save.ts';
import { createSimState } from '../src/sim/simulation.ts';
import type { Culture, District } from '../src/world/types.ts';
import { stableJson } from './helpers.ts';
import { drive, hills, start, type Session } from './sim-harness.ts';

/**
 * The authored chain of spec section 18: that it is walkable from end to end on
 * several seeds, that its fork is a choice, and that losing the last chapter of
 * it ends it.
 *
 * The ground is the hillside of `sim-harness.ts` and the world is written here,
 * as `sim-missions.test.ts` writes one: a sweep of generated cities would
 * measure the cities. `seed-places.test.ts` is where the chain meets real ones.
 */

/** The seeds the chain is walked on. Each lays its contacts and corners out differently. */
const SEEDS = ['chain-one', 'chain-two', 'chain-three'].map(seedFromString);

function district(id: number, culture: Culture): District {
  return { id, name: `D${id}`, zone: 'inner', x: 900 + id * 800, y: 0, density: 0.4, wealth: 0.5, culture };
}

/** A city holding both sides of the chain: the docks and Chinatown, and three other districts. */
const CITY: readonly District[] = [
  district(0, 'italian'),
  district(1, 'chinese'),
  district(2, 'irish'),
  district(3, 'east-european'),
  district(4, 'none'),
];

/** A city the seed left without the docks, so the patron has to fall back on somebody. */
const NO_DOCKS: readonly District[] = [district(0, 'italian'), district(1, 'chinese'), district(3, 'east-european')];

/** A city of one contact, where both sides of the chain are one corner. */
const ONE_CORNER: readonly District[] = [district(0, 'italian')];

/** A world of flat streets: every point asked for is a road, so nothing is snapped away. */
const STREET = (x: number, y: number): Place => ({ x, y, heading: 0 });

function worldOf(seed: number, districts: readonly District[] = CITY): MissionWorld {
  return { givers: giverPlaces(seed, districts, STREET), sites: jobSites(seed, districts, STREET) };
}

function city(world: MissionWorld): Ground {
  return { ...hills(), missions: world };
}

/** Put the player on foot at a place and let the tick see them there. */
function standAt(session: Session, place: { x: number; y: number }): void {
  session.state.player.driving = false;
  session.state.player.x = place.x;
  session.state.player.y = place.y;
  session.physics.stand(session.state);
  drive(session, 1);
}

/** One press of the interact key, with whatever number key is held with it. */
function press(session: Session, buy = 0): void {
  drive(session, 1, { interact: false, buy });
  drive(session, 1, { interact: true, buy });
}

/** The side of the chain a contact speaks for. */
function giverFor(world: MissionWorld, role: ChainRole): GiverPlace {
  const sides = chainSides(world);
  return (role === 'patron' ? sides.patron : sides.rival) as GiverPlace;
}

/** Walk up to the contact holding a chapter, open the board, and take that chapter off it. */
function takeChapter(session: Session, world: MissionWorld, chapter: Chapter): MissionJob | null {
  const giver = giverFor(world, chapter.role);
  standAt(session, giver);
  press(session);
  const row = jobRows(session.state, world, giver).findIndex((r) => r.label.startsWith(chapter.choice));
  if (row < 0) return null;
  press(session, row + 1);
  return session.state.missions.active;
}

/**
 * Do every leg of a job. A `hold` leg is stood on for two ticks and then handed
 * the rest of its standing: how a stand is counted is `sim-missions.test.ts`'s
 * business, and standing out forty-five minutes of them here would only make
 * this file slow.
 */
function doLegs(session: Session, job: MissionJob): void {
  const state = session.state;
  for (const leg of job.legs as readonly JobLeg[]) {
    if (leg.kind === 'drive') {
      state.player.driving = true;
      session.physics.spawn(state, leg.x, leg.y, 0, job.cls === '' ? state.vehicle.cls : job.cls);
      drive(session, 2);
      continue;
    }
    standAt(session, leg);
    drive(session, 2);
    if (leg.kind !== 'hold') continue;
    const carried = state.missions.active;
    if (carried !== null) carried.held = leg.ticks - 1;
    drive(session, 2);
  }
}

/** Walk the chain to its end, taking the named side at the fork. Answers the chapters walked. */
function walkChain(session: Session, world: MissionWorld, side: ChainRole): string[] {
  const state = session.state;
  const walked: string[] = [];
  for (let i = 0; i < CHAPTERS.length; i++) {
    if (state.missions.chain.ended !== '') break;
    const chapter = chaptersNow(state.missions.chain).find((c) => c.branch === '' || c.branch === side);
    if (chapter === undefined) break;
    const job = takeChapter(session, world, chapter);
    expect(job?.chapter, `${chapter.id} was not on the board`).toBe(chapter.id);
    doLegs(session, job as MissionJob);
    expect(state.missions.active, `${chapter.id} was not finished`).toBeNull();
    walked.push(chapter.id);
  }
  return walked;
}

beforeAll(async () => {
  await initPhysics();
});

describe('the chain as it is written', () => {
  it('runs slot by slot from the first to the last with no gap', () => {
    const steps = CHAPTERS.map((chapter) => chapter.step);
    expect(Math.min(...steps)).toBe(0);
    for (let step = 0; step <= Math.max(...steps); step++) {
      expect(CHAPTERS.filter((chapter) => chapter.step === step).length, `slot ${step}`).toBeGreaterThan(0);
    }
  });

  it('gives every chapter a name, a brief, a choice, a price and legs to walk', () => {
    for (const chapter of CHAPTERS) {
      expect(chapter.title.length, chapter.id).toBeGreaterThan(0);
      expect(chapter.brief.length, chapter.id).toBeGreaterThan(0);
      expect(chapter.choice.length, chapter.id).toBeGreaterThan(0);
      expect(chapter.said.length, chapter.id).toBeGreaterThan(0);
      expect(chapter.lost.length, chapter.id).toBeGreaterThan(0);
      expect(chapter.pay, chapter.id).toBeGreaterThan(0);
      expect(chapter.legs.length, chapter.id).toBeGreaterThan(0);
      for (const leg of chapter.legs) {
        expect(leg.label, chapter.id).toContain('{where}');
        if (leg.kind === 'hold') expect(leg.ticks ?? 0, chapter.id).toBeGreaterThan(0);
      }
    }
    expect(new Set(CHAPTERS.map((chapter) => chapter.id)).size).toBe(CHAPTERS.length);
  });

  it('forks once into two sides, each with work of its own and an end that can be lost', () => {
    const fork = CHAPTERS.filter((chapter) => chapter.branch !== '');
    const slots = fork.map((chapter) => chapter.step);
    expect(Math.min(...slots), 'the fork is walked after a common opening').toBeGreaterThan(0);
    for (const side of ['patron', 'rival'] as ChainRole[]) {
      const mine = fork.filter((chapter) => chapter.branch === side);
      expect(mine.length, side).toBeGreaterThan(1);
      expect(mine.some((chapter) => chapter.role === side), `${side} hands out its own work`).toBe(true);
      expect(mine.filter((chapter) => chapter.onLoss === 'burn').length, `${side} can be lost`).toBe(1);
    }
    // Both sides are offered at once in the slot the fork stands in, which is
    // what makes it a choice rather than a road.
    const at = Math.min(...slots);
    const open = chaptersNow({ ...createChainState(), step: at });
    expect(open.map((chapter) => chapter.branch).sort()).toEqual(['patron', 'rival']);
  });
});

describe('the sides of the chain in a seeded world', () => {
  it('speaks through the contacts of its own factions where the seed gave them corners', () => {
    const world = worldOf(SEEDS[0] as number);
    const sides = chainSides(world);
    expect(sides.patron?.faction).toBe(factionIndex('docklands'));
    expect(sides.rival?.faction).toBe(factionIndex('syndicate'));
  });

  it('falls back on the corners the seed did give when a faction has no district', () => {
    const world = worldOf(SEEDS[0] as number, NO_DOCKS);
    const sides = chainSides(world);
    expect(world.givers.some((giver) => giver.faction === factionIndex('docklands'))).toBe(false);
    expect(sides.patron).toBeDefined();
    expect(sides.rival?.faction).toBe(factionIndex('syndicate'));
    expect(sides.patron?.id).not.toBe(sides.rival?.id);
  });

  it('runs both sides through one corner in a city that has only one', () => {
    const world = worldOf(SEEDS[0] as number, ONE_CORNER);
    const sides = chainSides(world);
    expect(world.givers).toHaveLength(1);
    expect(sides.patron?.id).toBe(sides.rival?.id);
    // The work is still aimed at somebody: a rival of the one faction there is.
    const state = createSimState(SEEDS[0] as number);
    const job = chapterJob(state, world, CHAPTERS[0] as Chapter, sides) as MissionJob;
    expect(job.against).toBeGreaterThanOrEqual(0);
    expect(job.against).not.toBe(job.faction);
  });

  it('builds a chapter the same way twice from one seed, and differently from another', () => {
    const state = createSimState(SEEDS[0] as number);
    const world = worldOf(SEEDS[0] as number);
    const chapter = CHAPTERS[0] as Chapter;
    const built = chapterJob(state, world, chapter, chainSides(world)) as MissionJob;
    expect(stableJson(chapterJob(state, world, chapter, chainSides(world)))).toEqual(stableJson(built));
    const other = createSimState(SEEDS[1] as number);
    const world2 = worldOf(SEEDS[1] as number);
    expect(stableJson(chapterJob(other, world2, chapter, chainSides(world2)))).not.toEqual(stableJson(built));
  });

  it('names the district of every leg it writes, and gives each chapter a clock', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const state = createSimState(seed);
      const sides = chainSides(world);
      for (const chapter of CHAPTERS) {
        const job = chapterJob(state, world, chapter, sides) as MissionJob;
        expect(job, `seed ${seed}: ${chapter.id}`).toBeDefined();
        expect(job.limit, `seed ${seed}: ${chapter.id}`).toBeGreaterThan(0);
        for (const leg of job.legs) {
          expect(leg.label, `seed ${seed}: ${chapter.id}`).not.toContain('{where}');
          expect(leg.label.length, `seed ${seed}: ${chapter.id}`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('walking the chain', () => {
  it('is playable from the first chapter to the last, on either side, on every seed', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      for (const side of ['patron', 'rival'] as ChainRole[]) {
        const session = start(city(world), seed);
        const walked = walkChain(session, world, side);
        const chain = session.state.missions.chain;
        expect(chain.ended, `seed ${seed}, ${side}`).toBe('done');
        expect(chain.branch, `seed ${seed}, ${side}`).toBe(side);
        const owed = CHAPTERS.filter((c) => c.branch === '' || c.branch === side).length;
        expect(walked.length, `seed ${seed}, ${side}`).toBe(owed);
        expect(chain.lost, `seed ${seed}, ${side}`).toBe(0);
        session.physics.dispose();
      }
    }
  });

  it('pays what the chapter is written to pay, and nothing more', () => {
    const world = worldOf(SEEDS[0] as number);
    const session = start(city(world), SEEDS[0] as number);
    const money = session.state.money;
    const first = CHAPTERS[0] as Chapter;
    const job = takeChapter(session, world, first) as MissionJob;
    doLegs(session, job);
    expect(session.state.money - money).toBe(first.pay);
    expect(session.state.objective).toContain(first.said);
    session.physics.dispose();
  });

  it('offers the chapter beside the side work rather than instead of it', () => {
    const world = worldOf(SEEDS[0] as number);
    const state = createSimState(SEEDS[0] as number);
    // A contact talks on the pavement, so the player has to be out of the car.
    state.player.driving = false;
    const giver = giverFor(world, 'patron');
    const offers = jobOffers(state, world, giver);
    expect(offers.length).toBe(2);
    expect(offers[0]?.job.chapter).toBe((CHAPTERS[0] as Chapter).id);
    expect(offers[0]?.note.length).toBeGreaterThan(0);
    expect(offers[1]?.job.chapter).toBe('');
    // The other side has nothing to say until the fork.
    expect(jobOffers(state, world, giverFor(world, 'rival')).every((offer) => offer.job.chapter === '')).toBe(true);
  });

  it('shuts the chain to the side the player turned down at the fork', () => {
    const world = worldOf(SEEDS[0] as number);
    const session = start(city(world), SEEDS[0] as number);
    const state = session.state;
    const fork = CHAPTERS.filter((chapter) => chapter.branch !== '');
    const at = Math.min(...fork.map((chapter) => chapter.step));
    state.missions.chain.step = at;
    const taken = fork.find((chapter) => chapter.branch === 'rival') as Chapter;
    const turned = fork.find((chapter) => chapter.branch === 'patron') as Chapter;
    // Both sides are holding a chapter out at once: that is the fork.
    state.player.driving = false;
    for (const chapter of [taken, turned]) {
      const offers = jobOffers(state, world, giverFor(world, chapter.role));
      expect(offers.some((offer) => offer.job.chapter === chapter.id), chapter.id).toBe(true);
    }
    // Take one, hand it back — which leaves the fork open — and finish the other.
    expect(takeChapter(session, world, turned)?.chapter).toBe(turned.id);
    standAt(session, giverFor(world, turned.role));
    press(session);
    press(session, 1);
    expect(state.missions.active).toBeNull();
    expect(state.missions.chain.branch, 'handing a chapter back leaves the fork open').toBe('');
    const job = takeChapter(session, world, taken) as MissionJob;
    doLegs(session, job);
    expect(state.missions.chain.branch).toBe('rival');
    expect(chaptersNow(state.missions.chain).every((chapter) => chapter.branch !== 'patron')).toBe(true);
    session.physics.dispose();
  });
});

describe('losing a chapter', () => {
  it('leaves an early chapter on offer at the same contact', () => {
    const world = worldOf(SEEDS[0] as number);
    const session = start(city(world), SEEDS[0] as number);
    const state = session.state;
    const first = CHAPTERS[0] as Chapter;
    const job = takeChapter(session, world, first) as MissionJob;
    state.tick = job.taken + job.limit;
    drive(session, 1);
    expect(state.missions.active).toBeNull();
    expect(state.missions.chain.lost).toBe(1);
    expect(state.missions.chain.ended).toBe('');
    expect(state.missions.chain.step).toBe(0);
    expect(state.objective).toContain(first.lost);
    expect(takeChapter(session, world, first)?.chapter).toBe(first.id);
    session.physics.dispose();
  });

  it('ends the chain when the last chapter is lost, and offers nothing after it', () => {
    const world = worldOf(SEEDS[0] as number);
    const session = start(city(world), SEEDS[0] as number);
    const state = session.state;
    const last = CHAPTERS.filter((chapter) => chapter.onLoss === 'burn').find((chapter) => chapter.branch === 'patron') as Chapter;
    state.missions.chain.step = last.step;
    state.missions.chain.branch = 'patron';
    const job = takeChapter(session, world, last) as MissionJob;
    state.tick = job.taken + job.limit;
    drive(session, 1);
    expect(state.missions.chain.ended).toBe('burned');
    expect(state.objective).toContain(last.lost);
    expect(chaptersNow(state.missions.chain)).toHaveLength(0);
    expect(jobOffers(state, world, giverFor(world, 'patron')).every((offer) => offer.job.chapter === '')).toBe(true);
    session.physics.dispose();
  });

  it('does not count handing a chapter back against the player', () => {
    const world = worldOf(SEEDS[0] as number);
    const session = start(city(world), SEEDS[0] as number);
    const state = session.state;
    takeChapter(session, world, CHAPTERS[0] as Chapter);
    standAt(session, giverFor(world, 'patron'));
    press(session);
    press(session, 1);
    expect(state.missions.active).toBeNull();
    expect(state.missions.chain.lost).toBe(0);
    expect(state.missions.chain.step).toBe(0);
    session.physics.dispose();
  });
});

describe('the chain in a save', () => {
  it('carries how far it was walked, which side was taken and the chapter in hand', () => {
    const world = worldOf(SEEDS[0] as number);
    const session = start(city(world), SEEDS[0] as number);
    const state = session.state;
    const job = takeChapter(session, world, CHAPTERS[0] as Chapter) as MissionJob;
    doLegs(session, job);
    takeChapter(session, world, CHAPTERS[1] as Chapter);
    const read = saveFromText(saveToText(createSave('chain-one', state)));
    expect(read.state.missions.chain).toEqual(state.missions.chain);
    expect(read.state.missions.active?.chapter).toBe((CHAPTERS[1] as Chapter).id);
    session.physics.dispose();
  });
});

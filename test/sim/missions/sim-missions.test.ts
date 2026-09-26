import { beforeAll, describe, expect, it } from 'vitest';
import { seedFromString } from '../../../src/core/rng.ts';
import { FACTIONS, factionIndex, HOSTILE, standingOf } from '../../../src/sim/crime/faction.ts';
import { giverPlaces, GIVER_REACH, type GiverPlace } from '../../../src/sim/missions/giver.ts';
import { EMPTY_INPUT, type InputFrame } from '../../../src/sim/input.ts';
import { jobSites, offerFor, type JobKind, type MissionJob, type MissionWorld } from '../../../src/sim/missions/job.ts';
import { HOLD_REACH, JOB_STANDING, LEG_REACH } from '../../../src/sim/missions/mission.ts';
import type { Place } from '../../../src/sim/player/on-foot.ts';
import { initPhysics, type Ground } from '../../../src/sim/physics/physics.ts';
import { createSimState, stepSim, type SimState } from '../../../src/sim/simulation.ts';
import { blockKeyAt, captureBlock } from '../../../src/sim/crime/territory.ts';
import type { Culture, District } from '../../../src/world/types.ts';
import { stableJson } from '../../support/helpers.ts';
import { drive, hills, start, type Session } from '../../support/sim-harness.ts';

const SEED = seedFromString('missions');

/** Four districts well clear of the spawn and of each other, two of them somebody's home. */
function district(id: number, culture: Culture): District {
  return { id, name: `D${id}`, zone: 'inner', x: 900 + id * 800, y: 0, density: 0.4, wealth: 0.5, culture };
}

const DISTRICTS: readonly District[] = [
  district(0, 'italian'),
  district(1, 'chinese'),
  district(2, 'none'),
  district(3, 'east-european'),
];

/** A world of flat streets: every point asked for is a road, so nothing is snapped away. */
const STREET = (x: number, y: number): Place => ({ x, y, heading: 0 });

const GIVERS = giverPlaces(SEED, DISTRICTS, STREET);
const WORLD: MissionWorld = { givers: GIVERS, sites: jobSites(SEED, DISTRICTS, STREET) };

function city(): Ground {
  return { ...hills(), missions: WORLD };
}

/** Put the player on foot at a place and let the tick see them there. */
function standAt(session: Session, place: { x: number; y: number }): void {
  session.state.player.driving = false;
  session.state.player.x = place.x;
  session.state.player.y = place.y;
  session.physics.stand(session.state);
  drive(session, 1);
}

/** One press of the interact key: a tick with it down, off an edge the last tick left clear. */
function press(session: Session, input: Partial<InputFrame> = {}): void {
  drive(session, 1, { ...input, interact: false });
  drive(session, 1, { ...input, interact: true });
}

/** Walk up to a contact, open the board and take what is on it. */
function takeJob(session: Session, giver: GiverPlace): MissionJob | null {
  standAt(session, giver);
  press(session);
  press(session, { buy: 1 });
  return session.state.missions.active;
}

/**
 * Turn a contact's board to the first job of a kind, and answer with the index
 * it stands at. The board is a function of what the player has finished
 * (`job.ts`), so this is how a test asks for a kind of work by name.
 */
function setOffer(state: SimState, giver: GiverPlace, kind: JobKind): number {
  const was = state.missions.done;
  for (let i = 0; i < 80; i++) {
    state.missions.done = i;
    if (offerFor(state, WORLD, giver)?.kind === kind) return i;
  }
  state.missions.done = was;
  return -1;
}

/** A contact of a seeded world, and the district they work. */
const FAMILY = GIVERS.find((giver) => giver.faction === factionIndex('family')) as GiverPlace;

beforeAll(async () => {
  await initPhysics();
});

describe('the contacts of spec section 18', () => {
  it('stands one in each home district of a territorial faction', () => {
    expect(GIVERS).toHaveLength(3);
    expect(GIVERS.map((giver) => FACTIONS[giver.faction]?.id)).toEqual(['family', 'syndicate', 'bratva']);
    expect(GIVERS.map((giver) => giver.district.id)).toEqual([0, 1, 3]);
  });

  it('leaves the districts nobody runs without one', () => {
    expect(GIVERS.some((giver) => giver.district.culture === 'none')).toBe(false);
  });

  it('stands them on their own district, within reach of a street', () => {
    for (const giver of GIVERS) {
      expect(Math.hypot(giver.x - giver.district.x, giver.y - giver.district.y)).toBeLessThan(300);
    }
  });

  it('is the same list twice from one seed, and another list from another', () => {
    expect(stableJson(giverPlaces(SEED, DISTRICTS, STREET))).toEqual(stableJson(GIVERS));
    expect(stableJson(giverPlaces(SEED + 1, DISTRICTS, STREET))).not.toEqual(stableJson(GIVERS));
  });
});

describe('the board', () => {
  it('offers the same job twice and a different one when the board turns over', () => {
    const state = createSimState(SEED);
    const first = offerFor(state, WORLD, FAMILY);
    expect(stableJson(offerFor(state, WORLD, FAMILY))).toEqual(stableJson(first));
    state.missions.done = 1;
    expect(stableJson(offerFor(state, WORLD, FAMILY))).not.toEqual(stableJson(first));
  });

  it('hands out every kind of work the spec lists', () => {
    const state = createSimState(SEED);
    const kinds: JobKind[] = ['delivery', 'theft', 'pursuit', 'protection', 'sabotage', 'race', 'territory'];
    for (const kind of kinds) {
      expect(GIVERS.some((giver) => setOffer(state, giver, kind) >= 0)).toBe(true);
    }
  });

  it('gives every job a name, a clock, a price and somewhere to go', () => {
    const state = createSimState(SEED);
    for (let i = 0; i < 40; i++) {
      state.missions.done = i;
      for (const giver of GIVERS) {
        const job = offerFor(state, WORLD, giver) as MissionJob;
        expect(job.title.length).toBeGreaterThan(0);
        expect(job.pay).toBeGreaterThan(0);
        expect(job.limit).toBeGreaterThan(0);
        expect(job.legs.length).toBeGreaterThan(0);
        for (const leg of job.legs) expect(leg.label.length).toBeGreaterThan(0);
        expect(job.taken).toBe(-1);
      }
    }
  });

  it('has nothing to offer in a world with nowhere to send anybody', () => {
    const state = createSimState(SEED);
    expect(offerFor(state, { givers: GIVERS, sites: [] }, FAMILY)).toBeUndefined();
  });
});

describe('taking a job', () => {
  it('opens the board on the interact key and takes the job on the number key', () => {
    const session = start(city());
    const job = takeJob(session, FAMILY);
    expect(job).not.toBeNull();
    expect(job?.giver).toBe(FAMILY.id);
    expect(job?.taken).toBe(session.state.tick - 2);
    // The press that took the job is followed by the one that leaves the
    // corner, so the board is shut behind the player.
    expect(session.state.missions.visit).toBeNull();
    session.physics.dispose();
  });

  it('will not talk to a player at the wheel, or one the police want', () => {
    const session = start(city());
    standAt(session, FAMILY);
    session.state.heat = 2;
    press(session);
    expect(session.state.missions.visit).toBeNull();
    session.state.heat = 0;
    session.state.player.driving = true;
    press(session);
    expect(session.state.missions.visit).toBeNull();
    session.physics.dispose();
  });

  it('will not talk to a player the faction has crossed off', () => {
    const session = start(city());
    session.state.factions.standing[FAMILY.faction] = HOSTILE - 0.1;
    standAt(session, FAMILY);
    press(session);
    expect(session.state.missions.visit).toBeNull();
    session.physics.dispose();
  });

  it('offers no second job at another contact while one is being carried', () => {
    const session = start(city());
    const job = takeJob(session, FAMILY) as MissionJob;
    const other = GIVERS.find((giver) => giver.id !== FAMILY.id) as GiverPlace;
    takeJob(session, other);
    expect(session.state.missions.active).toBe(job);
    expect(session.state.missions.done + session.state.missions.failed).toBe(0);
    session.physics.dispose();
  });
});

describe('carrying a job', () => {
  it('pays, counts it done and makes a name for the player when every leg is behind them', () => {
    const session = start(city());
    const state = session.state;
    const from = setOffer(state, FAMILY, 'delivery');
    const money = state.money;
    const job = takeJob(session, FAMILY) as MissionJob;
    expect(job.kind).toBe('delivery');
    for (const leg of job.legs) {
      standAt(session, leg);
      drive(session, 2);
    }
    expect(state.missions.active).toBeNull();
    expect(state.money - money).toBe(job.pay);
    expect(state.missions.done).toBe(from + 1);
    expect(standingOf(state, job.faction)).toBeCloseTo(JOB_STANDING, 6);
    session.physics.dispose();
  });

  it('writes the objective the HUD reads, and clears it when the job is over', () => {
    const session = start(city());
    const state = session.state;
    setOffer(state, FAMILY, 'delivery');
    const job = takeJob(session, FAMILY) as MissionJob;
    expect(state.objective).toContain(job.legs[0]?.label);
    for (const leg of job.legs) {
      standAt(session, leg);
      drive(session, 2);
    }
    expect(state.objective).toContain('Paid');
    drive(session, 7 * 60);
    expect(state.objective).toBe('');
    session.physics.dispose();
  });

  it('loses the job when the clock runs out', () => {
    const session = start(city());
    const state = session.state;
    setOffer(state, FAMILY, 'delivery');
    const money = state.money;
    const job = takeJob(session, FAMILY) as MissionJob;
    state.tick = job.taken + job.limit;
    drive(session, 1);
    expect(state.missions.active).toBeNull();
    expect(state.missions.failed).toBe(1);
    expect(state.money).toBe(money);
    expect(standingOf(state, job.faction)).toBeLessThan(0);
    session.physics.dispose();
  });

  it('loses the job when the player is taken in with it', () => {
    const session = start(city());
    const state = session.state;
    takeJob(session, FAMILY);
    state.arrested = true;
    drive(session, 2);
    expect(state.missions.active).toBeNull();
    expect(state.missions.failed).toBe(1);
    session.physics.dispose();
  });

  it('hands the job back on the board of the contact who gave it', () => {
    const session = start(city());
    const state = session.state;
    takeJob(session, FAMILY);
    standAt(session, FAMILY);
    press(session);
    press(session, { buy: 1 });
    expect(state.missions.active).toBeNull();
    expect(state.missions.failed).toBe(1);
    session.physics.dispose();
  });
});

describe('the legs a job is judged by', () => {
  it('takes a drive leg only at the wheel of the class it asks for', () => {
    const session = start(city());
    const state = session.state;
    const place = WORLD.sites[0] as Place;
    state.missions.active = job('theft', [{ kind: 'drive', x: place.x, y: place.y, ticks: 0, label: 'Bring it in' }], 'van');
    session.physics.spawn(state, place.x, place.y, 0, 'saloon');
    drive(session, 2);
    expect(state.missions.active).not.toBeNull();
    session.physics.spawn(state, place.x, place.y, 0, 'van');
    drive(session, 2);
    expect(state.missions.active).toBeNull();
    expect(state.missions.done).toBe(1);
    session.physics.dispose();
  });

  it('counts a hold leg only while the player stands there, and starts again if they leave', () => {
    const session = start(city());
    const state = session.state;
    const place = WORLD.sites[0] as Place;
    const legs = [{ kind: 'hold' as const, x: place.x, y: place.y, ticks: 90, label: 'Stand there' }];
    state.missions.active = job('protection', legs);
    standAt(session, place);
    drive(session, 30);
    expect(state.missions.active?.held).toBeGreaterThan(0);
    standAt(session, { x: place.x + HOLD_REACH * 3, y: place.y });
    drive(session, 2);
    expect(state.missions.active?.held).toBe(0);
    standAt(session, place);
    drive(session, 95);
    expect(state.missions.active).toBeNull();
    session.physics.dispose();
  });

  it('calls the people the player was hired against out to the corner', () => {
    const session = start(city());
    const state = session.state;
    const place = WORLD.sites[0] as Place;
    const legs = [{ kind: 'hold' as const, x: place.x, y: place.y, ticks: 600, label: 'Stand there' }];
    state.missions.active = job('protection', legs);
    standAt(session, place);
    drive(session, 4);
    expect(state.factions.wave?.faction).toBe(state.missions.active?.against);
    session.physics.dispose();
  });

  it('takes a take leg when the block it names is the player’s', () => {
    const session = start(city());
    const state = session.state;
    const place = WORLD.sites[0] as Place;
    const legs = [{ kind: 'take' as const, x: place.x, y: place.y, ticks: 0, label: 'Take it' }];
    const carried = job('territory', legs);
    carried.block = blockKeyAt(place.x, place.y);
    state.missions.active = carried;
    drive(session, 2);
    expect(state.missions.active).not.toBeNull();
    captureBlock(state, carried.block, carried.against);
    drive(session, 2);
    expect(state.missions.active).toBeNull();
    session.physics.dispose();
  });
});

describe('a replayed session', () => {
  it('meets the same contacts and carries the same job', () => {
    const inputs: InputFrame[] = [];
    for (let i = 0; i < 40; i++) inputs.push({ ...EMPTY_INPUT, interact: i % 4 === 2, buy: i % 8 === 6 ? 1 : 0 });
    expect(stableJson(run(inputs).missions)).toEqual(stableJson(run(inputs).missions));
  });
});

/** A session stood at a contact and run over a stream of input. */
function run(inputs: readonly InputFrame[]): SimState {
  const session = start(city());
  standAt(session, FAMILY);
  for (const frame of inputs) stepSim(session.state, frame, session.physics);
  const state = JSON.parse(JSON.stringify(session.state)) as SimState;
  session.physics.dispose();
  return state;
}

/** A job written by hand, for the legs a generated one only sometimes carries. */
function job(kind: JobKind, legs: MissionJob['legs'], cls: MissionJob['cls'] = ''): MissionJob {
  return {
    kind,
    giver: FAMILY.id,
    faction: FAMILY.faction,
    against: factionIndex('syndicate'),
    title: 'A job',
    legs,
    leg: 0,
    held: 0,
    taken: 0,
    limit: 100_000,
    pay: 100,
    cls,
    block: -1,
    chapter: '',
  };
}

/** The reach a leg is judged at, pinned so the panel and the map agree with the rule. */
it('judges a leg from the same reach the map marks it at', () => {
  expect(LEG_REACH).toBeGreaterThan(GIVER_REACH);
  expect(HOLD_REACH).toBeGreaterThan(LEG_REACH);
});

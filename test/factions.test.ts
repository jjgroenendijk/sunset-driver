import { describe, expect, it } from 'vitest';
import {
  FACTIONS,
  FACTION_IDS,
  HOSTILE,
  createFactionState,
  districtFactions,
  factionForCulture,
  factionIndex,
  hostileTo,
  homeDistricts,
  shiftStanding,
  standingOf,
  type FactionId,
} from '../src/sim/faction.ts';
import { TICKS_PER_DAY } from '../src/sim/clock.ts';
import { dealRefusal, type DealerPlace } from '../src/sim/dealer.ts';
import {
  EnforcerGang,
  ENFORCER_HEALTH,
  ENFORCER_RANGE,
  WAVE_UNITS,
  hurtEnforcer,
  type EnforcerUnit,
} from '../src/sim/enforcer.ts';
import { favourOf, sellPrice } from '../src/sim/market.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';
import {
  BLOCK_INCOME,
  BLOCK_SIZE,
  NOBODY,
  PLAYER_HOLD,
  TAKEOVER_TICKS,
  TerritoryMap,
  blockAt,
  blockKey,
  blockKeyAt,
  blockMiddle,
  blockOf,
  captureBlock,
  captured,
  holderColour,
  releaseBlock,
  stepTerritory,
  turfLine,
} from '../src/sim/territory.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import type { Culture, District, WorldDescription } from '../src/world/types.ts';
import { gridRoads, gridTrafficRoads } from './traffic-grid.ts';
import { withNodes } from './helpers.ts';

/**
 * The factions of spec section 17, run headless. The roster is a table, the
 * standing is arithmetic and the turf is a pure function of the seed and the
 * tick, so none of it needs Rapier or a renderer. The city is a made-up grid
 * for the reason `traffic-grid.ts` gives: a generated one would measure the
 * generator.
 */
const SIZE = 3000;
const CELL = 50;

/** A district of the test city: flat ground, and a culture a faction answers to. */
function district(id: number, x: number, y: number, culture: Culture, wealth = 0.5): District {
  return { id, name: `D${id}`, zone: 'inner', x, y, density: 0.5, wealth, culture };
}

/**
 * Two neighbourhoods on dry, flat land: the Family's at the middle and the
 * Syndicate's seven hundred metres east of it. Far enough apart that a block
 * beyond both is nobody's on the first day.
 */
function gridWorld(): WorldDescription {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) hf.set(ix, iy, 20);
  }
  return {
    seed: 7,
    size: SIZE,
    archetype: 'archipelago',
    core: { x: 0, y: 0 },
    terrain: hf.toData(),
    water: {
      seaLevel: 0,
      islands: [{ id: 0, x: 0, y: 0, radius: SIZE / 2, main: true }],
      crossings: [],
      rivers: [],
      harbour: { x: 0, y: 0, radius: 10 },
      industry: 0,
    },
    districts: [district(0, 0, 0, 'italian'), district(1, 700, 0, 'chinese', 0.9)],
    beaches: [],
    airfields: [],
    roads: withNodes(gridRoads()),
    corridors: [],
    tram: { route: [], edges: [], corridors: [], stops: [], crossings: [], length: 0 },
  };
}

const world = gridWorld();
const turf = new TerritoryMap(world);
const FAMILY = factionIndex('family');
const SYNDICATE = factionIndex('syndicate');

/** A player on foot at a place, with the standing a case needs. */
function walker(x: number, y: number, standing: Partial<Record<FactionId, number>> = {}): SimState {
  const state = createSimState(11);
  state.player.driving = false;
  state.player.x = x;
  state.player.y = y;
  for (const id of FACTION_IDS) {
    const amount = standing[id];
    if (amount !== undefined) state.factions.standing[factionIndex(id)] = amount;
  }
  return state;
}

/** Step the turf for a number of ticks, as `stepSim` does before the physics. */
function hold(state: SimState, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    stepTerritory(state, turf);
    state.tick += 1;
  }
}

describe('the roster of spec section 17.1', () => {
  it('is eight factions, one of which holds no ground', () => {
    expect(FACTIONS).toHaveLength(8);
    expect(FACTIONS.filter((f) => !f.territorial).map((f) => f.id)).toEqual(['unit13']);
  });

  it('gives every faction its own id, name and colour', () => {
    expect(new Set(FACTIONS.map((f) => f.id)).size).toBe(FACTIONS.length);
    expect(new Set(FACTIONS.map((f) => f.name)).size).toBe(FACTIONS.length);
    expect(new Set(FACTIONS.map((f) => f.colour)).size).toBe(FACTIONS.length);
  });

  it('gives every territorial faction a home culture no other claims', () => {
    const homes = FACTIONS.filter((f) => f.territorial).map((f) => f.culture);
    expect(new Set(homes).size).toBe(homes.length);
    for (const culture of homes) expect(culture).not.toBe('none');
  });

  it('arms and mounts every faction', () => {
    for (const faction of FACTIONS) {
      expect(faction.arsenal.length).toBeGreaterThan(0);
      expect(faction.vehicles.length).toBeGreaterThan(0);
      expect(faction.offer).not.toBe('');
    }
  });

  it('names rivalries both ways round, or a shift would move only one of them', () => {
    for (const faction of FACTIONS) {
      expect(faction.rivals.length).toBeGreaterThan(0);
      for (const id of faction.rivals) {
        expect(id).not.toBe(faction.id);
        expect(FACTIONS[factionIndex(id)]?.rivals).toContain(faction.id);
      }
    }
  });

  it('reads home turf off the district cultures the world hands out', () => {
    expect(factionForCulture('italian')).toBe(FAMILY);
    expect(factionForCulture('chinese')).toBe(SYNDICATE);
    // Nobody's: the seafront, the unnamed districts, and the police.
    expect(factionForCulture('beach')).toBe(-1);
    expect(factionForCulture('none')).toBe(-1);
    expect(homeDistricts(world.districts, FAMILY).map((d) => d.id)).toEqual([0]);
    expect(homeDistricts(world.districts, factionIndex('unit13'))).toEqual([]);
    expect(districtFactions(world.districts)).toEqual([FAMILY, SYNDICATE]);
  });
});

describe('the reputation of spec section 17.3', () => {
  it('starts every faction at a stranger', () => {
    const state = walker(0, 0);
    expect(state.factions.standing).toHaveLength(FACTIONS.length);
    for (let i = 0; i < FACTIONS.length; i++) expect(standingOf(state, i)).toBe(0);
  });

  it('moves the rivals the other way when one faction is helped', () => {
    const state = walker(0, 0);
    shiftStanding(state, FAMILY, 0.4);
    expect(standingOf(state, FAMILY)).toBeCloseTo(0.4);
    for (const id of (FACTIONS[FAMILY] as { rivals: readonly FactionId[] }).rivals) {
      expect(standingOf(state, factionIndex(id))).toBeCloseTo(-0.2);
    }
  });

  it('holds the standing inside its own range however often it is moved', () => {
    const state = walker(0, 0);
    for (let i = 0; i < 40; i++) shiftStanding(state, FAMILY, 0.5);
    expect(standingOf(state, FAMILY)).toBe(1);
    for (let i = 0; i < 80; i++) shiftStanding(state, FAMILY, -0.5);
    expect(standingOf(state, FAMILY)).toBe(-1);
  });

  it('turns a faction hostile once the standing is low enough', () => {
    const state = walker(0, 0, { family: HOSTILE });
    expect(hostileTo(state, FAMILY)).toBe(true);
    expect(hostileTo(state, SYNDICATE)).toBe(false);
    expect(hostileTo(state, -1)).toBe(false);
  });
});

describe('the reputation in a price (spec sections 16.2, 17.3)', () => {
  const dealer = (culture: Culture): DealerPlace => ({
    district: district(0, 0, 0, culture),
    name: 'Dealer',
    pitches: [{ x: 0, y: 0, heading: 0 }],
  });

  it('pays a friend of the house more than a stranger, and a stranger more than an enemy', () => {
    const friend = walker(0, 0, { family: 1 });
    const stranger = walker(0, 0);
    const enemy = walker(0, 0, { family: -1 });
    const at = dealer('italian');
    expect(favourOf(friend, at)).toBe(1);
    expect(favourOf(stranger, at)).toBe(0);
    expect(sellPrice(friend, at, 0)).toBeGreaterThan(sellPrice(stranger, at, 0));
    expect(sellPrice(stranger, at, 0)).toBeGreaterThan(sellPrice(enemy, at, 0));
  });

  it('leaves a dealer in a district nobody runs with no opinion at all', () => {
    const friend = walker(0, 0, { family: 1 });
    const at = dealer('none');
    expect(favourOf(friend, at)).toBe(0);
    expect(sellPrice(friend, at, 0)).toBe(sellPrice(walker(0, 0), at, 0));
  });

  it('will not deal at all on a street whose faction the player has crossed', () => {
    const enemy = walker(0, 0, { family: -1 });
    expect(dealRefusal(enemy, dealer('italian'))).toContain('The Family');
    expect(dealRefusal(enemy, dealer('none'))).toBeNull();
    // The old refusals still come first: a car and the police both outrank it.
    expect(dealRefusal(walker(0, 0), dealer('italian'))).toBeNull();
  });
});

describe('the turf of spec section 17.2', () => {
  it('files a block under one key and reads the same block back', () => {
    for (const [bx, by] of [[0, 0], [3, -7], [-12, 12]] as const) {
      expect(blockAt(blockKey(bx, by))).toEqual({ bx, by });
    }
    expect(blockOf(BLOCK_SIZE * 2 + 5, -1)).toEqual({ bx: 2, by: -1 });
    expect(blockMiddle(0, 0)).toEqual({ x: BLOCK_SIZE / 2, y: BLOCK_SIZE / 2 });
    expect(blockKeyAt(5, 5)).toBe(blockKey(0, 0));
  });

  it('seeds each faction on its own districts', () => {
    const state = walker(0, 0);
    expect(turf.holderAt(state, 0, 0)).toBe(FAMILY);
    expect(turf.holderAt(state, blockOf(700, 0).bx, 0)).toBe(SYNDICATE);
  });

  it('answers the same for a block however often it is asked', () => {
    const state = walker(0, 0);
    for (let bx = -6; bx <= 6; bx++) {
      expect(turf.holderAt(state, bx, 0)).toBe(turf.holderAt(state, bx, 0));
      expect(turf.baseHolderAt(0, bx, 2)).toBe(turf.baseHolderAt(0, bx, 2));
    }
  });

  it('leaves the ground off the map to nobody', () => {
    const state = walker(0, 0);
    expect(turf.holderAt(state, 500, 500)).toBe(NOBODY);
    expect(turf.districtOf(500, 500)).toBeUndefined();
    expect(blockKey(-9000, 0)).toBe(-1);
  });

  it('spreads the turf over the days (spec section 17.2)', () => {
    const held = (tick: number): number => {
      let count = 0;
      for (let by = -10; by <= 10; by++) {
        for (let bx = -10; bx <= 10; bx++) {
          if (turf.baseHolderAt(tick, bx, by) !== NOBODY) count++;
        }
      }
      return count;
    };
    const day0 = held(0);
    const day6 = held(6 * TICKS_PER_DAY);
    expect(day0).toBeGreaterThan(0);
    expect(day6).toBeGreaterThan(day0);
  });

  it('washes each holder in a colour of its own', () => {
    expect(holderColour(FAMILY)).toBe(FACTIONS[FAMILY]?.colour);
    expect(holderColour(PLAYER_HOLD)).not.toBe(FACTIONS[FAMILY]?.colour);
    expect(holderColour(NOBODY)).toBe('');
  });
});

describe('taking a block (spec section 17.2)', () => {
  /** A player standing in the middle of the Family's own block, at war with them. */
  function takeover(): SimState {
    const middle = blockMiddle(0, 0);
    return walker(middle.x, middle.y, { family: -1 });
  }

  it('does not start on the ground of a faction the player has not crossed', () => {
    const middle = blockMiddle(0, 0);
    const state = walker(middle.x, middle.y);
    hold(state, 10);
    expect(state.factions.takeover).toBeNull();
    expect(state.factions.wave).toBeNull();
  });

  it('starts on hostile ground and calls the faction out at once', () => {
    const state = takeover();
    hold(state, 1);
    expect(state.factions.takeover?.faction).toBe(FAMILY);
    expect(state.factions.wave?.faction).toBe(FAMILY);
    expect(state.factions.wave?.round).toBe(1);
  });

  it('is broken off by getting into a car', () => {
    const state = takeover();
    hold(state, 30);
    expect(state.factions.takeover).not.toBeNull();
    state.player.driving = true;
    hold(state, 1);
    expect(state.factions.takeover).toBeNull();
  });

  it('is broken off by walking off the block: the next one starts from nothing', () => {
    const state = takeover();
    hold(state, 30);
    const first = state.factions.takeover;
    expect(first?.block).toBe(blockKey(0, 0));
    state.player.x += BLOCK_SIZE * 2;
    hold(state, 1);
    // The block next door is the Family's too, so what happens is not that the
    // takeover ends but that it starts again, from the beginning, on the new
    // block. The thirty ticks already stood are not carried over.
    expect(state.factions.takeover?.block).not.toBe(first?.block);
    expect(state.factions.takeover?.started).toBe(state.tick - 1);
  });

  it('is broken off for good by walking onto ground nobody runs', () => {
    const state = takeover();
    hold(state, 30);
    state.player.x = BLOCK_SIZE * 400;
    hold(state, 1);
    expect(state.factions.takeover).toBeNull();
  });

  it('takes the block after standing on it, and the capture calls the retaliation', () => {
    const state = takeover();
    hold(state, TAKEOVER_TICKS + 1);
    const key = blockKey(0, 0);
    expect(captured(state.factions, key)).toBe(true);
    expect(turf.holderAt(state, 0, 0)).toBe(PLAYER_HOLD);
    expect(state.factions.takeover).toBeNull();
    // The wave that comes back for it is the retaliation of spec section 17.2.
    expect(state.factions.wave?.round).toBe(2);
    expect(state.factions.wave?.faction).toBe(FAMILY);
    expect(state.factions.wave?.block).toBe(key);
  });

  it('costs the standing of the faction that lost it and pays their rivals', () => {
    const state = takeover();
    const before = FACTIONS[FAMILY]?.rivals.map((id) => standingOf(state, factionIndex(id))) ?? [];
    captureBlock(state, blockKey(0, 0), FAMILY);
    expect(standingOf(state, FAMILY)).toBeLessThan(-1 + 0.001);
    FACTIONS[FAMILY]?.rivals.forEach((id, i) => {
      expect(standingOf(state, factionIndex(id))).toBeGreaterThan(before[i] as number);
    });
  });

  it('keeps the captured blocks sorted, so one record reads one way', () => {
    const state = walker(0, 0);
    for (const [bx, by] of [[3, 1], [-2, 4], [0, 0]] as const) captureBlock(state, blockKey(bx, by), FAMILY);
    const list = state.factions.captured;
    expect([...list].sort((a, b) => a - b)).toEqual(list);
    expect(captured(state.factions, blockKey(-2, 4))).toBe(true);
    releaseBlock(state, blockKey(-2, 4));
    expect(captured(state.factions, blockKey(-2, 4))).toBe(false);
  });

  it('pays the held ground a day at a time (spec section 17.2)', () => {
    const state = walker(0, 0);
    captureBlock(state, blockKey(0, 0), FAMILY);
    const purse = state.money;
    state.tick = TICKS_PER_DAY;
    stepTerritory(state, turf);
    const day = state.money - purse;
    expect(day).toBeGreaterThanOrEqual(BLOCK_INCOME / 2);
    // And once a day, not once a tick.
    stepTerritory(state, turf);
    expect(state.money - purse).toBe(day);
  });

  it('says whose ground the player is on', () => {
    const middle = blockMiddle(0, 0);
    expect(turfLine(walker(middle.x, middle.y), turf)).toContain('The Family');
    expect(turfLine(walker(middle.x, middle.y, { family: -1 }), turf)).toContain('gone');
    expect(turfLine(walker(BLOCK_SIZE * 400, 0), turf)).toBe('');
    const taken = walker(middle.x, middle.y);
    captureBlock(taken, blockKey(0, 0), FAMILY);
    expect(turfLine(taken, turf)).toBe('Your turf');
  });
});

describe('the enforcers of spec section 17.2', () => {
  const roads = gridTrafficRoads();

  /** A wave out after a player standing in the middle of the grid. */
  function siege(): { state: SimState; gang: EnforcerGang } {
    const state = walker(0, 0, { family: -1 });
    state.factions.wave = { faction: FAMILY, block: blockKey(0, 0), called: 0, until: 100_000, round: 1, sent: 0 };
    return { state, gang: new EnforcerGang(roads, turf) };
  }

  function run(state: SimState, gang: EnforcerGang, ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      gang.step(state);
      state.tick += 1;
    }
  }

  /** Metres from the player to the nearest enforcer, or Infinity while none is out. */
  function nearest(state: SimState): number {
    let best = Infinity;
    for (const unit of state.enforcers.units) best = Math.min(best, Math.hypot(unit.x - state.player.x, unit.y - state.player.y));
    return best;
  }

  it('sends nobody while no wave is out', () => {
    const state = walker(0, 0);
    const gang = new EnforcerGang(roads, turf);
    run(state, gang, 600);
    expect(state.enforcers.units).toHaveLength(0);
  });

  it('puts a wave on the street, armed off its own faction', () => {
    const { state, gang } = siege();
    run(state, gang, 600);
    expect(state.enforcers.units.length).toBeGreaterThan(0);
    for (const unit of state.enforcers.units) {
      expect(unit.faction).toBe(FAMILY);
      expect(FACTIONS[FAMILY]?.arsenal).toContain(unit.weapon);
    }
  });

  it('walks them at the player and shoots once they are close', () => {
    const { state, gang } = siege();
    run(state, gang, 60);
    const far = nearest(state);
    // They come in a couple of blocks out and walk, so the street takes a while.
    run(state, gang, 3600);
    expect(nearest(state)).toBeLessThan(far);
    expect(nearest(state)).toBeLessThanOrEqual(ENFORCER_RANGE);
    expect(state.player.health).toBeLessThan(100);
  });

  it('sends one more each round, so standing your ground gets harder', () => {
    const { state, gang } = siege();
    run(state, gang, 900);
    const first = state.enforcers.units.length;
    state.factions.wave = { faction: FAMILY, block: blockKey(0, 0), called: state.tick, until: state.tick + 100_000, round: 3, sent: 0 };
    run(state, gang, 900);
    expect(state.enforcers.units.length).toBeGreaterThan(first);
  });

  it('gives up once the player has left the quarter, and takes them off the map', () => {
    const { state, gang } = siege();
    run(state, gang, 900);
    expect(state.enforcers.units.length).toBeGreaterThan(0);
    state.player.x = 10_000;
    state.player.y = 10_000;
    run(state, gang, 2);
    expect(state.factions.wave).toBeNull();
    expect(state.enforcers.units).toHaveLength(0);
  });

  it('is a record and nothing else, so a session replays the same siege', () => {
    const one = siege();
    const two = siege();
    run(one.state, one.gang, 700);
    run(two.state, two.gang, 700);
    const poses = (state: SimState): string =>
      state.enforcers.units.map((u: EnforcerUnit) => `${u.id}:${u.weapon}:${u.x.toFixed(3)}:${u.y.toFixed(3)}`).join('|');
    expect(poses(one.state)).toBe(poses(two.state));
    expect(one.state.player.health).toBe(two.state.player.health);
  });

  it('is over once the whole wave has been put down', () => {
    const { state, gang } = siege();
    run(state, gang, 900);
    expect(state.factions.wave?.sent).toBe(WAVE_UNITS);
    for (const unit of [...state.enforcers.units]) {
      expect(hurtEnforcer(state, unit.id, ENFORCER_HEALTH)).toBe(true);
    }
    // What they carried is left where they fell, which is how a player arms
    // themselves off a wave (spec section 11.6).
    expect(state.pickups).toHaveLength(WAVE_UNITS);
    run(state, gang, 1);
    expect(state.factions.wave).toBeNull();
    expect(state.enforcers.units).toHaveLength(0);
  });

  it('sends nobody in place of one who was shot: a wave is a fixed number of people', () => {
    const { state, gang } = siege();
    run(state, gang, 300);
    const first = state.enforcers.units[0] as EnforcerUnit;
    hurtEnforcer(state, first.id, ENFORCER_HEALTH);
    run(state, gang, 900);
    expect(state.factions.wave?.sent).toBe(WAVE_UNITS);
    expect(state.enforcers.units).toHaveLength(WAVE_UNITS - 1);
  });

  it('leaves a player in a car alone: they are already driving away', () => {
    const { state, gang } = siege();
    state.player.driving = true;
    run(state, gang, 900);
    expect(state.player.health).toBe(100);
  });
});

describe('the record of spec section 16.4', () => {
  it('carries a row of standing for every faction', () => {
    expect(createFactionState().standing).toHaveLength(FACTIONS.length);
    expect(createFactionState().captured).toEqual([]);
    expect(createFactionState().takeover).toBeNull();
  });
});

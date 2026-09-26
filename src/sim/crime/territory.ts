/**
 * Who holds which block of the city, and how the player takes one (spec
 * section 17.2).
 *
 * The map is cut into square blocks of {@link BLOCK_SIZE} metres. Whose block
 * one is is a pure function of `(seed, tick, block)`, the way a contraband
 * price is (`contraband.ts`): a faction's ground is seeded from every district
 * of its own culture and reaches further out each day, so the turf spreads over
 * a session without a map of it being kept, stepped or saved. What the record
 * carries is the blocks the player has taken, which is the one thing the
 * function cannot answer.
 *
 * A boundary would be a circle if the reach alone decided it, so each block
 * carries a little of its own: the ragged edge is a jitter keyed on the block
 * and the faction, drawn once and never again, so the shape of a border holds
 * still while the reach behind it grows.
 *
 * Taking a block is standing on it. A player on foot inside a block held by a
 * faction they have crossed is taking it, the faction sends enforcers
 * (`enforcer.ts`), and the block is theirs if they are still there
 * {@link TAKEOVER_TICKS} later. The capture calls the next wave, which is the
 * retaliation the spec asks for.
 *
 * Pure: it reads the world description and the record, and takes no
 * wall-clock and no unseeded randomness.
 */
import { hypot } from '../../core/libm.ts';
import { genRng, Subsystem } from '../../core/rng.ts';
import { districtAt, layoutZones, zoneAt, type ZoneLayout } from '../../world/terrain/districts.ts';
import type { District, WorldDescription } from '../../world/types.ts';
import { TICKS_PER_DAY } from '../clock.ts';
import {
  FACTIONS,
  hostileTo,
  shiftStanding,
  type Faction,
  type FactionState,
} from './faction.ts';
import type { SimState } from '../simulation.ts';

/** Metres each way of one block of turf: about a city block of the inner ring. */
export const BLOCK_SIZE = 120;

/** Blocks each way of the origin a key may carry. A 6 km world is 25 blocks each way. */
const BLOCK_ORIGIN = 512;
const BLOCK_SPAN = BLOCK_ORIGIN * 2;

/** The holder of a block that nobody runs. */
export const NOBODY = -1;

/** The holder of a block the player has taken (spec section 17.2). */
export const PLAYER_HOLD = FACTIONS.length;

/** Metres a faction reaches out of each of its own districts on the first day. */
const HOME_REACH = 320;

/** Metres further it reaches each game day, and the furthest it ever reaches. */
const SPREAD_PER_DAY = 55;
const MAX_REACH = 900;

/** How far a block's own jitter may stretch or shorten that reach, as a share of it. */
const RAGGED = 0.35;

/** Ticks a player stands on a block before it is theirs. */
export const TAKEOVER_TICKS = 40 * 60;

/** How far a capture moves the loser's standing. The rivals gain half of it (`faction.ts`). */
const CAPTURE_STANDING = 0.25;

/** Dollars a block pays its holder each game day, before the district's wealth is counted. */
export const BLOCK_INCOME = 140;

/** The block a world point stands in. */
export function blockOf(x: number, y: number): { bx: number; by: number } {
  return { bx: Math.floor(x / BLOCK_SIZE), by: Math.floor(y / BLOCK_SIZE) };
}

/** The one number a block is filed under. Undefined for a block off the world entirely. */
export function blockKey(bx: number, by: number): number {
  const cx = bx + BLOCK_ORIGIN;
  const cy = by + BLOCK_ORIGIN;
  if (cx < 0 || cx >= BLOCK_SPAN || cy < 0 || cy >= BLOCK_SPAN) return -1;
  return cy * BLOCK_SPAN + cx;
}

/** The block a key stands for. The inverse of {@link blockKey}. */
export function blockAt(key: number): { bx: number; by: number } {
  return { bx: (key % BLOCK_SPAN) - BLOCK_ORIGIN, by: Math.floor(key / BLOCK_SPAN) - BLOCK_ORIGIN };
}

/** The middle of a block, in world metres. */
export function blockMiddle(bx: number, by: number): { x: number; y: number } {
  return { x: (bx + 0.5) * BLOCK_SIZE, y: (by + 0.5) * BLOCK_SIZE };
}

/** The key of the block a world point stands in, or -1 off the world. */
export function blockKeyAt(x: number, y: number): number {
  const at = blockOf(x, y);
  return blockKey(at.bx, at.by);
}

/** True where the player has taken this block. The list is sorted, so this is a binary search. */
export function captured(factions: FactionState, key: number): boolean {
  const list = factions.captured;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const here = list[mid] as number;
    if (here === key) return true;
    if (here < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * The turf of one world: which blocks can be held at all, and which district
 * each of them answers to.
 *
 * It is built once for a session and holds no state of the fight — that is all
 * on the record — so a save is loaded and the same map reads it. The buildable
 * test is the one thing that cannot be a function of the block alone: a block
 * out at sea or up in the backwoods is nobody's, and only the heightfield and
 * the zone rings know which those are.
 */
export class TerritoryMap {
  readonly seed: number;
  /** Blocks each way of the world, and the block index the grid starts at. */
  readonly cols: number;
  readonly minBx: number;
  readonly minBy: number;
  private readonly layout: ZoneLayout;
  private readonly districts: readonly District[];
  /** The district each block answers to, or -1 where no faction may hold it. */
  private readonly owner: Int32Array;
  /** The nearest home district of each faction, per block, as metres. Built on demand. */
  private readonly homes: { x: number; y: number }[][];

  constructor(world: WorldDescription) {
    this.seed = world.seed;
    this.layout = layoutZones(world.size, world.core, world.water);
    this.districts = world.districts;
    const half = world.size / 2;
    this.minBx = Math.floor(-half / BLOCK_SIZE);
    this.minBy = this.minBx;
    this.cols = Math.ceil(world.size / BLOCK_SIZE) + 1;
    this.owner = new Int32Array(this.cols * this.cols).fill(-1);
    this.homes = FACTIONS.map((faction) =>
      faction.territorial ? world.districts.filter((d) => d.culture === faction.culture).map((d) => ({ x: d.x, y: d.y })) : [],
    );
    this.fill(world);
  }

  /**
   * The district a block answers to, or -1 where the block is sea, backwoods or
   * off the map. A block that no faction may hold is the same answer, because
   * the two are the same question: nobody runs ground nobody lives on.
   */
  districtOf(bx: number, by: number): District | undefined {
    const at = this.index(bx, by);
    if (at < 0) return undefined;
    const id = this.owner[at] as number;
    return id < 0 ? undefined : this.districts.find((d) => d.id === id);
  }

  /**
   * Who runs a block on a tick: the player where they have taken it, a faction
   * where one reaches it, and {@link NOBODY} otherwise.
   */
  holderAt(state: SimState, bx: number, by: number): number {
    const key = blockKey(bx, by);
    if (key >= 0 && captured(state.factions, key)) return PLAYER_HOLD;
    return this.baseHolderAt(state.tick, bx, by);
  }

  /**
   * Who a block belongs to before anybody takes it: the faction whose reach
   * covers it by the widest margin. It is a pure function of the seed, the tick
   * and the block, which is why no map of it is kept or saved.
   */
  baseHolderAt(tick: number, bx: number, by: number): number {
    const at = this.index(bx, by);
    if (at < 0 || (this.owner[at] as number) < 0) return NOBODY;
    const middle = blockMiddle(bx, by);
    const reach = reachOn(tick);
    let best = NOBODY;
    let bestScore = 1;
    for (let f = 0; f < FACTIONS.length; f++) {
      const sites = this.homes[f] as { x: number; y: number }[];
      if (sites.length === 0) continue;
      let near = Infinity;
      for (const site of sites) near = Math.min(near, hypot(site.x - middle.x, site.y - middle.y));
      const score = near / (reach * raggedness(this.seed, bx, by, f));
      if (score >= bestScore) continue;
      bestScore = score;
      best = f;
    }
    return best;
  }

  /** The block grid index of a block, or -1 for one off the world. */
  private index(bx: number, by: number): number {
    const cx = bx - this.minBx;
    const cy = by - this.minBy;
    if (cx < 0 || cx >= this.cols || cy < 0 || cy >= this.cols) return -1;
    return cy * this.cols + cx;
  }

  /**
   * Say which blocks are city at all. A block is, when its middle stands on dry
   * land inside the map and its zone is one people live in; the wilderness and
   * the water are nobody's.
   */
  private fill(world: WorldDescription): void {
    for (let cy = 0; cy < this.cols; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const middle = blockMiddle(cx + this.minBx, cy + this.minBy);
        const id = this.cityAt(world, middle.x, middle.y);
        if (id !== undefined) this.owner[cy * this.cols + cx] = id;
      }
    }
  }

  /**
   * The district a block's middle at (x, y) lies in, or undefined when it is
   * off the map, under the sea or in the wilderness.
   */
  private cityAt(world: WorldDescription, x: number, y: number): number | undefined {
    const hf = world.terrain;
    const half = world.size / 2;
    if (Math.abs(x) > half || Math.abs(y) > half) return undefined;
    const ix = Math.round((x - hf.originX) / hf.cellSize);
    const iy = Math.round((y - hf.originY) / hf.cellSize);
    if (ix < 0 || ix >= hf.gridSize || iy < 0 || iy >= hf.gridSize) return undefined;
    if ((hf.heights[iy * hf.gridSize + ix] as number) < world.water.seaLevel) return undefined;
    if (zoneAt(this.layout, x, y) === 'wilderness') return undefined;
    const district = districtAt(this.districts, this.layout, x, y);
    if (district.zone === 'wilderness') return undefined;
    return district.id;
  }
}

/** Metres a faction reaches out of its own districts on a tick, widening by the day. */
function reachOn(tick: number): number {
  const day = Math.max(0, Math.floor(tick / TICKS_PER_DAY));
  return Math.min(MAX_REACH, HOME_REACH + SPREAD_PER_DAY * day);
}

/**
 * How much of its reach a faction has over one block, 1 on average. It is drawn
 * once per block and faction and never again, so a border keeps its shape as
 * the reach behind it grows.
 */
function raggedness(seed: number, bx: number, by: number, faction: number): number {
  const key = blockKey(bx, by);
  if (key < 0) return 1;
  return 1 + genRng(seed, Subsystem.Factions, key * FACTIONS.length + faction).range(-RAGGED, RAGGED);
}

/** What the HUD says about the ground under the player, or '' on nobody's. */
export function turfLine(state: SimState, map: TerritoryMap): string {
  const at = blockOf(state.player.x, state.player.y);
  const holder = map.holderAt(state, at.bx, at.by);
  if (holder === PLAYER_HOLD) return 'Your turf';
  const faction = FACTIONS[holder];
  if (faction === undefined) return '';
  const take = state.factions.takeover;
  if (take === null || take.block !== blockKey(at.bx, at.by)) {
    return `${faction.name} turf${hostileTo(state, holder) ? ' · they want you gone' : ''}`;
  }
  const left = Math.max(0, TAKEOVER_TICKS - (state.tick - take.started));
  return `Taking ${faction.name} turf · ${Math.ceil(left / 60)}s`;
}

/**
 * One tick of the turf (spec section 17.2), run from `stepSim` after the deals
 * and before the physics.
 *
 * It pays what the held ground earns, carries a takeover a tick further, and
 * hands the capture on to the retaliation. Nothing here moves the player, so it
 * tells the physics nothing.
 */
export function stepTerritory(state: SimState, map: TerritoryMap): void {
  payIncome(state, map);
  const f = state.factions;
  const p = state.player;
  const at = blockOf(p.x, p.y);
  const key = blockKey(at.bx, at.by);
  // A takeover is ground held in person: not from a seat, not from inside a
  // shop, a safehouse or a deal, and not by somebody already down.
  const standing = !p.driving && state.shop === null && state.property.visit === null && state.market.deal === null && p.health > 0;
  const holder = key < 0 ? NOBODY : map.holderAt(state, at.bx, at.by);
  if (f.takeover !== null && (f.takeover.block !== key || !standing)) f.takeover = null;
  // A block is taken off a faction that has crossed the player off, or off one
  // somebody else is paying to have it taken off: a territory job of spec
  // section 18 is what makes the block it names takeable at all.
  const takeable = hostileTo(state, holder) || hired(state, key);
  if (f.takeover === null && standing && holder >= 0 && holder < FACTIONS.length && takeable) {
    f.takeover = { block: key, faction: holder, started: state.tick };
    callWave(state, holder, key, 1);
  }
  const take = f.takeover;
  if (take !== null && state.tick - take.started >= TAKEOVER_TICKS) {
    captureBlock(state, take.block, take.faction);
    f.takeover = null;
  }
  if (f.wave !== null && state.tick >= f.wave.until) f.wave = null;
}

/**
 * True where the player is being paid to take this block (spec section 18). The
 * field is read rather than the missions imported, because `mission.ts` reads
 * this file and two files may not read each other.
 */
function hired(state: SimState, key: number): boolean {
  const job = state.missions.active;
  return job !== null && job.block === key;
}

/** Ticks a wave keeps coming before the faction gives the block up for now. */
const WAVE_TICKS = 50 * 60;

/** Call a faction out to a block. The wave already running is left to finish. */
export function callWave(state: SimState, faction: number, block: number, round: number): void {
  const f = state.factions;
  if (f.wave !== null && f.wave.round >= round) return;
  f.wave = { faction, block, called: state.tick, until: state.tick + WAVE_TICKS, round, sent: 0 };
}

/**
 * Take a block off a faction: the player holds it from now on, the loser's
 * standing falls and their rivals' rises, and the faction comes back for it,
 * which is the retaliation of spec section 17.2.
 */
export function captureBlock(state: SimState, block: number, faction: number): void {
  const f = state.factions;
  if (block < 0 || captured(f, block)) return;
  const at = lowerBound(f.captured, block);
  f.captured.splice(at, 0, block);
  shiftStanding(state, faction, -CAPTURE_STANDING);
  callWave(state, faction, block, 2);
}

/** Give a block back. Used by a test and by a wave that takes one back. */
export function releaseBlock(state: SimState, block: number): void {
  const list = state.factions.captured;
  const at = lowerBound(list, block);
  if (list[at] === block) list.splice(at, 1);
}

/** The place a value belongs at in a sorted list. */
function lowerBound(list: readonly number[], value: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Pay what the held ground earns (spec section 17.2). A day's takings land in
 * one payment on the day's turn, so a session that never holds a block never
 * pays for the walk over the list.
 */
function payIncome(state: SimState, map: TerritoryMap): void {
  const f = state.factions;
  if (state.tick - f.paidTick < TICKS_PER_DAY) return;
  f.paidTick = state.tick;
  let earned = 0;
  for (const key of f.captured) {
    const at = blockAt(key);
    const district = map.districtOf(at.bx, at.by);
    earned += BLOCK_INCOME * (0.5 + (district?.wealth ?? 0.5));
  }
  state.money += Math.round(earned);
}

/** The colour a holder's ground is washed in, for the map overlay of spec section 12. */
export function holderColour(holder: number): string {
  if (holder === PLAYER_HOLD) return '#f6d6c1';
  return (FACTIONS[holder] as Faction | undefined)?.colour ?? '';
}

import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_INPUT } from '../src/sim/input.ts';
import { initPhysics, SimPhysics, type Ground } from '../src/sim/physics.ts';
import { createSimState, stepSim } from '../src/sim/simulation.ts';
import { deckSurfaceAt, PARAPET_HEIGHT, roadDecks, type DeckSpan } from '../src/world/decks.ts';
import type { PierPost } from '../src/world/pier-posts.ts';
import { footprintHalfWidth } from '../src/world/tiers.ts';
import type { RoadCurve, WorldDescription } from '../src/world/types.ts';
import { DRY } from './helpers.ts';

/** Metres each way of the chasm the test bridge spans. */
const CHASM = 30;

/** A road straight along x, with the middle two segments on a deck. */
function bridgedRoad(): RoadCurve {
  return {
    id: 0,
    tier: 'street',
    points: [
      { x: -60, y: 0 },
      { x: -CHASM, y: 0 },
      { x: CHASM, y: 0 },
      { x: 60, y: 0 },
    ],
    bridges: [1],
    tunnels: [],
    interchanges: [],
    nodes: [],
  };
}

/** One road on level ground, as much of a world as the decks read. */
function worldOf(road: RoadCurve, height: number): WorldDescription {
  const gridSize = 5;
  return {
    terrain: {
      gridSize,
      cellSize: 100,
      originX: -200,
      originY: -200,
      heights: new Float32Array(gridSize * gridSize).fill(height),
    },
    roads: [road],
  } as unknown as WorldDescription;
}

/** Ground with a chasm in the middle of it, and a deck laid over the chasm. */
function chasm(decks: readonly DeckSpan[] | undefined): Ground {
  return {
    heightAt: (x) => (Math.abs(x) < CHASM ? -40 : 0),
    surfaceAt: () => 'asphalt',
    seaLevel: DRY,
    ...(decks === undefined ? {} : { decks }),
  };
}

/**
 * A causeway: ground at deck level along the road, and a drop each side of it.
 * The deck stands on the same level, so only its parapet is between the car and
 * the drop.
 */
function causeway(decks: readonly DeckSpan[]): Ground {
  return {
    heightAt: (_x, y) => (Math.abs(y) <= footprintHalfWidth('street') ? 0 : -40),
    surfaceAt: () => 'asphalt',
    seaLevel: DRY,
    decks,
  };
}

/** The deck the test drives over: level, as wide as a street, across the chasm. */
function deckAcross(): DeckSpan[] {
  const road = bridgedRoad();
  const halfWidth = footprintHalfWidth(road.tier);
  return [
    {
      curve: 0,
      tier: 'street',
      halfWidth,
      points: [
        { x: -CHASM, y: 0, height: 0, bank: 0, acrossX: 0, acrossY: 1 },
        { x: CHASM, y: 0, height: 0, bank: 0, acrossX: 0, acrossY: 1 },
      ],
      minX: -CHASM - halfWidth,
      minY: -halfWidth,
      maxX: CHASM + halfWidth,
      maxY: halfWidth,
    },
  ];
}

describe('the deck of a world', () => {
  it('is one span per stretch of bridge, at the bed height and the road width', () => {
    const road = bridgedRoad();
    // A terrain of one flat cell is all the bed needs: the deck is the road's
    // own line, not the ground under it.
    const decks = roadDecks(worldOf(road, 7));
    expect(decks).toHaveLength(1);
    const deck = decks[0] as DeckSpan;
    expect(deck.curve).toBe(0);
    expect(deck.halfWidth).toBeCloseTo(footprintHalfWidth('street'), 6);
    // The span runs from the start of segment 1 to its end, and no further.
    expect(deck.points.map((p) => p.x)).toEqual([-CHASM, CHASM]);
    for (const point of deck.points) {
      expect(point.height).toBeCloseTo(7, 6);
      // The road runs along x, so across it is along y.
      expect(Math.abs(point.acrossX)).toBeCloseTo(0, 6);
      expect(Math.abs(point.acrossY)).toBeCloseTo(1, 6);
    }
    expect(deck.minX).toBeCloseTo(-CHASM - deck.halfWidth, 6);
    expect(deck.maxY).toBeCloseTo(deck.halfWidth, 6);
  });

  it('gives a bridge over nothing no span', () => {
    expect(roadDecks(worldOf({ ...bridgedRoad(), bridges: [] }, 0))).toHaveLength(0);
  });
});

describe('a vehicle put down on a bridge', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('reads the deck surface where one covers the place, and nothing off it', () => {
    const decks = deckAcross();
    expect(deckSurfaceAt(decks, 0, 0)).toBeCloseTo(0, 6);
    expect(deckSurfaceAt(decks, 0, footprintHalfWidth('street') + 1)).toBeUndefined();
    expect(deckSurfaceAt(decks, CHASM + 20, 0)).toBeUndefined();
  });

  it('rests on the deck, not in the chasm under it', () => {
    const state = createSimState(1);
    const physics = new SimPhysics(chasm(deckAcross()), state);
    physics.spawn(state, 0, 0, 0);
    // Put down over the middle of the chasm, 40 m over its floor.
    expect(state.vehicle.y).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) stepSim(state, EMPTY_INPUT, physics);
    expect(state.vehicle.y).toBeGreaterThan(-1);
  });
});

describe('a car driving onto a bridge', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  /** Drive east from before the chasm and answer how low the car ever fell. */
  function cross(ground: Ground): { lowest: number; x: number } {
    const state = createSimState(1);
    const physics = new SimPhysics(ground, state);
    physics.spawn(state, -50, 0, 0);
    let lowest = Infinity;
    for (let i = 0; i < 60; i++) stepSim(state, EMPTY_INPUT, physics);
    for (let i = 0; i < 400; i++) {
      stepSim(state, { ...EMPTY_INPUT, throttle: 1 }, physics);
      lowest = Math.min(lowest, state.vehicle.y);
    }
    return { lowest, x: state.player.x };
  }

  it('stays on the deck rather than falling into what it spans', () => {
    const driven = cross(chasm(deckAcross()));
    expect(driven.x).toBeGreaterThan(CHASM);
    expect(driven.lowest).toBeGreaterThan(-1);
  });

  it('falls in where no deck is given, which is what the fault was', () => {
    expect(cross(chasm(undefined)).lowest).toBeLessThan(-5);
  });

  it('is held on the bridge by the parapet', () => {
    const state = createSimState(1);
    const physics = new SimPhysics(causeway(deckAcross()), state);
    // Straight off the side of the deck: the parapet is all that stands there.
    physics.spawn(state, 0, 0, Math.PI / 2);
    for (let i = 0; i < 60; i++) stepSim(state, EMPTY_INPUT, physics);
    for (let i = 0; i < 300; i++) stepSim(state, { ...EMPTY_INPUT, throttle: 0.4 }, physics);
    expect(state.vehicle.y).toBeGreaterThan(-1);
  });
});

/** One pier standing on flat ground, across the road a car drives east along. */
const PIER: PierPost = { x: 20, y: 0, half: 1, angle: 0, base: -0.6, top: 5 };

/** Flat ground with the piers of a deck standing on it, and no deck overhead to meet. */
function underDeck(piers: readonly PierPost[]): Ground {
  return { heightAt: () => 0, surfaceAt: () => 'asphalt', seaLevel: DRY, piers };
}

describe('a car driven into a pier', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  /** Drive east from well before the pier and answer how far east the car ever got. */
  function into(ground: Ground): number {
    const state = createSimState(1);
    const physics = new SimPhysics(ground, state);
    physics.spawn(state, -50, 0, 0);
    let furthest = -Infinity;
    for (let i = 0; i < 60; i++) stepSim(state, EMPTY_INPUT, physics);
    for (let i = 0; i < 400; i++) {
      stepSim(state, { ...EMPTY_INPUT, throttle: 1 }, physics);
      furthest = Math.max(furthest, state.vehicle.x);
    }
    return furthest;
  }

  it('stops at it', () => {
    // The nose of the car reaches the pier before its middle does, so it is
    // stopped a car's half-length short of the foot.
    expect(into(underDeck([PIER]))).toBeLessThan(PIER.x - PIER.half);
  });

  it('drives through the place where no pier is given, which is what the fault was', () => {
    expect(into(underDeck([]))).toBeGreaterThan(PIER.x + PIER.half);
  });
});

import { describe, expect, it } from 'vitest';
import { DECK_SOFFIT } from '../src/world/decks.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { Point } from '../src/world/types.ts';
import { WATER_CLEARANCE, waterRaises, type WetLine } from '../src/world/water-lift.ts';

/** Metres between the points of the test line. */
const STEP = 30;
/** The height of the shore each side of the strait, and of the seabed under it. */
const SHORE = 1;
const SEABED = -6;
/** Where the strait is: the points from here on are over the water. */
const STRAIT = { from: 4, to: 5 };

/**
 * A straight line along x with a strait in the middle of it: ten points a
 * {@link STEP} apart, the one segment between points 4 and 5 over water and
 * listed as a deck.
 */
function line(over: Partial<WetLine> = {}): WetLine {
  const points: Point[] = [];
  for (let i = 0; i < 10; i++) points.push({ x: i * STEP, y: 0 });
  return { tier: 'arterial', points, bridges: [STRAIT.from], tunnels: [], interchanges: [], ...over };
}

/** The ground under the test line: the shore, with the seabed under the strait. */
function ground(x: number): number {
  return x > STRAIT.from * STEP && x < STRAIT.to * STEP ? SEABED : SHORE;
}

/** True where a span crosses the strait. */
function wet(a: Point, b: Point): boolean {
  return a.x >= STRAIT.from * STEP && b.x <= STRAIT.to * STEP;
}

function raisesOf(over: Partial<WetLine> = {}, onNetwork?: (p: Point) => boolean): ReturnType<typeof waterRaises> {
  return waterRaises(line(over), (x) => ground(x), 0, wet, [], onNetwork);
}

/**
 * The lift of spec sections 6.1 and 7.2: a deck over water stands clear of the
 * sea, and ramps back onto the ground each side at the grade of its tier.
 */
describe('the lift a deck over water takes', () => {
  it('raises the deck until its underside clears the sea', () => {
    const raises = raisesOf();
    expect(raises).toHaveLength(1);
    const raise = raises[0] as (typeof raises)[number];
    // The shore stands at SHORE, so the lift is what carries the underside of
    // the deck from there up to the clearance over the sea.
    expect(raise.height).toBeCloseTo(WATER_CLEARANCE + DECK_SOFFIT - SHORE, 6);
    expect(raise.low).toBeCloseTo(STRAIT.from * STEP, 6);
    expect(raise.high).toBeCloseTo(STRAIT.to * STEP, 6);
  });

  it('ramps down to the ground no harder than the tier climbs', () => {
    const raise = raisesOf()[0] as { from: number; low: number; high: number; to: number; height: number };
    const limit = TIERS.arterial.maxGrade;
    // A ramp ends on a point the line already has, so it is never steeper than
    // the grade asks for and can only be longer.
    expect(raise.height / (raise.low - raise.from)).toBeLessThanOrEqual(limit);
    expect(raise.height / (raise.to - raise.high)).toBeLessThanOrEqual(limit);
    for (const at of [raise.from, raise.to]) expect(at % STEP).toBeCloseTo(0, 6);
  });

  it('leaves a deck that already stands clear of the sea alone', () => {
    expect(waterRaises(line(), () => WATER_CLEARANCE + DECK_SOFFIT, 0, wet)).toHaveLength(0);
  });

  it('leaves a deck over dry land alone', () => {
    expect(waterRaises(line(), (x) => ground(x), 0, () => false)).toHaveLength(0);
  });

  it('gives no lift to a deck at the end of its line, which has nowhere to ramp', () => {
    // The last segment of the line is the deck, so there is no line past it to
    // come down on.
    const points: Point[] = [{ x: 0, y: 0 }, { x: STEP, y: 0 }, { x: 2 * STEP, y: 0 }];
    const end: WetLine = { tier: 'arterial', points, bridges: [1], tunnels: [], interchanges: [] };
    expect(waterRaises(end, () => SHORE, 0, () => true)).toHaveLength(0);
  });

  it('stops the ramp at a bore, which is cut into the ground and cannot be raised', () => {
    // A bore two points back from the deck leaves one step of ramp, so the
    // lift is what that step climbs rather than the full clearance.
    const raise = raisesOf({ tunnels: [STRAIT.from - 2] })[0] as { height: number };
    expect(raise.height).toBeCloseTo(STEP * TIERS.arterial.maxGrade, 6);
  });

  it('stops the ramp at an interchange, which is a junction at the height of the ground', () => {
    const raise = raisesOf({ interchanges: [STRAIT.from - 1] })[0] as { height: number };
    expect(raise.height).toBeCloseTo(STEP * TIERS.arterial.maxGrade, 6);
  });

  it('stops the ramp at a point the network already has a junction on', () => {
    const node = (p: Point): boolean => p.x === (STRAIT.to + 1) * STEP;
    const raise = raisesOf({}, node)[0] as { height: number };
    expect(raise.height).toBeCloseTo(STEP * TIERS.arterial.maxGrade, 6);
  });

  it('gives no lift where a junction stands at both abutments', () => {
    const node = (p: Point): boolean => p.x === STRAIT.from * STEP || p.x === STRAIT.to * STEP;
    expect(raisesOf({}, node)).toHaveLength(0);
  });
});

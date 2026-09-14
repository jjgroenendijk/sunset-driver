/**
 * What each road tier is (spec section 6.2): how wide it is, how many lanes it
 * carries, how fast traffic may go on it, and who is allowed on it.
 *
 * This is the one table those numbers live in. The road graph (spec section
 * 6.5) copies them onto its edges, so traffic, police, navigation and the
 * minimap all read the same figures.
 */
import type { RoadTier } from './types.ts';

/** Metres per second from kilometres per hour, so the table reads in signposted numbers. */
function kmh(v: number): number {
  return v / 3.6;
}

/** Who a tier lets on. Cars are allowed on every tier, so they are not listed. */
export interface TierTraffic {
  trucks: boolean;
  buses: boolean;
  trams: boolean;
  pedestrians: boolean;
}

export interface TierSpec {
  /** Carriageway width in metres, kerb to kerb. Verge and pavement are not in it. */
  width: number;
  /**
   * Metres of verge each side of the carriageway: the kerb, the gutter and the
   * strip of ground between the kerb and the pavement.
   */
  verge: number;
  /** Metres of pavement each side. A tier with no pavement is walked on its own surface. */
  pavement: number;
  /**
   * Lanes in each direction. An alley and a dirt road have a single lane that
   * both directions share.
   */
  lanes: number;
  /** Speed limit in metres per second. */
  speedLimit: number;
  /**
   * Steepest grade the tier accepts, as rise over run. A road that would climb
   * harder than this is rerouted along the contour, bridged or tunnelled; it is
   * never laid over the hill (spec section 6.1). The through-routes hold the
   * gentle grades a fast road needs; the tiers below them take the bank, the
   * way the streets of a hillside city do.
   */
  maxGrade: number;
  traffic: TierTraffic;
  /**
   * Ambient vehicles per kilometre of lane in each direction, in a district as
   * busy as the core (spec sections 6.2, 13.1). `src/sim/traffic.ts` thins it
   * by the district a road runs through.
   */
  density: number;
}

export const TIERS: Record<RoadTier, TierSpec> = {
  // Multi-lane and fast, junctions only at interchanges, no pedestrians.
  highway: {
    width: 26,
    verge: 4,
    pavement: 0,
    lanes: 3,
    speedLimit: kmh(110),
    maxGrade: 0.06,
    traffic: { trucks: true, buses: true, trams: false, pedestrians: false },
    density: 14,
  },
  // The main urban through-routes: buses, the tram lane, dense traffic.
  arterial: {
    width: 18,
    verge: 1,
    pavement: 3,
    lanes: 2,
    speedLimit: kmh(60),
    maxGrade: 0.08,
    traffic: { trucks: true, buses: true, trams: true, pedestrians: true },
    density: 20,
  },
  // Residential and commercial, one lane each way with parking on both sides.
  street: {
    width: 11,
    verge: 0.5,
    pavement: 2.5,
    lanes: 1,
    speedLimit: kmh(40),
    maxGrade: 0.18,
    traffic: { trucks: false, buses: false, trams: false, pedestrians: true },
    density: 12,
  },
  // Narrow and unmarked: bins, loading bays, shortcuts.
  alley: {
    width: 4,
    verge: 0,
    pavement: 0,
    lanes: 1,
    speedLimit: kmh(20),
    maxGrade: 0.22,
    traffic: { trucks: false, buses: false, trams: false, pedestrians: true },
    density: 5,
  },
  // Unpaved, in the outskirts and the wilderness. Farm and site traffic uses it.
  dirt: {
    width: 5,
    verge: 1,
    pavement: 0,
    lanes: 1,
    speedLimit: kmh(40),
    maxGrade: 0.2,
    traffic: { trucks: true, buses: false, trams: false, pedestrians: true },
    density: 3,
  },
};

/**
 * How far the ground a road claims reaches each side of its centreline:
 * carriageway, verge and pavement (spec section 6.4).
 */
export function footprintHalfWidth(tier: RoadTier): number {
  const spec = TIERS[tier];
  return spec.width / 2 + spec.verge + spec.pavement;
}

/**
 * True when a road of one tier may join another where the two meet. Spec
 * section 6.2: a highway has junctions only at interchanges and no pedestrians,
 * so only a highway or an arterial ramp joins one, and only there. Every other
 * tier takes a junction anywhere along it.
 *
 * A minor road that meets a highway therefore does not meet it at all: it runs
 * past, and where the two cross the road graph makes it an overpass. The
 * tracer asks this before it ends a road on another one, and `connect.ts`
 * before it turns a crossing into a junction.
 */
export function mayJoin(joiner: RoadTier, met: RoadTier, interchange: boolean): boolean {
  if (met !== 'highway') return true;
  return interchange && (joiner === 'highway' || joiner === 'arterial');
}

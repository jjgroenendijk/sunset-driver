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
   * Lanes in each direction. An alley and a dirt road have a single lane that
   * both directions share.
   */
  lanes: number;
  /** Speed limit in metres per second. */
  speedLimit: number;
  traffic: TierTraffic;
}

export const TIERS: Record<RoadTier, TierSpec> = {
  // Multi-lane and fast, junctions only at interchanges, no pedestrians.
  highway: {
    width: 26,
    lanes: 3,
    speedLimit: kmh(110),
    traffic: { trucks: true, buses: true, trams: false, pedestrians: false },
  },
  // The main urban through-routes: buses, the tram lane, dense traffic.
  arterial: {
    width: 18,
    lanes: 2,
    speedLimit: kmh(60),
    traffic: { trucks: true, buses: true, trams: true, pedestrians: true },
  },
  // Residential and commercial, one lane each way with parking on both sides.
  street: {
    width: 11,
    lanes: 1,
    speedLimit: kmh(40),
    traffic: { trucks: false, buses: false, trams: false, pedestrians: true },
  },
  // Narrow and unmarked: bins, loading bays, shortcuts.
  alley: {
    width: 4,
    lanes: 1,
    speedLimit: kmh(20),
    traffic: { trucks: false, buses: false, trams: false, pedestrians: true },
  },
  // Unpaved, in the outskirts and the wilderness. Farm and site traffic uses it.
  dirt: {
    width: 5,
    lanes: 1,
    speedLimit: kmh(40),
    traffic: { trucks: true, buses: false, trams: false, pedestrians: true },
  },
};

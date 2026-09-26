/**
 * What the ground around a point is like, read off the world description
 * (spec section 15).
 *
 * `ambience.ts` decides what a place sounds like from three numbers; this is
 * where those numbers come from. The zone and the district of spec section 8
 * say how built up and how green it is, and the beaches of spec section 7.3
 * say how near the sea is. Nothing here makes a sound and nothing here touches
 * Tone.js, so it runs headless with the rest of the pure half.
 *
 * A sample is not free — the nearest waterline is a walk over every beach point
 * of the map — and the answer barely changes between two frames, so a sample is
 * kept until the listener has walked {@link RESAMPLE} metres from where it was
 * taken. The beds crossfade over about a second either way, so nothing is heard
 * to step.
 */
import { clamp, smoothstep } from '../core/math.ts';
import { districtAt, layoutZones, zoneAt, type ZoneLayout } from '../world/terrain/districts.ts';
import type { WorldDescription, Zone } from '../world/types.ts';
import { NOWHERE, type Site, type SiteSource } from './ambience.ts';

/** How built up each zone is before its district's own density is read into it. */
const BUILT_BY_ZONE: Readonly<Record<Zone, number>> = Object.freeze({
  core: 1,
  inner: 0.8,
  industrial: 0.62,
  suburban: 0.42,
  outskirts: 0.2,
  wilderness: 0.02,
});

/** How much green each zone carries: gardens, verges, parks and the country beyond. */
const GREEN_BY_ZONE: Readonly<Record<Zone, number>> = Object.freeze({
  core: 0.05,
  inner: 0.14,
  industrial: 0.08,
  suburban: 0.45,
  outskirts: 0.75,
  wilderness: 1,
});

/** Metres from the waterline within which the surf is at its full strength. */
export const SURF_NEAR = 35;

/** Metres from the waterline beyond which the surf is not heard at all. */
export const SURF_FAR = 280;

/** Metres the listener may walk before the site under them is looked up again. */
const RESAMPLE = 6;

/** How built up a place is, from its zone and how dense the district there is. */
export function builtOf(zone: Zone, density: number): number {
  return clamp(BUILT_BY_ZONE[zone] * (0.55 + 0.45 * clamp(density, 0, 1)), 0, 1);
}

/** How green a place is. A dense district has less of it, whatever its zone. */
export function greenOf(zone: Zone, density: number): number {
  return clamp(GREEN_BY_ZONE[zone] * (1 - 0.5 * clamp(density, 0, 1)), 0, 1);
}

/** What the sea is worth at a distance from the waterline, 0 to 1. */
export function shoreNearness(metres: number): number {
  return 1 - smoothstep(SURF_NEAR, SURF_FAR, metres);
}

/**
 * The sites of one world. Built with the session and handed to the audio, which
 * asks it where the player is standing once a frame.
 */
export class WorldSites implements SiteSource {
  private readonly zones: ZoneLayout;
  /** Every beach's waterline as one flat run of x, y pairs, so a sample is one loop. */
  private readonly shore: Float64Array;
  /** The last answer, and where it was taken, so standing still costs nothing. */
  private site: Site = NOWHERE;
  private atX = Number.NaN;
  private atY = Number.NaN;
  private readonly world: WorldDescription;

  constructor(world: WorldDescription) {
    this.world = world;
    this.zones = layoutZones(world.size, world.core, world.water);
    let points = 0;
    for (const beach of world.beaches) points += beach.shore.length;
    this.shore = new Float64Array(points * 2);
    let i = 0;
    for (const beach of world.beaches) {
      for (const point of beach.shore) {
        this.shore[i++] = point.x;
        this.shore[i++] = point.y;
      }
    }
  }

  /** What the ground is like at a point, from the cache where the last one still stands. */
  siteAt(x: number, y: number): Site {
    if (Math.hypot(x - this.atX, y - this.atY) < RESAMPLE) return this.site;
    this.atX = x;
    this.atY = y;
    const zone = zoneAt(this.zones, x, y);
    const density = districtAt(this.world.districts, this.zones, x, y).density;
    this.site = {
      built: builtOf(zone, density),
      green: greenOf(zone, density),
      shore: shoreNearness(this.toShore(x, y)),
    };
    return this.site;
  }

  /** Metres to the nearest waterline, or infinity on a map with no beach. */
  private toShore(x: number, y: number): number {
    let best = Infinity;
    for (let i = 0; i < this.shore.length; i += 2) {
      const dx = (this.shore[i] ?? 0) - x;
      const dy = (this.shore[i + 1] ?? 0) - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
  }
}

/**
 * How full each zone's pavements are through the day (spec sections 13.4,
 * 20.1): districts fill and empty by the time of day, and the nightlife keeps
 * the centre busy after dark.
 *
 * The crowd is placed once from the seed, so the hour decides who is drawn
 * rather than who exists, as the weather does (`outInThis` in `weather.ts`).
 * A share is read between the hours of its table, so the street fills and
 * empties smoothly rather than on the hour.
 */
import type { Zone } from '../../world/types.ts';
import { TICKS_PER_DAY } from '../clock.ts';

/** The share of a zone's crowd out at each hour, from midnight. */
const HOURS: Record<Zone, readonly number[]> = {
  // The centre: offices by day, bars by night, never empty.
  core: [0.5, 0.4, 0.3, 0.2, 0.15, 0.15, 0.3, 0.7, 1, 0.9, 0.8, 0.85, 1, 0.95, 0.85, 0.85, 0.9, 1, 1, 0.9, 0.8, 0.75, 0.7, 0.6],
  // Shops and nightlife: slow mornings, late evenings.
  inner: [0.45, 0.35, 0.25, 0.15, 0.1, 0.1, 0.2, 0.45, 0.7, 0.75, 0.8, 0.85, 0.95, 0.95, 0.9, 0.9, 0.95, 1, 1, 0.95, 0.85, 0.75, 0.65, 0.55],
  // The works: shifts from early morning, and empty at night.
  industrial: [0.1, 0.05, 0.05, 0.05, 0.1, 0.4, 0.9, 1, 0.9, 0.8, 0.8, 0.8, 0.9, 0.8, 0.8, 0.85, 1, 0.7, 0.4, 0.2, 0.15, 0.1, 0.1, 0.1],
  // Homes: the school run, dog walks, a quiet night.
  suburban: [0.1, 0.05, 0.05, 0.05, 0.05, 0.1, 0.35, 0.8, 1, 0.6, 0.55, 0.6, 0.65, 0.6, 0.65, 0.9, 1, 0.95, 0.85, 0.75, 0.55, 0.35, 0.2, 0.15],
  outskirts: [0.05, 0.05, 0.05, 0.05, 0.1, 0.25, 0.6, 0.85, 0.9, 0.9, 0.9, 0.9, 1, 0.9, 0.9, 0.9, 0.9, 0.85, 0.7, 0.5, 0.3, 0.15, 0.1, 0.05],
  // Hikers by day, nobody at night.
  wilderness: [0, 0, 0, 0, 0, 0.05, 0.3, 0.6, 0.8, 0.9, 1, 1, 1, 1, 1, 1, 0.9, 0.8, 0.6, 0.3, 0.1, 0.05, 0, 0],
};

/** The share of a zone's crowd that is out at a tick, 0 to 1. */
export function crowdAtHour(zone: Zone, tick: number): number {
  const table = HOURS[zone];
  const inDay = ((tick % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  const hours = (inDay / TICKS_PER_DAY) * 24;
  const hour = Math.floor(hours);
  const f = hours - hour;
  const a = table[hour] as number;
  const b = table[(hour + 1) % 24] as number;
  return a + (b - a) * f;
}

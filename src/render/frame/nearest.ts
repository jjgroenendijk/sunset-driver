/**
 * The few things nearest the player, out of everything the chunks in reach
 * hold.
 *
 * A light is paid for by every fragment it can reach, so the street lamps of
 * `lamps.ts` and the neon of `signs.ts` each keep a small fixed pool of lights
 * and hand it to whatever the player has come nearest to. Both need the same
 * pick, and both walk a list that is thousands long to make it, which is why it
 * is written once and written carefully: the walk is over everything in reach
 * and the sort is over the size of the pool.
 */

/**
 * The `cap` items nearest a place, nearest first, out of a list of lists.
 *
 * Kept by insertion into a list that is never longer than the cap, so nothing
 * larger than the cap is ever sorted and an item further off than the cap's last
 * is rejected on one comparison. `span` answers the squared distance from the
 * place, which saves a square root per item and orders exactly the same.
 */
export function nearestOf<T>(
  x: number,
  y: number,
  tiles: readonly (readonly T[])[],
  cap: number,
  span: (item: T, x: number, y: number) => number,
): T[] {
  const best: T[] = [];
  const spans: number[] = [];
  for (const tile of tiles) {
    for (const item of tile) {
      const away = span(item, x, y);
      if (best.length === cap && away >= (spans[best.length - 1] as number)) continue;
      let at = best.length;
      while (at > 0 && (spans[at - 1] as number) > away) at--;
      best.splice(at, 0, item);
      spans.splice(at, 0, away);
      if (best.length > cap) {
        best.pop();
        spans.pop();
      }
    }
  }
  return best;
}

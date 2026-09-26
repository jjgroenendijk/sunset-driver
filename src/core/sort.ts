/**
 * Stable, deterministic ordering helpers. Simulation code must never depend on
 * insertion order of Sets, Maps or object keys; it sorts by a stable key instead.
 */

export function compareNumbers(a: number, b: number): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The bare `sort()` order of two strings, by UTF-16 code unit, with no locale. */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Sort a copy of a Map's entries by key so iteration order is stable. */
export function sortedEntries<K extends number | string, V>(map: ReadonlyMap<K, V>): [K, V][] {
  const out: [K, V][] = [];
  map.forEach((v, k) => out.push([k, v]));
  out.sort((x, y) => (typeof x[0] === 'number' ? compareNumbers(x[0], y[0] as number) : compareStrings(x[0], y[0] as string)));
  return out;
}

/** Sort a copy of a Set's members so iteration order is stable. */
export function sortedMembers<T extends number | string>(set: ReadonlySet<T>): T[] {
  const out: T[] = [];
  set.forEach((v) => out.push(v));
  out.sort((x, y) => (typeof x === 'number' ? compareNumbers(x, y as number) : compareStrings(x, y as string)));
  return out;
}

/** Sort object keys so iteration order is stable. */
export function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort(compareStrings);
}

// One of every violation the lint reports, so the rules stay covered.
export function iterateSet(s: Set<number>): number[] {
  const out: number[] = [];
  for (const v of s) out.push(v);
  return out;
}

export function spreadMapKeys(m: Map<string, number>): string[] {
  return [...m.keys()];
}

export function objectKeys(o: Record<string, number>): string[] {
  return Object.keys(o);
}

export function forInKeys(o: Record<string, number>): number {
  let n = 0;
  for (const k in o) n += o[k] ?? 0;
  return n;
}

export function random(): number {
  return Math.random();
}

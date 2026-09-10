import { hashInts } from '../src/core/hash';

/** Fixed list of seeds for the sweeps; deterministic and spread across the space. */
export function sweepSeeds(count: number): number[] {
  const seeds: number[] = [];
  for (let i = 0; i < count; i++) seeds.push(hashInts(0x5eed, i));
  return seeds;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)) {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = o[k];
      return out;
    }
    if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
    return v;
  });
}

import { describe, expect, it } from 'vitest';
import { MONEY_CODE_FUNDS, readSeedCode } from '../src/core/seed.ts';
import { createSimState, START_MONEY } from '../src/sim/simulation.ts';

describe('seed codes', () => {
  it('turns the money code into a random seed and a billion', () => {
    expect(readSeedCode('money', () => 'abc123')).toEqual({ seed: 'abc123', money: 1_000_000_000 });
    expect(readSeedCode(' Money ', () => 'xyz').seed).toBe('xyz');
  });
  it('leaves any other seed alone', () => {
    expect(readSeedCode('sunset')).toEqual({ seed: 'sunset' });
    expect(readSeedCode('moneys')).toEqual({ seed: 'moneys' });
  });
  it('starts the session with the money the code set', () => {
    expect(createSimState(1).money).toBe(START_MONEY);
    expect(createSimState(1, undefined, undefined, MONEY_CODE_FUNDS).money).toBe(MONEY_CODE_FUNDS);
  });
});

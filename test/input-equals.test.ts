/**
 * `inputEquals` (`src/sim/input.ts`): a change to any one field of a frame must
 * make the two frames differ. The comparison once named its fields by hand and
 * fell behind the frame, so the test walks every field of `EMPTY_INPUT` rather
 * than the list the comparison walks.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_INPUT, INPUT_FIELDS, type InputFrame, inputEquals } from '../src/sim/input.ts';

const fields = Object.keys(EMPTY_INPUT) as (keyof InputFrame)[];

describe('inputEquals', () => {
  it('holds two equal frames equal', () => {
    expect(inputEquals({ ...EMPTY_INPUT }, { ...EMPTY_INPUT })).toBe(true);
  });

  it('compares every field the frame holds', () => {
    expect([...INPUT_FIELDS].sort()).toEqual([...fields].sort());
  });

  for (const field of fields) {
    it(`sees a change to ${field}`, () => {
      const changed: InputFrame = { ...EMPTY_INPUT };
      const was = changed[field];
      (changed[field] as number | boolean) = typeof was === 'boolean' ? !was : was + 1;
      expect(inputEquals(EMPTY_INPUT, changed)).toBe(false);
      expect(inputEquals(changed, EMPTY_INPUT)).toBe(false);
    });
  }
});

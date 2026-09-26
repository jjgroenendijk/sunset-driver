import { describe, expect, it } from 'vitest';
import { keyParts, nextIndex } from '../../../src/ui/menus/menu-nav.ts';

describe('nextIndex', () => {
  it('steps and wraps at both ends', () => {
    expect(nextIndex(0, 1, 3)).toBe(1);
    expect(nextIndex(2, 1, 3)).toBe(0);
    expect(nextIndex(0, -1, 3)).toBe(2);
  });

  it('starts at the end the key points away from when nothing is focused', () => {
    expect(nextIndex(-1, 1, 4)).toBe(0);
    expect(nextIndex(-1, -1, 4)).toBe(3);
  });

  it('has nothing to move to in an empty list', () => {
    expect(nextIndex(0, 1, 0)).toBe(-1);
  });
});

describe('keyParts', () => {
  it('draws keys as caps and joining words as text', () => {
    expect(keyParts('W A S D or arrows')).toEqual([
      { text: 'W', cap: true },
      { text: 'A', cap: true },
      { text: 'S', cap: true },
      { text: 'D', cap: true },
      { text: 'or', cap: false },
      { text: 'arrows', cap: true },
    ]);
    expect(keyParts('Shift')).toEqual([{ text: 'Shift', cap: true }]);
  });

  it('draws a mouse button as one cap', () => {
    expect(keyParts('Left click or F')).toEqual([
      { text: 'Left click', cap: true },
      { text: 'or', cap: false },
      { text: 'F', cap: true },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { basePixelRatioFor } from '../src/render/renderer.ts';

describe('the pixel ratio a page is drawn at (issue #714)', () => {
  it('draws a dense screen at one pixel per CSS pixel', () => {
    expect(basePixelRatioFor(2)).toBe(1);
    expect(basePixelRatioFor(3)).toBe(1);
  });

  it('keeps a zoomed-out page at the ratio the browser gives it', () => {
    expect(basePixelRatioFor(0.8)).toBeCloseTo(0.8, 12);
  });
});

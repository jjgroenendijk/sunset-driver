import { describe, expect, it } from 'vitest';
import { basePixelRatioFor, PIXEL_BUDGET } from '../src/render/renderer.ts';

describe('the pixel ratio a page is drawn at (issue #639)', () => {
  it('draws a screen of one pixel per CSS pixel at its own size, however large', () => {
    expect(basePixelRatioFor(1, 1600, 900)).toBe(1);
    expect(basePixelRatioFor(1, 3840, 2160)).toBe(1);
  });

  it('keeps a zoomed-out page at the ratio the browser gives it', () => {
    expect(basePixelRatioFor(0.8, 1600, 900)).toBe(0.8);
  });

  it('draws a Retina window of laptop size near the pixel budget, not at twice its size', () => {
    const ratio = basePixelRatioFor(2, 1600, 900);
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(1.3);
    expect(1600 * 900 * ratio * ratio).toBeCloseTo(PIXEL_BUDGET, -2);
  });

  it('never draws a dense screen under one pixel per CSS pixel', () => {
    expect(basePixelRatioFor(2, 2560, 1440)).toBe(1);
  });

  it('draws a small window at the full density of its screen, and never past 2', () => {
    expect(basePixelRatioFor(2, 800, 600)).toBe(2);
    expect(basePixelRatioFor(3, 390, 844)).toBe(2);
  });
});

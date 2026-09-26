import { describe, expect, it } from 'vitest';
import { judgeFrame, measureFrame, type FrameMetrics } from '../../scripts/render-check.ts';

/**
 * The frames the renderer must not draw, built by hand. The check itself needs
 * a browser and most of a minute, so what it would say about a blank frame is
 * settled here instead, where it costs nothing.
 */
const WIDTH = 64;
const HEIGHT = 36;

/** A frame of one colour, which is what an empty scene clears to. */
function flat(r: number, g: number, b: number): Uint8Array {
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return rgb;
}

/** Sky and nothing else: a smooth gradient down the frame, no outline in it. */
function gradient(): Uint8Array {
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    const t = y / HEIGHT;
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 3;
      rgb[i] = Math.round(90 + 130 * t);
      rgb[i + 1] = Math.round(140 + 90 * t);
      rgb[i + 2] = Math.round(210 + 40 * t);
    }
  }
  return rgb;
}

/** Something drawn: blocks with hard edges between them, as a city has. */
function blocks(): Uint8Array {
  const rgb = gradient();
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (((x >> 2) + (y >> 2)) % 2 === 1) continue;
      const i = (y * WIDTH + x) * 3;
      rgb[i] = 30 + ((x * 7) % 90);
      rgb[i + 1] = 40 + ((y * 5) % 70);
      rgb[i + 2] = 50;
    }
  }
  return rgb;
}

const metricsOf = (rgb: Uint8Array): FrameMetrics => measureFrame(rgb, WIDTH, HEIGHT);

describe('measureFrame', () => {
  it('reads one colour out of a frame of one colour', () => {
    const metrics = metricsOf(flat(140, 140, 140));
    expect(metrics.colours).toBe(1);
    expect(metrics.flattest).toBe(1);
    expect(metrics.edges).toBe(0);
    expect(metrics.brightness).toBe(140);
  });

  it('counts an edge only where the pair really differs', () => {
    expect(metricsOf(gradient()).edges).toBe(0);
    expect(metricsOf(blocks()).edges).toBeGreaterThan(0.1);
  });

  it('never counts the end of one row against the start of the next', () => {
    // Every row is the same, so the only pairs that could differ are the ones
    // that wrap. A count over zero here would be that wrap.
    const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) rgb[(y * WIDTH + x) * 3] = x < WIDTH - 1 ? 0 : 255;
    }
    expect(metricsOf(rgb).edges).toBeCloseTo(1 / (WIDTH - 1), 6);
  });

  it('reports a frame one pixel wide as having no edges, not as NaN', () => {
    // NaN is under every limit and over none, so it would pass the check.
    expect(measureFrame(new Uint8Array(3), 1, 1).edges).toBe(0);
  });

  it('refuses a buffer too short for the frame it was given', () => {
    expect(() => measureFrame(new Uint8Array(12), WIDTH, HEIGHT)).toThrow(/short of a 64x36 frame/);
  });
});

describe('judgeFrame', () => {
  it('fails a blank frame', () => {
    expect(judgeFrame(metricsOf(flat(0, 0, 0)))).not.toHaveLength(0);
  });

  it('fails a frame of one flat colour that is not black', () => {
    expect(judgeFrame(metricsOf(flat(120, 90, 60)))).not.toHaveLength(0);
  });

  it('fails a frame that is sky and nothing else', () => {
    // The gradient holds colours enough to pass a count of them. It is the
    // edges that say the world was never drawn.
    const metrics = metricsOf(gradient());
    expect(metrics.flattest).toBeLessThan(0.9);
    expect(judgeFrame(metrics).join(' ')).toMatch(/outline/);
  });

  it('passes a frame with something drawn in it', () => {
    expect(judgeFrame(metricsOf(blocks()))).toEqual([]);
  });
});

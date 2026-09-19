import { describe, expect, it } from 'vitest';
import {
  choiceOf,
  DEFAULT_GRAPHICS,
  nearestTier,
  presetOf,
  readGraphics,
  RESOLUTIONS,
  tierOf,
} from '../src/render/graphics.ts';
import { FRAME_BUDGET_MS, FULL_TIER, QUALITY_TIERS, type QualityTier } from '../src/render/quality.ts';
import { QualityMonitor, WINDOW_MS, type QualityChange } from '../src/render/quality-monitor.ts';

/** A 60 Hz display that makes every refresh. */
const REFRESH = 1000 / 60;

/** Feed the monitor frames of one length for a number of windows, and keep what it answered. */
function run(monitor: QualityMonitor, frameMs: number, windows: number): QualityChange[] {
  const changes: QualityChange[] = [];
  const frames = windows * Math.ceil(WINDOW_MS / frameMs - 0.01);
  for (let i = 0; i < frames; i++) {
    const change = monitor.sample(frameMs);
    if (change !== undefined) changes.push(change);
  }
  return changes;
}

/** A monitor past the windows a session throws away when it starts. */
function started(at = 0): QualityMonitor {
  const monitor = new QualityMonitor(FRAME_BUDGET_MS, at);
  run(monitor, REFRESH, 4);
  return monitor;
}

describe('the frame-time monitor', () => {
  it('holds the tier while the frame is kept, on a 60 Hz display too', () => {
    const monitor = new QualityMonitor(FRAME_BUDGET_MS);
    expect(monitor.tier).toBe(FULL_TIER);
    expect(monitor.budget).toBe(FRAME_BUDGET_MS);
    expect(run(monitor, FRAME_BUDGET_MS, 40)).toEqual([]);
    expect(run(monitor, REFRESH, 40)).toEqual([]);
    expect(monitor.index).toBe(0);
  });

  it('throws away the first two seconds, while the city streams in', () => {
    const monitor = new QualityMonitor(FRAME_BUDGET_MS);
    expect(run(monitor, 40, 4)).toEqual([]);
    expect(monitor.index).toBe(0);
  });

  it('does not drop a tier on a hitch of a second', () => {
    const monitor = started();
    // Two slow windows, then the frame is kept again.
    expect(run(monitor, 40, 2)).toEqual([]);
    expect(run(monitor, REFRESH, 4)).toEqual([]);
    expect(run(monitor, 40, 2)).toEqual([]);
    expect(monitor.index).toBe(0);
  });

  it('drops one tier after a second and a half that misses, and stops at the end of the table', () => {
    const monitor = started();
    const first = run(monitor, 40, 3);
    expect(first).toHaveLength(1);
    expect(first[0]?.from).toBe(FULL_TIER);
    expect(first[0]?.to).toBe(QUALITY_TIERS[1]);
    expect(first[0]?.frameMs).toBe(40);
    // Each further step costs the two windows thrown away after a change and
    // the three that miss.
    expect(run(monitor, 40, 4)).toEqual([]);
    expect(run(monitor, 40, 1)).toHaveLength(1);
    run(monitor, 40, 50);
    expect(monitor.tier).toBe(QUALITY_TIERS[QUALITY_TIERS.length - 1]);
    expect(run(monitor, 40, 20)).toEqual([]);
  });

  it('tries the tier above after ten steady seconds on a synced display', () => {
    const monitor = started(2);
    // A kept frame at the refresh shows no headroom, and needs none.
    expect(run(monitor, REFRESH, 19)).toEqual([]);
    const raised = run(monitor, REFRESH, 1);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.to).toBe(QUALITY_TIERS[1]);
    // A try that holds stays, and the next try comes after the same wait.
    expect(run(monitor, REFRESH, 21)).toHaveLength(0);
    expect(run(monitor, REFRESH, 1)).toHaveLength(1);
    expect(monitor.index).toBe(0);
  });

  it('drops a try that misses at once, and waits twice as long before the next', () => {
    const monitor = started(1);
    run(monitor, REFRESH, 20);
    expect(monitor.index).toBe(0);
    run(monitor, REFRESH, 2); // the windows after the change
    // One miss is enough to end a try.
    const back = run(monitor, 40, 1);
    expect(back).toHaveLength(1);
    expect(monitor.index).toBe(1);
    run(monitor, REFRESH, 2);
    expect(run(monitor, REFRESH, 39)).toEqual([]);
    expect(run(monitor, REFRESH, 1)).toHaveLength(1);
    expect(monitor.index).toBe(0);
  });

  it('raises a tier after two seconds of real headroom', () => {
    const monitor = started(2);
    expect(run(monitor, 6, 3)).toEqual([]);
    const raised = run(monitor, 6, 1);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.to).toBe(QUALITY_TIERS[1]);
    run(monitor, 6, 20);
    expect(monitor.index).toBe(0);
    expect(run(monitor, 6, 20)).toEqual([]);
  });

  it('judges nothing on the window after it is settled again', () => {
    const monitor = started(2);
    run(monitor, 6, 3);
    // What the developer free camera draws is not a measurement.
    monitor.settle();
    expect(run(monitor, 6, 4)).toEqual([]);
    expect(run(monitor, 6, 1)).toHaveLength(1);
  });

  it('is not moved by one dear frame, or by a stall', () => {
    const monitor = started();
    for (let window = 0; window < 12; window++) {
      expect(monitor.sample(90)).toBeUndefined();
      expect(monitor.sample(4000)).toBeUndefined();
      run(monitor, 8, 1);
    }
    expect(monitor.index).toBe(0);
  });

  it('starts again from a tier when Auto is turned back on', () => {
    const monitor = started();
    run(monitor, 40, 3);
    expect(monitor.index).toBe(1);
    monitor.restart(3);
    expect(monitor.index).toBe(3);
    expect(run(monitor, 40, 4)).toEqual([]);
  });
});

describe('the graphics settings', () => {
  it('builds each automatic tier back from its own knobs', () => {
    QUALITY_TIERS.forEach((tier, i) => {
      const choice = choiceOf(tier);
      expect(presetOf(choice)).toBe(i);
      expect(tierOf(choice)).toBe(tier);
      expect(nearestTier(choice)).toBe(i);
    });
  });

  it('builds a tier of its own from knobs that match no preset', () => {
    const choice = { ...choiceOf(FULL_TIER), resolution: RESOLUTIONS.length - 1, bloom: false };
    expect(presetOf(choice)).toBeUndefined();
    const tier: QualityTier = tierOf(choice);
    expect(tier.name).toBe('custom');
    expect(tier.post.renderScale).toBe(RESOLUTIONS[RESOLUTIONS.length - 1]?.value);
    expect(tier.post.bloom).toBe(false);
    expect(tier.rings).toEqual(FULL_TIER.rings);
  });

  it('starts on Auto, and reads back only what it understands', () => {
    expect(DEFAULT_GRAPHICS.auto).toBe(true);
    expect(readGraphics(undefined)).toEqual(DEFAULT_GRAPHICS);
    expect(readGraphics({ auto: false, detail: 2, resolution: 9, bloom: 'yes' })).toEqual({
      ...DEFAULT_GRAPHICS,
      auto: false,
      detail: 2,
    });
  });
});

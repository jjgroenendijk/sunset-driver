import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_CAP,
  frameCapLabel,
  frameCapOf,
  FramePacer,
  intervalOf,
  nextFrameCap,
  PAUSED_FPS,
} from '../src/pace.ts';
import { FRAME_BUDGET_MS } from '../src/render/quality.ts';
import { QualityMonitor, WINDOW_MS } from '../src/render/quality-monitor.ts';
import type { KeyValueStore } from '../src/ui/saves.ts';
import { DEFAULT_SETTINGS, readSettings, writeSettings } from '../src/ui/settings.ts';

/** Frames drawn in `seconds` of a display refreshing at `hz`, with the pacer held to `fps`. */
function drawn(hz: number, fps: number, seconds: number, jitter = 0): number {
  const pacer = new FramePacer();
  let count = 0;
  const refreshes = Math.round(hz * seconds);
  for (let i = 0; i < refreshes; i++) {
    // Every other refresh comes early and the next one late by as much.
    const now = (i * 1000) / hz + (i % 2 === 0 ? -jitter : jitter);
    if (pacer.ready(now, intervalOf(fps))) count++;
  }
  return count;
}

describe('the frame pacer', () => {
  it('draws every refresh of a display no faster than the cap, jitter and all', () => {
    expect(drawn(60, 60, 10, 1)).toBe(600);
    expect(drawn(144, 0, 10)).toBe(1440);
  });

  it('holds a faster display to the cap on average', () => {
    for (const hz of [75, 90, 120, 144, 165, 240]) {
      expect(Math.abs(drawn(hz, 60, 10) - 600), `${hz} Hz`).toBeLessThanOrEqual(1);
      expect(Math.abs(drawn(hz, 30, 10) - 300), `${hz} Hz`).toBeLessThanOrEqual(1);
    }
  });

  it('draws a paused session ten times a second', () => {
    expect(drawn(120, PAUSED_FPS, 10)).toBe(100);
  });

  it('owes at most one frame after a long wait', () => {
    const pacer = new FramePacer();
    const interval = intervalOf(60);
    expect(pacer.ready(0, interval)).toBe(true);
    expect(pacer.ready(500, interval)).toBe(true);
    // A 250 Hz display for the tenth of a second after it: six frames are due, and one owed.
    const next = Array.from({ length: 25 }, (_, i) => 504 + 4 * i).filter((now) => pacer.ready(now, interval));
    expect(next.length).toBeLessThanOrEqual(7);
  });
});

describe('the frame cap setting', () => {
  it('starts at 60 and cycles round its steps both ways', () => {
    expect(DEFAULT_SETTINGS.frameCap).toBe(DEFAULT_FRAME_CAP);
    expect(frameCapLabel(60)).toBe('60 fps');
    expect(nextFrameCap(60, 1)).toBe(30);
    expect(nextFrameCap(30, 1)).toBe(0);
    expect(nextFrameCap(0, 1)).toBe(60);
    expect(nextFrameCap(60, -1)).toBe(0);
    expect(frameCapLabel(0)).toBe('No cap');
  });

  it('is kept, and a value this build does not offer reads as the default', () => {
    const store = memoryStore();
    expect(readSettings(store).frameCap).toBe(60);
    writeSettings(store, { ...DEFAULT_SETTINGS, frameCap: 0 });
    expect(readSettings(store).frameCap).toBe(0);
    expect(frameCapOf(45)).toBe(DEFAULT_FRAME_CAP);
    expect(frameCapOf('30')).toBe(DEFAULT_FRAME_CAP);
  });
});

describe('the quality monitor under a frame cap', () => {
  /** Feed the monitor frames of one length for a number of windows, and count the changes. */
  function changes(monitor: QualityMonitor, frameMs: number, windows: number): number {
    let count = 0;
    const frames = windows * Math.ceil(WINDOW_MS / frameMs - 0.01);
    for (let i = 0; i < frames; i++) if (monitor.sample(frameMs) !== undefined) count++;
    return count;
  }

  it('does not take a 30 fps cap for a machine that cannot hold the frame', () => {
    const monitor = new QualityMonitor(FRAME_BUDGET_MS);
    monitor.cap(intervalOf(30));
    expect(monitor.budget).toBeCloseTo(1000 / 30);
    expect(changes(monitor, 1000 / 30, 40)).toBe(0);
    expect(monitor.index).toBe(0);
  });

  it('still drops a tier when the capped frame misses', () => {
    const monitor = new QualityMonitor(FRAME_BUDGET_MS);
    monitor.cap(intervalOf(30));
    changes(monitor, 1000 / 30, 4);
    expect(changes(monitor, 70, 3)).toBe(1);
    expect(monitor.index).toBe(1);
  });

  it('keeps its own budget under a cap faster than it, and again without a cap', () => {
    const monitor = new QualityMonitor(FRAME_BUDGET_MS);
    monitor.cap(intervalOf(120));
    expect(monitor.budget).toBe(FRAME_BUDGET_MS);
    monitor.cap(0);
    expect(monitor.budget).toBe(FRAME_BUDGET_MS);
  });
});

function memoryStore(): KeyValueStore {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

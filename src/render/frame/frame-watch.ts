/**
 * The frame watch: what the frames of a session took, and where they showed
 * things pop in, on the device the game runs on (`docs/performance-budget.md`).
 *
 * The profilers run on a developer's machine. The budget is kept on a phone,
 * which no script can reach, so the game measures itself: the developer block
 * of the HUD shows this line, and `?dev` on the address shows the block on a
 * device with no F3 key. Nothing here changes what is drawn.
 *
 * The frame times are the intervals between frames, as the monitor of
 * `quality-monitor.ts` sees them, over the last few seconds. A long frame is
 * one a player sees as a stutter: two refreshes missed or more.
 */
import { EDGES, type PopIn } from './pop-in.ts';

/** Milliseconds of frames the watch keeps: the last five seconds. */
const WINDOW_MS = 5000;

/** A frame at least this long is a stutter the player sees: two 60 Hz refreshes missed. */
const LONG_FRAME_MS = 50;

/** Frames between two readings of the pop-in, which samples the ground and is too dear for every frame. */
export const POP_IN_EVERY = 15;

/** What the watch reports over its window. */
export interface WatchReport {
  fps: number;
  p50: number;
  p95: number;
  worst: number;
  /** Frames of the window at or over {@link LONG_FRAME_MS}. */
  long: number;
  /** The nearest pop-in over the window, in metres from the camera; `Infinity` where none showed. */
  hole: number;
  /** The nearest edge by design in sight over the window, and what ends there. */
  edge: number;
  edgeName: string;
}

export class FrameWatch {
  private readonly frames: number[] = [];
  private spent = 0;
  /** The pop-in readings of the window, with how far into it each was taken. */
  private readonly pops: { at: number; hole: number; edge: number; name: string }[] = [];
  private clock = 0;
  private count = 0;

  /** Take one frame of `ms` milliseconds. Answers true on a frame that should read the pop-in. */
  sample(ms: number): boolean {
    this.frames.push(ms);
    this.spent += ms;
    this.clock += ms;
    while (this.spent - (this.frames[0] ?? 0) >= WINDOW_MS) this.spent -= this.frames.shift() as number;
    while (this.pops.length > 0 && (this.pops[0] as { at: number }).at < this.clock - WINDOW_MS) this.pops.shift();
    this.count++;
    return this.count % POP_IN_EVERY === 0;
  }

  /** Take a pop-in reading of the frame just sampled. */
  pop(reading: PopIn): void {
    let edge = Infinity;
    let name = '';
    for (const kind of EDGES) {
      if (reading.edges[kind] < edge) {
        edge = reading.edges[kind];
        name = kind;
      }
    }
    this.pops.push({ at: this.clock, hole: reading.hole, edge, name });
  }

  report(): WatchReport {
    const sorted = [...this.frames].sort((a, b) => a - b);
    const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    let hole = Infinity;
    let edge = Infinity;
    let edgeName = '';
    for (const pop of this.pops) {
      hole = Math.min(hole, pop.hole);
      if (pop.edge < edge) {
        edge = pop.edge;
        edgeName = pop.name;
      }
    }
    return {
      fps: this.spent > 0 ? (this.frames.length * 1000) / this.spent : 0,
      p50: at(0.5),
      p95: at(0.95),
      worst: sorted[sorted.length - 1] ?? 0,
      long: this.frames.filter((ms) => ms >= LONG_FRAME_MS).length,
      hole,
      edge,
      edgeName,
    };
  }

  /** The report as the one line the HUD shows. */
  line(): string {
    const r = this.report();
    const m = (value: number): string => (Number.isFinite(value) ? `${value.toFixed(0)} m` : 'none');
    const edge = Number.isFinite(r.edge) ? `${r.edgeName} ${m(r.edge)}` : 'none';
    return (
      `${r.fps.toFixed(0)} fps  p50 ${r.p50.toFixed(1)}  p95 ${r.p95.toFixed(1)}  worst ${r.worst.toFixed(0)} ms` +
      `  ${r.long} long  hole ${m(r.hole)}  edge ${edge}`
    );
  }
}

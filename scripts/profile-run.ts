/**
 * One run of a profiler as a file, and the statistics two runs are compared by.
 *
 * `render-profile.ts --json=<file>` and `sim-profile.ts --json=<file>` write a
 * run: every sample of every series, by name, with the commit it was measured
 * on. `profile-compare.ts` reads two sets of them back. A series is a list of
 * milliseconds, one a frame or one a tick, so the comparison needs to know
 * nothing about what was measured.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Ranking } from './cpu-profile.ts';

export interface ProfileRun {
  tool: string;
  /** What was run: the seed and the options, as typed. */
  label: string;
  /** The commit measured, with `+` when the tree held changes beside it. */
  commit: string;
  date: string;
  /** Milliseconds, one a frame or a tick, by series name. */
  series: Record<string, number[]>;
  /** The CPU profile by area and by file, when one was taken. */
  cpu?: { areas: Ranking; files: Ranking };
}

/** Run `git` with `args` and return its trimmed output. */
function git(...args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- a developer tool runs the git the developer installed, which sits in a different directory on each machine
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** The commit the tree is at, or `unknown` outside a repository. */
export function commitOf(): string {
  try {
    const head = git('rev-parse', '--short', 'HEAD');
    const dirty = git('status', '--porcelain', '--untracked-files=no');
    return dirty === '' ? head : `${head}+`;
  } catch {
    return 'unknown';
  }
}

export function saveRun(path: string, run: Omit<ProfileRun, 'commit' | 'date'>): void {
  const full: ProfileRun = { ...run, commit: commitOf(), date: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(full)}\n`);
  console.log(`run written to ${path}`);
}

export function loadRun(path: string): ProfileRun {
  return JSON.parse(readFileSync(path, 'utf8')) as ProfileRun;
}

/** A percentile of a list: the nearest rank, so a percentile is always a sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

/** A small seeded generator, so a comparison prints the same interval every time it is run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function resample(values: readonly number[], next: () => number): number[] {
  return values.map(() => values[Math.floor(next() * values.length)] ?? 0);
}

/**
 * The 95 % interval of the difference of the medians, `after - before`, by the
 * bootstrap: both lists are resampled with replacement many times, and the
 * middle 95 % of the differences is the interval. It says how far chance
 * within a run moves the median. It does not know what moves between runs —
 * a warmer GPU, another tab — which is why a comparison wants several runs of
 * each build and prints their spread beside it.
 */
export function medianShift(before: readonly number[], after: readonly number[], rounds = 1000): [number, number] {
  const next = lcg(before.length * 7919 + after.length);
  const shifts: number[] = [];
  for (let i = 0; i < rounds; i++) {
    shifts.push(percentile(resample(after, next), 0.5) - percentile(resample(before, next), 0.5));
  }
  return [percentile(shifts, 0.025), percentile(shifts, 0.975)];
}

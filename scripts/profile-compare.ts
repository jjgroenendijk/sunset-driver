/**
 * Compare runs of a profiler before a change with runs after it.
 *
 * Usage: node scripts/profile-compare.ts <before.json>... vs <after.json>...
 *
 * Each file is a run that `render-profile.ts --json` or `sim-profile.ts --json`
 * wrote. The runs on each side are pooled. For every series both sides hold, it
 * prints the median and the 95th percentile before and after, the shift of the
 * median with its 95 % interval, and a verdict.
 *
 * Two kinds of noise are weighed. The interval is the noise within a run: how
 * far chance moves the median of that many samples. The spread is the noise
 * between runs of one build: the largest gap between the medians of two runs
 * on the same side, which only a side of two runs or more has. GPU times move by
 * several milliseconds between runs, so a render change wants two runs a side
 * at least. A shift is called only when its interval leaves 0, it is larger
 * than the spread on either side, and it is 2 % of the median or more: two
 * runs of one build have been seen 1 % apart with no spread to show for it.
 *
 * `--all` lists every series; by default a series whose median is under
 * 0.05 ms on both sides is left out, as nothing a frame would notice.
 */
import { compareStrings } from '../src/core/sort.ts';
import { loadRun, medianShift, percentile, type ProfileRun } from './profile-run.ts';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const at = files.indexOf('vs');
if (at <= 0 || at === files.length - 1) {
  console.error('usage: node scripts/profile-compare.ts <before.json>... vs <after.json>... [--all]');
  process.exit(2);
}
const before = files.slice(0, at).map(loadRun);
const after = files.slice(at + 1).map(loadRun);
const all = args.includes('--all');

function describe(side: string, runs: readonly ProfileRun[]): void {
  for (const run of runs) console.log(`${side}: ${run.tool} ${run.label}, commit ${run.commit}, ${run.date}`);
}
describe('before', before);
describe('after ', after);
if (new Set([...before, ...after].map((run) => run.label)).size > 1) {
  console.log('warning: the runs were made with different options, so they measure different things');
}

/** The largest gap between the medians of two runs of one side, or undefined for one run. */
function spread(runs: readonly ProfileRun[], name: string): number | undefined {
  const medians = runs.map((run) => run.series[name]).filter((v) => v !== undefined).map((v) => percentile(v, 0.5));
  return medians.length < 2 ? undefined : Math.max(...medians) - Math.min(...medians);
}

const names = Object.keys(before[0]?.series ?? {}).filter((name) =>
  [...before, ...after].every((run) => run.series[name] !== undefined),
);
/** The smallest shift called, as a share of the median before. */
const SMALLEST = 0.02;
const f = (v: number): string => v.toFixed(2).padStart(7);
console.log(`\n${'series'.padEnd(34)} before p50/p95   after p50/p95    shift [95% interval]   spread  verdict`);
for (const name of names) {
  const a = before.flatMap((run) => run.series[name] ?? []);
  const b = after.flatMap((run) => run.series[name] ?? []);
  const [ma, mb] = [percentile(a, 0.5), percentile(b, 0.5)];
  if (!all && ma < 0.05 && mb < 0.05) continue;
  const [low, high] = medianShift(a, b);
  const noise = Math.max(spread(before, name) ?? 0, spread(after, name) ?? 0, SMALLEST * ma);
  const shift = mb - ma;
  let verdict = 'within noise';
  if ((low > 0 || high < 0) && Math.abs(shift) > noise) {
    const way = shift < 0 ? 'faster' : 'slower';
    verdict = `${way} by ${((100 * Math.abs(shift)) / Math.max(ma, 1e-9)).toFixed(0)}%`;
  }
  const single = before.length < 2 || after.length < 2;
  console.log(
    `${name.slice(0, 34).padEnd(34)}${f(ma)}${f(percentile(a, 0.95))}  ${f(mb)}${f(percentile(b, 0.95))}  ` +
      `${f(shift)} [${low.toFixed(2)}, ${high.toFixed(2)}]  ${single && noise === 0 ? '    -' : f(noise)}  ${verdict}`,
  );
}
// A pass one build draws and the other does not, such as a shadow map switched off.
const every = new Set([...before, ...after].flatMap((run) => Object.keys(run.series)));
for (const name of [...every].sort(compareStrings)) {
  if (names.includes(name)) continue;
  const side = before.some((run) => run.series[name] !== undefined) ? before : after;
  const median = percentile(side.flatMap((run) => run.series[name] ?? []), 0.5);
  console.log(`${name.slice(0, 34).padEnd(34)} only ${side === before ? 'before' : 'after'}, p50 ${median.toFixed(2)}`);
}
if (before.length < 2 || after.length < 2) {
  console.log('\none run on a side has no spread to weigh: run each build twice or more before trusting a verdict');
}

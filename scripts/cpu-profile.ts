/**
 * Where a V8 CPU profile spent its time, by area, by file and by function.
 *
 * `render-profile.ts --cpuprofile` and `sim-profile.ts --cpuprofile` both take
 * a profile of the work they time, from the browser's DevTools or from Node's
 * inspector, and print it through this. A list of functions alone hides a cost
 * spread over many small ones, so the samples are also summed by the area of
 * the code they fall in (`src/sim`, `src/render`, three.js, Rapier, the
 * collector) and by source file.
 *
 * Self time is the time spent in a function's own code. Total time also counts
 * what it called: a function called from itself counts once per sample.
 */
import { writeFileSync } from 'node:fs';

/** The shape of a profile as `Profiler.stop` answers it, in DevTools and in Node alike. */
export interface CpuProfile {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    children?: number[];
  }[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
}

/** Milliseconds by name, largest first. */
export type Ranking = [string, number][];

export interface CpuSummary {
  /** Milliseconds sampled, the idle time included. */
  totalMs: number;
  /** Milliseconds the thread was idle: waiting on the GPU, a timer or the next frame. */
  idleMs: number;
  areas: Ranking;
  /** Self time by source file. */
  files: Ranking;
  /** Total time by source file: the file's own code and everything it called. */
  filesTotal: Ranking;
  functions: Ranking;
  /** Total time by function. */
  functionsTotal: Ranking;
}

/** The path of a script from where the project starts, without the query a dev server adds. */
function pathOf(url: string): string {
  const bare = url.split('?')[0] ?? '';
  const at = bare.search(/\/(src|node_modules|scripts|test)\//);
  return at === -1 ? bare : bare.slice(at + 1);
}

/** The area of the code a frame of the profile falls in. */
export function areaOf(functionName: string, url: string): string {
  if (functionName === '(garbage collector)') return 'garbage collector';
  if (functionName === '(program)') return 'native (engine, GPU calls)';
  if (functionName === '(idle)') return 'idle';
  const path = pathOf(url);
  const src = /^src\/([^/]+)\//.exec(path);
  if (src !== null) return `src/${src[1]}`;
  if (path.startsWith('src/')) return 'src (top level)';
  if (/rapier/i.test(path) || url.startsWith('wasm://')) return 'rapier';
  if (/three/i.test(path)) return 'three.js';
  if (/tone/i.test(path)) return 'tone.js';
  if (path.startsWith('node_modules/')) return 'other packages';
  if (url.startsWith('node:') || url === '') return 'runtime';
  return 'other';
}

function ranked(map: Map<string, number>): Ranking {
  return [...map].sort((a, b) => b[1] - a[1]);
}

function add(map: Map<string, number>, key: string, ms: number): void {
  map.set(key, (map.get(key) ?? 0) + ms);
}

export function summariseProfile(profile: CpuProfile): CpuSummary {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const areas = new Map<string, number>();
  const files = new Map<string, number>();
  const filesTotal = new Map<string, number>();
  const functions = new Map<string, number>();
  const functionsTotal = new Map<string, number>();
  let totalMs = 0;
  profile.samples.forEach((id, i) => {
    const ms = (profile.timeDeltas[i] ?? 0) / 1000;
    totalMs += ms;
    const node = byId.get(id);
    if (node === undefined) return;
    const { functionName, url, lineNumber } = node.callFrame;
    add(areas, areaOf(functionName, url), ms);
    const path = pathOf(url);
    if (path !== '') add(files, path, ms);
    const name = (fn: string, u: string, line: number): string =>
      u === '' ? fn : `${fn || '(anonymous)'} ${pathOf(u)}:${line + 1}`;
    add(functions, name(functionName, url, lineNumber), ms);
    // Up the stack, each function and each file once, however deep it recurs.
    const seenFunctions = new Set<string>();
    const seenFiles = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const frame = byId.get(at)?.callFrame;
      if (frame === undefined || frame.functionName === '(root)') continue;
      const key = name(frame.functionName, frame.url, frame.lineNumber);
      if (!seenFunctions.has(key)) {
        seenFunctions.add(key);
        add(functionsTotal, key, ms);
      }
      const file = pathOf(frame.url);
      if (file !== '' && !seenFiles.has(file)) {
        seenFiles.add(file);
        add(filesTotal, file, ms);
      }
    }
  });
  return {
    totalMs,
    idleMs: areas.get('idle') ?? 0,
    areas: ranked(areas),
    files: ranked(files),
    filesTotal: ranked(filesTotal),
    functions: ranked(functions),
    functionsTotal: ranked(functionsTotal),
  };
}

function table(title: string, rows: Ranking, busy: number, count: number): void {
  console.log(`  ${title}:`);
  for (const [key, ms] of rows.slice(0, count)) {
    const share = ((100 * ms) / busy).toFixed(1).padStart(5);
    console.log(`    ${ms.toFixed(0).padStart(7)} ms ${share}%  ${key}`);
  }
}

/** Print a summary. `top` is how many files and functions each list shows. */
export function printProfile(title: string, summary: CpuSummary, top = 20): void {
  const busy = Math.max(summary.totalMs - summary.idleMs, 1e-9);
  console.log(
    `cpu profile of ${title}: ${summary.totalMs.toFixed(0)} ms sampled, ${busy.toFixed(0)} ms busy ` +
      `(shares below are of the busy time)`,
  );
  table('by area', summary.areas.filter(([key]) => key !== 'idle'), busy, 12);
  table('by file, self', summary.files, busy, top);
  table('by file, total', summary.filesTotal, busy, top);
  table('by function, self', summary.functions.filter(([key]) => key !== '(idle)'), busy, top);
  table('by function, total', summary.functionsTotal.filter(([key]) => key !== '(idle)'), busy, top);
}

/**
 * Write the profile where `--cpuprofile=<file>` asked. DevTools opens a
 * `.cpuprofile` in its Performance panel, as a flame chart of every sample.
 */
export function saveProfile(profile: CpuProfile, path: string | undefined): void {
  if (path === undefined || path === 'true') return;
  writeFileSync(path, JSON.stringify(profile));
  console.log(`  profile written to ${path}; open it in the Performance panel of Chrome DevTools`);
}

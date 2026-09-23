import { OrthographicCamera, RenderTarget, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { passLabel } from '../src/render/gpu-passes.ts';
import { areaOf, summariseProfile, type CpuProfile } from '../scripts/cpu-profile.ts';
import { medianShift, percentile } from '../scripts/profile-run.ts';

/**
 * The profilers' own arithmetic: where a sample is filed, what a function's
 * total time counts, and when two runs are called different. A profiler that
 * files time under the wrong name sends a session to optimise the wrong code.
 */
const frame = (functionName: string, url: string) => ({ functionName, url, lineNumber: 0 });

describe('the CPU profile summary', () => {
  it('files a sample by the area of the code it fell in', () => {
    expect(areaOf('stepSim', 'http://localhost:5173/src/sim/simulation.ts?t=1')).toBe('src/sim');
    expect(areaOf('run', 'file:///repo/src/frame.ts')).toBe('src (top level)');
    expect(areaOf('render', 'http://localhost:5173/node_modules/.vite/deps/three_webgpu.js?v=2')).toBe('three.js');
    expect(areaOf('step', 'file:///repo/node_modules/@dimforge/rapier3d-compat/rapier.mjs')).toBe('rapier');
    expect(areaOf('wasm-function[12]', 'wasm://wasm/007b5d42')).toBe('rapier');
    expect(areaOf('(garbage collector)', '')).toBe('garbage collector');
    expect(areaOf('(idle)', '')).toBe('idle');
  });

  it('counts a function that calls itself once per sample in its total time', () => {
    // root -> a -> a -> b, and root -> (idle).
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame('(root)', ''), children: [2, 5] },
        { id: 2, callFrame: frame('a', 'file:///repo/src/sim/a.ts'), children: [3] },
        { id: 3, callFrame: frame('a', 'file:///repo/src/sim/a.ts'), children: [4] },
        { id: 4, callFrame: frame('b', 'file:///repo/src/world/b.ts') },
        { id: 5, callFrame: frame('(idle)', '') },
      ],
      samples: [4, 3, 5],
      timeDeltas: [1000, 2000, 4000],
      startTime: 0,
      endTime: 7000,
    };
    const summary = summariseProfile(profile);
    expect(summary.totalMs).toBe(7);
    expect(summary.idleMs).toBe(4);
    expect(Object.fromEntries(summary.areas)).toEqual({ 'src/sim': 2, 'src/world': 1, idle: 4 });
    expect(Object.fromEntries(summary.files)).toEqual({ 'src/sim/a.ts': 2, 'src/world/b.ts': 1 });
    // a's own 2 ms and the 1 ms b took under it; not 5 for being on the stack twice.
    expect(Object.fromEntries(summary.functionsTotal)['a src/sim/a.ts:1']).toBe(3);
    expect(Object.fromEntries(summary.filesTotal)['src/sim/a.ts']).toBe(3);
  });
});

describe('the comparison of two runs', () => {
  it('takes a percentile as the nearest sample', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 1)).toBe(5);
    expect(percentile([], 0.5)).toBe(0);
  });

  it('puts 0 inside the interval of two draws of one list, and outside it for a real shift', () => {
    const base = Array.from({ length: 400 }, (_, i) => 10 + ((i * 37) % 11) / 10);
    const [low, high] = medianShift(base, [...base].reverse());
    expect(low).toBeLessThanOrEqual(0);
    expect(high).toBeGreaterThanOrEqual(0);
    const [slowLow] = medianShift(
      base,
      base.map((v) => v + 1),
    );
    expect(slowLow).toBeGreaterThan(0.5);
  });

  it('prints the same interval every time it is run', () => {
    const a = [1, 2, 3, 4, 5, 6];
    const b = [2, 3, 4, 5, 6, 7];
    expect(medianShift(a, b)).toEqual(medianShift(a, b));
  });
});

describe('the GPU pass labels', () => {
  it('names a shadow map by its light, and a scene pass by where it drew to', () => {
    const camera = new OrthographicCamera();
    const shadow = new Scene();
    shadow.name = 'Shadow Map [ sun cascade 2 ]';
    expect(passLabel(shadow, camera, null)).toBe('shadow sun cascade 2');
    const target = new RenderTarget(64, 32);
    target.texture.name = 'output';
    expect(passLabel(new Scene(), camera, target)).toBe('scene -> output');
    expect(passLabel(new Scene(), camera, null)).toBe('scene -> canvas');
  });
});

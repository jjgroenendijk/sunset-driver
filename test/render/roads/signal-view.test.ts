import { Color, Matrix4, Vector3, type InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import { ARM_REACH, POLE_OUT, SignalView, signalFrame } from '../../../src/render/roads/signals.ts';
import type { SignalApproach } from '../../../src/sim/traffic/signals.ts';
import { sweepSeeds } from '../../support/helpers.ts';
import { GRID_SPACING, gridTraffic } from '../../support/traffic-grid.ts';

describe('the traffic lights, drawn (spec section 13.1)', () => {
  it('builds a head out of a pole, an arm and a housing that reach over the road', () => {
    const frame = signalFrame();
    frame.computeBoundingBox();
    const box = frame.boundingBox;
    expect(box?.max.y).toBeGreaterThan(5);
    expect(box?.min.z).toBeLessThan(-ARM_REACH);
    frame.dispose();
  });

  it('draws one head per approach in view, on the right kerb, with only the lens of its light lit', () => {
    const traffic = gridTraffic(sweepSeeds(1)[0] as number);
    const signals = traffic.signals;
    if (signals === undefined) throw new Error('no signals');
    const view = new SignalView(signals);
    // Round the junction east of the middle; the one at 240 m is out of view.
    const tick = 9876;
    view.update(tick, GRID_SPACING, 0);
    const shown = signals.junctions.filter((j) => Math.abs(j.x - GRID_SPACING) <= 180 && Math.abs(j.y) <= 180);
    const approaches = shown.flatMap((j) => j.approaches.map((a) => signals.approaches[a] as SignalApproach));
    expect(view.drawn).toBe(approaches.length);
    expect(shown.length).toBeLessThan(signals.junctions.length);

    const [frames, lenses] = view.group.children as [InstancedMesh, InstancedMesh];
    const matrix = new Matrix4();
    const at = new Vector3();
    const colour = new Color();
    for (let i = 0; i < approaches.length; i++) {
      const approach = approaches[i] as SignalApproach;
      frames.getMatrixAt(i, matrix);
      at.setFromMatrixPosition(matrix);
      // The pole stands to the right of the arriving traffic, past the kerb.
      const right = -(at.x - approach.x) * Math.sin(approach.heading) + (at.z - approach.y) * Math.cos(approach.heading);
      expect(right).toBeCloseTo(approach.kerb + POLE_OUT, 4);
      const lit = ['red', 'amber', 'green'].map((_, lens) => {
        lenses.getColorAt(i * 3 + lens, colour);
        return colour.r + colour.g + colour.b > 1;
      });
      expect(lit.filter(Boolean)).toHaveLength(1);
      expect(lit[['red', 'amber', 'green'].indexOf(signals.light(approach, tick))]).toBe(true);
    }
    view.dispose();
  });
});

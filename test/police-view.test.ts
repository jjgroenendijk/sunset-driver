import { Color, type InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import { PoliceView } from '../src/render/police.ts';
import { HELICOPTER_HEIGHT, type PoliceUnit } from '../src/sim/police.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';

/** A unit standing where a case needs it, with everything else at rest. */
function unit(id: number, kind: PoliceUnit['kind'], x: number, y: number): PoliceUnit {
  return { id, kind, task: 'chase', x, y, heading: 0, height: 2, speed: 0, health: 1, edges: [], distance: 0, planned: 0, goalX: x, goalY: y, crew: 2, fired: -1_000_000, incident: -1 };
}

function session(): SimState {
  const state = createSimState(5);
  state.police.units.push(unit(0, 'patrol', 10, 0), unit(1, 'patrol', 20, 0), unit(2, 'helicopter', 0, 30));
  return state;
}

describe('the police, drawn (spec sections 9.2, 14)', () => {
  it('draws a car for every unit in view and the helicopter over the roofs', () => {
    const view = new PoliceView();
    const state = session();
    view.update(state, 0, 0);
    expect(view.drawn).toBe(3);
    // Far from the units nothing is drawn at all.
    view.update(state, 4000, 4000);
    expect(view.drawn).toBe(0);
    view.dispose();
  });

  it('stands the helicopter its own height over the ground the record gives it', () => {
    const view = new PoliceView();
    const state = session();
    view.update(state, 0, 0);
    const heli = view.group.children.find((mesh) => (mesh as InstancedMesh).count === 1) as InstancedMesh;
    const y = heli.instanceMatrix.array[13] as number;
    expect(y).toBeCloseTo(2 + HELICOPTER_HEIGHT, 6);
    view.dispose();
  });

  it('flashes the light bars, and two cars on the same beat flash against each other', () => {
    const view = new PoliceView();
    const state = session();
    view.update(state, 0, 0);
    const bar = view.group.children[3] as InstancedMesh;
    const colourOf = (index: number): string => new Color().fromArray(Array.from(bar.instanceColor?.array ?? []), index * 3).getHexString();
    const first = colourOf(0);
    expect(colourOf(1)).not.toBe(first);
    // Half a beat later the bar has changed colour.
    state.tick += 12;
    view.update(state, 0, 0);
    expect(colourOf(0)).not.toBe(first);
    view.dispose();
  });
});

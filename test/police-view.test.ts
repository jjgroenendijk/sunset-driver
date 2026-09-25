import type { InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import { BEACON_DARK, BEACON_GLOW, FLASH_CYCLE, flashLit } from '../src/render/beacons.ts';
import { PoliceView } from '../src/render/police.ts';
import { HELICOPTER_HEIGHT, type PoliceUnit } from '../src/sim/police.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';

/** A unit standing where a case needs it, with everything else at rest. */
function unit(id: number, kind: PoliceUnit['kind'], x: number, y: number): PoliceUnit {
  return { id, kind, task: 'chase', x, y, heading: 0, height: 2, speed: 0, health: 1, edges: [], distance: 0, planned: 0, goalX: x, goalY: y, crew: 2, doors: 0, doorTick: -1_000_000, fired: -1_000_000, incident: -1 };
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

  it('flashes the two halves of each bar in turn, and two cars out of step', () => {
    const view = new PoliceView();
    const state = session();
    // Car 0's red half is lit on tick 1 and car 1's is not: each car has its own offset.
    state.tick = 1;
    expect(flashLit(1, 0, 0)).toBe(true);
    expect(flashLit(1, 1, 0)).toBe(false);
    view.update(state, 0, 0);
    const red = view.group.children[2] as InstancedMesh;
    const blue = view.group.children[3] as InstancedMesh;
    expect(red.instanceColor?.getX(0)).toBe(BEACON_GLOW);
    expect(red.instanceColor?.getX(1)).toBeCloseTo(BEACON_DARK, 5);
    expect(blue.instanceColor?.getX(0)).toBeCloseTo(BEACON_DARK, 5);
    // Half a cycle on, the blue half of car 0 has its turn.
    state.tick = 1 + FLASH_CYCLE / 2;
    view.update(state, 0, 0);
    expect(red.instanceColor?.getX(0)).toBeCloseTo(BEACON_DARK, 5);
    expect(blue.instanceColor?.getX(0)).toBe(BEACON_GLOW);
    view.dispose();
  });
});

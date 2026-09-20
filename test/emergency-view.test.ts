import { Matrix4, Vector3, type InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import { DamageFx } from '../src/render/damage-fx.ts';
import { EmergencyView } from '../src/render/emergency.ts';
import { TRAFFIC_VIEW } from '../src/render/traffic.ts';
import { UNIT_BODY, WORK_TICKS, type EmergencyUnit } from '../src/sim/emergency.ts';
import { crewOf, placeCrew, type CrewMember } from '../src/sim/emergency-crew.ts';
import { emptyHose, hoseOf } from '../src/render/emergency-crew.ts';
import { light } from '../src/sim/fire.ts';
import { createSimState } from '../src/sim/simulation.ts';
import { specOf } from '../src/sim/vehicle.ts';
import { BEACON_DARK, BEACON_GLOW, FLASH_CYCLE, flashLit } from '../src/render/beacons.ts';
import { AMBULANCE_RED, unitShape } from '../src/render/emergency-mesh.ts';

/** A unit of the service standing where a test wants it. */
function unit(id: number, kind: EmergencyUnit['kind'], x: number, y: number): EmergencyUnit {
  return {
    id,
    kind,
    task: 'respond',
    call: 0,
    x,
    y,
    heading: 0,
    height: 0,
    speed: 0,
    edges: [],
    distance: 0,
    stop: 0,
    planned: 0,
    goalX: x,
    goalY: y,
    homeX: x,
    homeY: y,
    until: -1,
    doors: 0,
    deployed: false,
  };
}

describe('the emergency services, drawn (spec section 20.3)', () => {
  /**
   * The meshes of the view by what they are: per kind a body, a rim, two
   * beacon phases and a door each side, then the glow, the water and the hoses.
   */
  function parts(view: EmergencyView): InstancedMesh[] {
    return view.group.children as InstancedMesh[];
  }
  const ENGINE_PHASES = [2, 3];
  const ENGINE_DOORS = [4, 5];
  const GLOW = 12;
  const WATER = 13;
  const HOSES = 14;

  it('draws the units in view and leaves out the ones over the horizon', () => {
    const view = new EmergencyView();
    const state = createSimState(4);
    state.emergency.units.push(unit(0, 'engine', 10, 0), unit(1, 'ambulance', -20, 5));
    view.update(state, 0, 0);
    expect(view.drawn).toBe(2);
    // A unit past the traffic's own view is not drawn at all.
    state.emergency.units.push(unit(2, 'engine', 2 * TRAFFIC_VIEW, 0));
    view.update(state, 0, 0);
    expect(view.drawn).toBe(2);
    // Nobody out is nothing drawn, and nothing left visible from the frame before.
    state.emergency.units.length = 0;
    view.update(state, 0, 0);
    expect(view.drawn).toBe(0);
    for (const mesh of parts(view)) expect(mesh.visible).toBe(false);
    view.dispose();
  });

  it('flashes one half of a bar while the other is dark, and two units out of step', () => {
    // Over a whole cycle each phase is lit some of the time, and never both at once.
    let first = 0;
    let second = 0;
    for (let tick = 0; tick < FLASH_CYCLE; tick++) {
      const a = flashLit(tick, 0, 0);
      const b = flashLit(tick, 0, 1);
      expect(a && b).toBe(false);
      if (a) first++;
      if (b) second++;
    }
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
    const view = new EmergencyView();
    const state = createSimState(4);
    state.emergency.units.push(unit(0, 'engine', 0, 0), unit(1, 'engine', 8, 0));
    // A tick where the first unit's left half burns and the second's does not.
    state.tick = 1;
    view.update(state, 0, 0);
    const left = parts(view)[ENGINE_PHASES[0] as number] as InstancedMesh;
    expect(left.count).toBe(2);
    expect(left.instanceColor?.getX(0)).toBe(BEACON_GLOW);
    expect(left.instanceColor?.getX(1)).toBeCloseTo(BEACON_DARK, 5);
    // The light it throws lies on the road under it.
    expect(parts(view)[GLOW]?.count).toBe(1);
    view.dispose();
  });

  it('keeps the lights dark on a unit driving home from a job', () => {
    const view = new EmergencyView();
    const state = createSimState(4);
    const home = unit(0, 'engine', 0, 0);
    home.task = 'leave';
    state.emergency.units.push(home);
    for (let tick = 0; tick < FLASH_CYCLE; tick++) {
      state.tick = tick;
      view.update(state, 0, 0);
      for (const at of ENGINE_PHASES) expect(parts(view)[at]?.instanceColor?.getX(0)).toBeCloseTo(BEACON_DARK, 5);
      expect(parts(view)[GLOW]?.visible).toBe(false);
    }
    view.dispose();
  });

  it('plays water from the nozzles of the crew of an engine, and from nothing else', () => {
    const view = new EmergencyView();
    const state = createSimState(4);
    const engine = unit(0, 'engine', 0, 0);
    const ambulance = unit(1, 'ambulance', 30, 0);
    ambulance.task = 'work';
    ambulance.until = WORK_TICKS.ambulance;
    state.emergency.units.push(engine, ambulance);
    view.update(state, 0, 0);
    expect(parts(view)[WATER]?.visible).toBe(false);
    expect(parts(view)[HOSES]?.visible).toBe(false);
    // An engine that has just pulled up: nobody is down from the cab yet, so
    // there is no hose on the road and no water on the fire.
    engine.task = 'work';
    engine.goalX = 8;
    engine.goalY = 3;
    state.tick = 1000;
    engine.until = state.tick + WORK_TICKS.engine;
    view.update(state, 0, 0);
    expect(parts(view)[HOSES]?.visible).toBe(false);
    expect(parts(view)[WATER]?.visible).toBe(false);
    // With the crew at their places the hose is run out and water leaves each nozzle.
    placeCrew(state, engine);
    view.update(state, 0, 0);
    expect(parts(view)[HOSES]?.count).toBeGreaterThan(0);
    const water = parts(view)[WATER] as InstancedMesh;
    expect(water.count).toBeGreaterThan(0);
    const hose = emptyHose();
    const nearest = Math.min(
      ...crewOf(state, engine.id).map((member: CrewMember) => {
        const laid = hoseOf(state, engine, member, hose);
        return Math.hypot(laid.nozzleX - 8, laid.nozzleY - 3);
      }),
    );
    // Every drop is between the nozzles and a little past the scene, none over the engine, and none under the road.
    for (let i = 0; i < water.count; i++) {
      const x = water.instanceMatrix.array[i * 16 + 12] as number;
      const y = water.instanceMatrix.array[i * 16 + 13] as number;
      const z = water.instanceMatrix.array[i * 16 + 14] as number;
      expect(Math.hypot(x - 8, z - 3)).toBeLessThan(nearest + 2);
      expect(y).toBeGreaterThan(-0.5);
    }
    view.dispose();
  });

  it('swings the doors of a unit out as far as the record has them open', () => {
    const view = new EmergencyView();
    const state = createSimState(4);
    const engine = unit(0, 'engine', 0, 0);
    state.emergency.units.push(engine);
    const shape = unitShape('engine');
    expect(shape.doors).toHaveLength(2);
    // Where the middle of each door panel stands in the world, drawn as it is
    // about its hinge and turned by the instance's own matrix.
    const panels = (): Vector3[] =>
      shape.doors.map((door, i) => {
        const mesh = parts(view)[(ENGINE_DOORS[i] as number)] as InstancedMesh;
        const matrix = new Matrix4();
        mesh.getMatrixAt(0, matrix);
        const at = new Vector3(door.box.x - door.hinge.x, door.box.y - door.hinge.y, door.box.z - door.hinge.z);
        return at.applyMatrix4(matrix);
      });
    view.update(state, 0, 0);
    const shut = panels();
    // Shut, each door lies along its own flank, one either side of the engine.
    for (const at of shut) expect(Math.abs(at.z)).toBeLessThan(UNIT_BODY.engine.halfWidth + 0.2);
    expect(Math.sign(shut[0]?.z ?? 0)).toBe(-Math.sign(shut[1]?.z ?? 0));
    engine.doors = 1;
    view.update(state, 0, 0);
    // Open, each stands well out past the flank it hangs on, on its own side.
    const open = panels();
    for (let i = 0; i < open.length; i++) {
      const was = shut[i] as Vector3;
      const now = open[i] as Vector3;
      expect(Math.abs(now.z)).toBeGreaterThan(Math.abs(was.z) + 0.5);
      expect(Math.sign(now.z)).toBe(Math.sign(was.z));
      // And swung round its hinge, which is at the front edge: it moves forward.
      expect(now.x).toBeGreaterThan(was.x);
    }
    view.dispose();
  });

  it('sits a unit on the ground under it, at the ride height of its own body', () => {
    const view = new EmergencyView();
    const state = createSimState(4);
    const standing = unit(0, 'engine', 0, 0);
    standing.height = 12;
    state.emergency.units.push(standing);
    view.update(state, 0, 0);
    const body = parts(view)[0] as InstancedMesh;
    // The matrix of an instance holds its position in its last column.
    expect(body.instanceMatrix.array[13] as number).toBeCloseTo(12 + UNIT_BODY.engine.ride, 6);
    // The wheels reach the road and the body is no bigger than the box the player hits.
    body.geometry.computeBoundingBox();
    const bounds = body.geometry.boundingBox;
    expect(bounds?.min.y).toBeCloseTo(-UNIT_BODY.engine.ride, 2);
    expect(bounds?.max.x ?? 0).toBeLessThan(UNIT_BODY.engine.halfLength + 0.5);
    expect(bounds?.max.z ?? 0).toBeLessThan(UNIT_BODY.engine.halfWidth + 0.2);
    view.dispose();
  });
});

describe('the shapes of the services (spec section 20.3)', () => {
  it('gives an engine a ladder and an ambulance a cross, each on its roof', () => {
    const engine = unitShape('engine');
    const ambulance = unitShape('ambulance');
    // The rungs: a row of short boxes across the roof, over the body.
    const rungs = engine.boxes.filter((part) => part.length < 0.1 && part.width > 0.8 && part.y > UNIT_BODY.engine.halfHeight);
    expect(rungs.length).toBeGreaterThan(12);
    // The cross: two red bars on the roof, one along it and one across it.
    const cross = ambulance.boxes.filter((part) => part.colour === AMBULANCE_RED && part.y > UNIT_BODY.ambulance.halfHeight);
    expect(cross).toHaveLength(2);
    // Each has beacons in both phases, and only the engine carries a hose.
    for (const shape of [engine, ambulance]) {
      expect(shape.beacons.some((beacon) => beacon.phase === 0)).toBe(true);
      expect(shape.beacons.some((beacon) => beacon.phase === 1)).toBe(true);
    }
    expect(engine.couplings).toHaveLength(2);
    expect(ambulance.couplings).toHaveLength(0);
  });

  it('keeps every box of a unit inside the box the player hits, give or take a mirror', () => {
    for (const kind of ['engine', 'ambulance'] as const) {
      const body = UNIT_BODY[kind];
      for (const part of unitShape(kind).boxes) {
        expect(Math.abs(part.x) + part.length / 2, kind).toBeLessThan(body.halfLength + 0.45);
        expect(Math.abs(part.z) + part.width / 2, kind).toBeLessThan(body.halfWidth + 0.3);
        expect(part.y + part.height / 2, kind).toBeLessThan(body.halfHeight + 0.7);
      }
    }
  });
});

describe('a blaze, drawn (spec section 20.3)', () => {
  it('puts flames and embers in the air over the ground it burns on', () => {
    const fx = new DamageFx();
    const state = createSimState(4);
    state.tick = 600;
    light(state, 30, -40);
    const flame = fx.group.children[1] as InstancedMesh;
    fx.watch(state.fires.blazes, () => 7);
    fx.update(state.vehicle, specOf('saloon'), state.seed, state.tick);
    expect(flame.count).toBeGreaterThan(0);
    // Every puff stands over the ground the blaze burns on, and near it.
    for (let i = 0; i < flame.count; i++) {
      const at = i * 16;
      expect(flame.instanceMatrix.array[at + 13] as number).toBeGreaterThan(7);
      expect(Math.hypot((flame.instanceMatrix.array[at + 12] as number) - 30, (flame.instanceMatrix.array[at + 14] as number) + 40)).toBeLessThan(6);
    }
    // Nothing burning is nothing drawn.
    fx.watch([], () => 7);
    fx.reset(state.tick);
    fx.update(state.vehicle, specOf('saloon'), state.seed, state.tick + 1);
    expect(flame.count).toBe(0);
    fx.dispose();
  });
});

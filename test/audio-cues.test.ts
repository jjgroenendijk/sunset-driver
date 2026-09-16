import { describe, expect, it } from 'vitest';
import { createCueMemory, readScene, type AudioScene, type CueMemory, type WorldSounds } from '../src/audio/cues.ts';
import { EMPTY_INPUT, type InputFrame } from '../src/sim/input.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';
import { giveWeapon } from '../src/sim/weapon.ts';
import { TICK_RATE } from '../src/sim/clock.ts';
import { IMPACT_FLOOR } from '../src/sim/damage.ts';
import type { PoliceKind, PoliceUnit } from '../src/sim/police.ts';

const NOTHING: WorldSounds = { bells: [] };

function input(over: Partial<InputFrame> = {}): InputFrame {
  return { ...EMPTY_INPUT, ...over };
}

/** A session on foot at the origin, standing on the ground. */
function onFoot(state: SimState): void {
  state.player.driving = false;
  state.player.grounded = true;
  state.player.speed = 0;
}

function unit(id: number, kind: PoliceKind, x: number, y: number): PoliceUnit {
  return {
    id,
    kind,
    task: 'chase',
    x,
    y,
    heading: 0,
    height: 0,
    speed: 20,
    health: 1,
    edges: [],
    distance: 0,
    planned: 0,
    goalX: x,
    goalY: y,
  };
}

/** Read one frame, having read the frame before it: what a running session does. */
function nextFrame(state: SimState, memory: CueMemory, frame: InputFrame = EMPTY_INPUT, world = NOTHING): AudioScene {
  state.tick += 1;
  return readScene(state, frame, world, memory, { engine: null, loops: [], shots: [] });
}

/** Spec section 15: the record read as an engine, the loops that hold and the sounds that start. */
describe('the audio cues', () => {
  it('starts nothing on the first frame, having nothing to compare against', () => {
    const state = createSimState(1);
    state.loadout.shots = 4;
    const scene = readScene(state, EMPTY_INPUT, NOTHING, createCueMemory());
    expect(scene.shots).toEqual([]);
  });

  it('gives the player an engine while they drive and nothing while they walk', () => {
    const state = createSimState(1);
    const memory = createCueMemory();
    state.vehicle.x = 12;
    state.vehicle.z = -4;
    state.vehicle.speed = 20;
    const driving = nextFrame(state, memory, input({ throttle: 1 }));
    expect(driving.engine).not.toBeNull();
    expect(driving.engine?.x).toBe(12);
    expect(driving.engine?.y).toBe(-4);
    expect(driving.engine?.load).toBe(1);

    onFoot(state);
    expect(nextFrame(state, memory).engine).toBeNull();
  });

  it('fires one shot for every round the player let go, and calls a fist a swing', () => {
    const state = createSimState(1);
    const memory = createCueMemory();
    onFoot(state);
    nextFrame(state, memory);
    state.loadout.shots += 2;
    const swings = nextFrame(state, memory).shots;
    expect(swings).toHaveLength(2);
    expect(swings[0]?.kind).toBe('melee');

    giveWeapon(state.loadout, 'remington-870');
    state.loadout.shots += 1;
    const blast = nextFrame(state, memory).shots;
    expect(blast).toHaveLength(1);
    expect(blast[0]?.kind).toBe('gunshot');
    expect(blast[0]?.strength).toBeGreaterThan(swings[0]?.strength as number);
  });

  it('starts a shot once, however many frames fall on the same tick', () => {
    const state = createSimState(1);
    const memory = createCueMemory();
    nextFrame(state, memory);
    state.loadout.shots += 1;
    expect(nextFrame(state, memory).shots).toHaveLength(1);
    // A frame between two ticks: the record has not moved, so nothing starts again.
    expect(readScene(state, EMPTY_INPUT, NOTHING, memory).shots).toEqual([]);
  });

  it('hears a crash by the speed the vehicle lost, and hears nothing in braking', () => {
    const state = createSimState(1);
    const memory = createCueMemory();
    state.vehicle.vx = 24;
    nextFrame(state, memory);
    // Braking takes about 0.1 m/s off in a tick, well under the floor.
    state.vehicle.vx -= 0.1;
    expect(nextFrame(state, memory).shots).toEqual([]);
    state.vehicle.vx -= IMPACT_FLOOR * 6;
    const crash = nextFrame(state, memory).shots;
    expect(crash).toHaveLength(1);
    expect(crash[0]?.kind).toBe('impact');
    expect(crash[0]?.strength).toBeGreaterThan(0);
  });

  it('hears no crash on the frame a respawn or a metro trip moved the player', () => {
    const state = createSimState(1);
    const memory = createCueMemory();
    state.vehicle.vx = 30;
    nextFrame(state, memory);
    state.vehicle.vx = 0;
    state.respawn = { cause: 'death', tick: state.tick, cost: 0 };
    expect(nextFrame(state, memory).shots).toEqual([]);
  });

  it('goes off when the fuse of a burning vehicle ends', () => {
    const state = createSimState(1);
    const memory = createCueMemory();
    nextFrame(state, memory);
    state.vehicle.damage.blownTick = state.tick;
    const blast = nextFrame(state, memory).shots;
    expect(blast.map((shot) => shot.kind)).toEqual(['explosion']);
    // And once only: the record still says it blew on that tick.
    expect(nextFrame(state, memory).shots).toEqual([]);
  });

  it('steps by the distance walked, so a sprint steps faster than a walk', () => {
    const state = createSimState(1);
    const memory = createCueMemory();
    onFoot(state);
    nextFrame(state, memory);
    state.player.speed = 2;
    let steps = 0;
    for (let i = 0; i < TICK_RATE; i++) steps += nextFrame(state, memory).shots.length;
    let faster = 0;
    state.player.speed = 6;
    for (let i = 0; i < TICK_RATE; i++) faster += nextFrame(state, memory).shots.length;
    expect(steps).toBeGreaterThan(0);
    expect(faster).toBeGreaterThan(steps);
  });

  it('makes no footfall standing still, and thumps on landing from a jump', () => {
    const state = createSimState(1);
    const memory = createCueMemory();
    onFoot(state);
    nextFrame(state, memory);
    for (let i = 0; i < TICK_RATE; i++) expect(nextFrame(state, memory).shots).toEqual([]);

    state.player.grounded = false;
    nextFrame(state, memory);
    state.player.grounded = true;
    state.player.vy = -8;
    expect(nextFrame(state, memory).shots.map((shot) => shot.kind)).toEqual(['landing']);
  });

  it('squeals while the tyres slide and stops when they grip again', () => {
    const state = createSimState(1);
    const memory = createCueMemory();
    state.vehicle.speed = 18;
    for (const wheel of state.vehicle.wheels) {
      wheel.contact = true;
      wheel.skid = true;
    }
    expect(nextFrame(state, memory).loops.map((loop) => loop.kind)).toContain('squeal');
    for (const wheel of state.vehicle.wheels) wheel.skid = false;
    expect(nextFrame(state, memory).loops.map((loop) => loop.kind)).not.toContain('squeal');
  });

  it('gives every unit out its own siren, and the helicopter its rotor', () => {
    const state = createSimState(1);
    const memory = createCueMemory();
    state.police.units = [unit(1, 'patrol', 40, 0), unit(2, 'helicopter', 0, 60)];
    const loops = nextFrame(state, memory).loops;
    expect(loops.map((loop) => loop.id)).toEqual(expect.arrayContaining(['siren:1', 'rotor:2']));
    state.police.units = [];
    expect(nextFrame(state, memory).loops.filter((loop) => loop.kind === 'siren')).toEqual([]);
  });

  it('sounds the horn while the key is held, and only in a vehicle', () => {
    const state = createSimState(1);
    const memory = createCueMemory();
    expect(nextFrame(state, memory, input({ horn: true })).loops.map((loop) => loop.kind)).toContain('horn');
    onFoot(state);
    expect(nextFrame(state, memory, input({ horn: true })).loops.map((loop) => loop.kind)).not.toContain('horn');
  });

  it('rings the bells the trams rang on that tick (spec section 13.2)', () => {
    const state = createSimState(1);
    const memory = createCueMemory();
    nextFrame(state, memory);
    const ringing = nextFrame(state, memory, EMPTY_INPUT, { bells: [{ x: 5, y: 9 }] }).shots;
    expect(ringing).toHaveLength(1);
    expect(ringing[0]).toMatchObject({ kind: 'bell', x: 5, y: 9 });
  });

  it('holds a fire while the vehicle burns', () => {
    const state = createSimState(1);
    const memory = createCueMemory();
    state.vehicle.damage.stage = 'burning';
    expect(nextFrame(state, memory).loops.map((loop) => loop.kind)).toContain('fire');
  });
});

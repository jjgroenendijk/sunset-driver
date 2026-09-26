import { FixedStepClock, TICK_MS } from '../../src/sim/clock.ts';
import { EMPTY_INPUT, type InputFrame } from '../../src/sim/input.ts';
import { SimPhysics, type Ground } from '../../src/sim/physics/physics.ts';
import { createSimState, stepSim, type SimState } from '../../src/sim/simulation.ts';
import type { Surface } from '../../src/world/terrain/surface.ts';
import { DRY } from './helpers.ts';

/**
 * The ground and the session every simulation test runs on, shared by the files
 * that split out of `sim-sweep.test.ts`.
 *
 * The ground is a hillside written here rather than a generated world. The
 * simulation reads the world through a {@link Ground} and nothing more, so a
 * seed sweep of cities would measure the city; this measures the simulation.
 * `seed-ground.test.ts` is where the real ground is checked.
 */
export const SEED_COUNT = process.env.SWEEP_SEEDS ? 24 : 2;
export const TICKS = process.env.SWEEP_SEEDS ? 900 : 400;

/** A hillside: rolling enough that the suspension, the grades and the grip all do something. */
export function hills(surface: Surface = 'asphalt'): Ground {
  return {
    heightAt: (x, y) => 2.5 * Math.sin(x / 37) + 1.5 * Math.cos(y / 51) + 0.35 * Math.sin(x / 8 + y / 11),
    surfaceAt: () => surface,
    seaLevel: DRY,
  };
}

/** A plain constant grade, for the checks that are about the gradient alone. */
export function ramp(surface: Surface, slope: number): Ground {
  return { heightAt: (x) => x * slope, surfaceAt: () => surface, seaLevel: DRY };
}

/** A session on a ground, with the car already settled on its springs. */
export interface Session {
  state: SimState;
  physics: SimPhysics;
  /** The ground it was built on, so a test can hand the city something mid-run. */
  ground: Ground;
}

export function start(ground: Ground, seed = 1): Session {
  const state = createSimState(seed);
  const physics = new SimPhysics(ground, state);
  physics.spawn(state, 0, 0, 0);
  const session = { state, physics, ground };
  drive(session, 60);
  return session;
}

export function drive(session: Session, ticks: number, input: Partial<InputFrame> = {}): void {
  const frame = { ...EMPTY_INPUT, ...input };
  for (let i = 0; i < ticks; i++) stepSim(session.state, frame, session.physics);
}

/**
 * Let a move into the vehicle or out of it run to its end (`boarding.ts`): the
 * door takes about a second, and the player is held until it is shut.
 */
export function finishBoarding(session: Session): void {
  for (let i = 0; i < 600 && session.state.boarding !== null; i++) drive(session, 1);
}

/** Run a recorded stream from a fresh session and answer with the state it ended in. */
export function replay(seed: number, inputs: readonly InputFrame[]): SimState {
  const state = createSimState(seed);
  const physics = new SimPhysics(hills(), state);
  physics.spawn(state, 0, 0, 0);
  for (const frame of inputs) stepSim(state, frame, physics);
  physics.dispose();
  return state;
}

/**
 * The same, with the player out of the car before the stream starts, so the
 * sweep covers the character controller of spec section 11.5 rather than
 * leaving it to the presses of interact the stream happens to make. It answers
 * with the metres walked on foot as well, so a run that never left the car
 * cannot pass for one that did.
 */
export function walkReplay(seed: number, inputs: readonly InputFrame[]): { state: SimState; walked: number } {
  const state = createSimState(seed);
  const physics = new SimPhysics(hills(), state);
  physics.spawn(state, 0, 0, 0);
  for (let i = 0; i < 60; i++) stepSim(state, EMPTY_INPUT, physics);
  stepSim(state, { ...EMPTY_INPUT, interact: true }, physics);
  for (let i = 0; i < 600 && state.boarding !== null; i++) stepSim(state, EMPTY_INPUT, physics);
  // Walk a second away from the door, so a stream that presses interact at once
  // is out of reach rather than straight back into the seat.
  for (let i = 0; i < 60; i++) stepSim(state, { ...EMPTY_INPUT, throttle: 1 }, physics);
  let walked = 0;
  let x = state.player.x;
  let y = state.player.y;
  for (const frame of inputs) {
    stepSim(state, frame, physics);
    if (!state.player.driving) walked += Math.hypot(state.player.x - x, state.player.y - y);
    x = state.player.x;
    y = state.player.y;
  }
  physics.dispose();
  return { state, walked };
}

/** Drive until the car passes a speed, and answer how far it got. Gives up after a minute. */
export function accelerateTo(session: Session, speed: number): boolean {
  for (let i = 0; i < 3600 && session.state.vehicle.speed < speed; i++) drive(session, 1, { throttle: 1 });
  return session.state.vehicle.speed >= speed;
}

/** Run the sim with a given frame pacing (ms per render frame) for a wall-clock duration. */
export function runPaced(seed: number, inputs: readonly InputFrame[], frameMs: number): SimState {
  const state = createSimState(seed);
  const physics = new SimPhysics(hills(), state);
  physics.spawn(state, 0, 0, 0);
  const clock = new FixedStepClock();
  let tick = 0;
  let elapsed = 0;
  const total = inputs.length * TICK_MS;
  while (elapsed < total + frameMs) {
    const steps = clock.advance(frameMs);
    for (let i = 0; i < steps && tick < inputs.length; i++) stepSim(state, inputs[tick++] as InputFrame, physics);
    elapsed += frameMs;
  }
  // Drain any remaining ticks so every pacing reaches the same tick.
  while (tick < inputs.length) stepSim(state, inputs[tick++] as InputFrame, physics);
  physics.dispose();
  return state;
}


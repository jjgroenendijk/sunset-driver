import { describe, expect, it } from 'vitest';
import { AudioDirector, type AudioSink, type FiredShot, type HeldLoop } from '../src/audio/director.ts';
import type { EngineCue } from '../src/audio/cues.ts';
import { REACH, VOICE_CAP, type Mixed } from '../src/audio/mix.ts';
import { EMPTY_INPUT } from '../src/sim/input.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';
import type { PoliceKind, PoliceUnit } from '../src/sim/police.ts';

/** A sink that plays nothing and writes down everything it was told. */
class SpySink implements AudioSink {
  readonly held: HeldLoop[] = [];
  readonly released: string[] = [];
  readonly fired: FiredShot[] = [];
  engines: { cue: EngineCue | null; mix: Mixed }[] = [];
  ducked = 0;

  engine(cue: EngineCue | null, mix: Mixed): void {
    this.engines.push({ cue, mix });
  }

  hold(loop: HeldLoop): void {
    this.held.push(loop);
  }

  release(id: string): void {
    this.released.push(id);
  }

  fire(shot: FiredShot): void {
    this.fired.push(shot);
  }

  duck(amount: number): void {
    this.ducked = amount;
  }

  /** The ids held since the last time this was asked, so a frame is read on its own. */
  takeHeld(): string[] {
    const ids = this.held.map((loop) => loop.id);
    this.held.length = 0;
    return ids;
  }
}

function unit(id: number, x: number, y: number, kind: PoliceKind = 'patrol'): PoliceUnit {
  return { id, kind, task: 'chase', x, y, heading: 0, height: 0, speed: 20, health: 1, edges: [], distance: 0, planned: 0, goalX: x, goalY: y };
}

/** Step the record one tick and hand the director the frame. */
function frame(director: AudioDirector, state: SimState): void {
  state.tick += 1;
  director.update(state, EMPTY_INPUT, { x: state.player.x, y: state.player.y });
}

/** Spec section 15: what the director asks of a sink, and what it refuses to ask for. */
describe('the audio director', () => {
  it('holds a unit’s siren across frames and lets it go when the unit is gone', () => {
    const sink = new SpySink();
    const director = new AudioDirector(sink);
    const state = createSimState(1);
    state.police.units = [unit(7, 20, 0)];
    frame(director, state);
    frame(director, state);
    expect(sink.takeHeld()).toEqual(['siren:7', 'siren:7']);
    expect(sink.released).toEqual([]);

    state.police.units = [];
    frame(director, state);
    expect(sink.released).toEqual(['siren:7']);
  });

  it('asks for nothing that cannot be heard from where the player stands', () => {
    const sink = new SpySink();
    const director = new AudioDirector(sink);
    const state = createSimState(1);
    state.police.units = [unit(1, REACH.siren * 2, 0)];
    frame(director, state);
    expect(sink.takeHeld()).toEqual([]);
  });

  it('keeps the loudest voices when more are out than the budget pays for', () => {
    const sink = new SpySink();
    const director = new AudioDirector(sink);
    const state = createSimState(1);
    // Twice the budget of units, each one further off than the last.
    state.police.units = Array.from({ length: VOICE_CAP * 2 }, (_, i) => unit(i, 10 + i * 5, 0));
    frame(director, state);
    const held = sink.takeHeld();
    expect(held).toHaveLength(VOICE_CAP);
    // The nearest unit is the first one, and the far ones were dropped.
    expect(held).toContain('siren:0');
    expect(held).not.toContain(`siren:${VOICE_CAP * 2 - 1}`);
  });

  it('gives the engine to the sink while the player drives and takes it away on foot', () => {
    const sink = new SpySink();
    const director = new AudioDirector(sink);
    const state = createSimState(1);
    state.vehicle.speed = 15;
    frame(director, state);
    expect(sink.engines.at(-1)?.cue).not.toBeNull();
    expect(sink.engines.at(-1)?.mix.gain).toBe(1);

    state.player.driving = false;
    frame(director, state);
    expect(sink.engines.at(-1)?.cue).toBeNull();
  });

  it('ducks the bed under a blast and not under an engine', () => {
    const sink = new SpySink();
    const director = new AudioDirector(sink);
    const state = createSimState(1);
    frame(director, state);
    expect(sink.ducked).toBe(0);
    state.vehicle.damage.blownTick = state.tick + 1;
    frame(director, state);
    expect(sink.ducked).toBeGreaterThan(0);
  });

  it('lets everything go when it is silenced', () => {
    const sink = new SpySink();
    const director = new AudioDirector(sink);
    const state = createSimState(1);
    state.police.units = [unit(3, 15, 0)];
    frame(director, state);
    sink.engines = [];
    director.silence();
    expect(sink.released).toEqual(['siren:3']);
    expect(sink.engines.at(-1)?.cue).toBeNull();
    expect(sink.ducked).toBe(0);
    // And nothing is let go twice.
    director.silence();
    expect(sink.released).toEqual(['siren:3']);
  });
});

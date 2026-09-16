/**
 * Render a made-up moment of the mix into a buffer and measure it.
 *
 * `docs/audio.md` says checking this directory by ear needs a browser. This is
 * that check, without the ear: each case drives the real `AudioPlanner` and the
 * real `Mixer` through an offline audio context and answers what came out — the
 * peak, the loudness, and how much of it was silence. A voice that was never
 * connected, an envelope that never opened and a gain left at zero all show up
 * as a case that should sound and does not.
 *
 * `scripts/audio-check.ts` is the driver and `scripts/audio-check.html` the
 * page it opens. Nothing in the game imports this.
 */
import { Offline } from 'tone';
import { EMPTY_INPUT, type InputFrame } from '../sim/input.ts';
import type { PoliceKind, PoliceUnit } from '../sim/police.ts';
import { createSimState, type SimState } from '../sim/simulation.ts';
import type { TramBell } from '../sim/tram.ts';
import { giveWeapon } from '../sim/weapon.ts';
import { Mixer } from './mixer.ts';
import { AudioPlanner, type BellSource } from './plan.ts';

/** What one case came to. */
export interface AudioLevel {
  name: string;
  /** The loudest sample of the render, 0 to 1. Over 1 is clipping. */
  peak: number;
  /** The loudness of the whole render, as a root mean square. */
  rms: number;
  /** The share of the render that was silence, 0 to 1. */
  quiet: number;
}

/** Seconds each case is rendered for. Long enough for the tail of an explosion. */
const SECONDS = 2;

/** Samples under this count as silence. */
const FLOOR = 1e-4;

/** One case: a record, what is being pressed, and what happens between two frames. */
interface AudioCase {
  name: string;
  state: () => SimState;
  input?: InputFrame;
  trams?: BellSource;
  /** What changes between the first frame and the second, which is what a one-shot is read from. */
  move?: (state: SimState) => void;
  /** Frames the case is driven for. More than two where a sound takes time to come round. */
  frames?: number;
}

function unit(id: number, kind: PoliceKind, x: number, y: number): PoliceUnit {
  return { id, kind, task: 'chase', x, y, heading: 0, height: 0, speed: 20, health: 100, edges: [], distance: 0, planned: 0, goalX: x, goalY: y };
}

/** A session driving a saloon at speed. */
function driving(): SimState {
  const state = createSimState(1234);
  state.player.driving = true;
  state.vehicle.speed = 22;
  return state;
}

/**
 * A session standing beside the car. Every case that is not about the engine
 * uses it, so what is measured is the one voice the case is named for.
 */
function afoot(): SimState {
  const state = createSimState(1234);
  state.player.driving = false;
  state.player.grounded = true;
  return state;
}

/** A line whose tram rings on every tick, which is what a bell sounds like at its loudest. */
const RINGING: BellSource = {
  bells: (_tick: number, out: TramBell[] = []) => {
    out.length = 0;
    out.push({ tram: 0, x: 4, y: 0 });
    return out;
  },
};

const CASES: readonly AudioCase[] = [
  { name: 'nothing', state: afoot },
  { name: 'engine idling', state: () => ({ ...driving(), vehicle: { ...driving().vehicle, speed: 0 } }) },
  { name: 'engine at speed', state: driving, input: { ...EMPTY_INPUT, throttle: 1 } },
  { name: 'horn', state: driving, input: { ...EMPTY_INPUT, horn: true } },
  {
    name: 'tyres sliding',
    state: () => {
      const state = driving();
      for (const wheel of state.vehicle.wheels) {
        wheel.contact = true;
        wheel.skid = true;
      }
      return state;
    },
  },
  {
    name: 'one siren',
    state: () => {
      const state = afoot();
      state.police.units = [unit(1, 'patrol', 20, 0)];
      return state;
    },
  },
  {
    name: 'three sirens',
    state: () => {
      const state = afoot();
      state.police.units = [unit(1, 'patrol', 20, 0), unit(2, 'interceptor', -25, 10), unit(3, 'swat', 40, 30)];
      return state;
    },
  },
  {
    name: 'gunshot',
    state: () => {
      const state = afoot();
      giveWeapon(state.loadout, 'ak-47');
      return state;
    },
    move: (state) => {
      state.loadout.shots += 1;
    },
  },
  {
    name: 'swing',
    state: afoot,
    move: (state) => {
      state.loadout.shots += 1;
    },
  },
  {
    name: 'collision',
    state: driving,
    move: (state) => {
      state.vehicle.damage.integrity -= 0.2;
    },
  },
  {
    name: 'explosion',
    state: driving,
    move: (state) => {
      state.vehicle.damage.blownTick = state.tick;
    },
  },
  {
    name: 'footstep',
    state: () => {
      const state = afoot();
      state.player.speed = 6;
      return state;
    },
    // A footfall is a distance walked, so the case walks until one comes round.
    frames: 20,
  },
  { name: 'tram bell', state: afoot, trams: RINGING, frames: 2 },
  {
    name: 'the lot at once',
    state: () => {
      const state = driving();
      giveWeapon(state.loadout, 'ak-47');
      state.police.units = [unit(1, 'patrol', 20, 0), unit(2, 'interceptor', -25, 10), unit(3, 'swat', 40, 30)];
      for (const wheel of state.vehicle.wheels) {
        wheel.contact = true;
        wheel.skid = true;
      }
      return state;
    },
    input: { ...EMPTY_INPUT, throttle: 1, horn: true },
    trams: RINGING,
    move: (state) => {
      state.loadout.shots += 3;
      state.vehicle.damage.integrity -= 0.3;
      state.vehicle.damage.blownTick = state.tick;
    },
  },
];

/** Render every case and answer what each one measured. */
export async function renderCases(): Promise<AudioLevel[]> {
  const out: AudioLevel[] = [];
  for (const test of CASES) {
    const state = test.state();
    const input = test.input ?? EMPTY_INPUT;
    const listener = { x: state.player.x, y: state.player.y };
    const buffer = await Offline(() => {
      const mixer = new Mixer();
      mixer.start();
      const planner = new AudioPlanner();
      // The first frame has nothing to compare against, so what a case is about
      // is made to happen between it and the next, as it does in play.
      mixer.apply(planner.plan(state, input, listener, test.trams), listener);
      for (let i = 1; i < (test.frames ?? 2); i++) {
        state.tick += 1;
        test.move?.(state);
        mixer.apply(planner.plan(state, input, listener, test.trams), listener);
      }
    }, SECONDS);
    out.push({ name: test.name, ...measure(buffer.getChannelData(0)) });
  }
  return out;
}

function measure(samples: Float32Array): Omit<AudioLevel, 'name'> {
  let peak = 0;
  let sum = 0;
  let silent = 0;
  for (const sample of samples) {
    const size = Math.abs(sample);
    if (size > peak) peak = size;
    if (size < FLOOR) silent += 1;
    sum += sample * sample;
  }
  const count = Math.max(1, samples.length);
  return { peak, rms: Math.sqrt(sum / count), quiet: silent / count };
}

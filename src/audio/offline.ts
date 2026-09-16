/**
 * Render the audio of a made-up moment into a buffer and measure it.
 *
 * A picture is how a rendering change is judged (`docs/dev-tooling.md`); this
 * is the same thing for sound, because nobody can hear a headless run. Each
 * case drives the real director and the real Tone.js voices through an offline
 * context and answers what came out: the peak, the loudness and how much of the
 * buffer was silent. A voice that was never connected, an option Tone.js does
 * not understand and a gain left at zero all show up as a silent case.
 *
 * `scripts/audio-check.ts` is the driver, `scripts/audio-check.html` the page.
 * Nothing in the game imports this.
 */
import { AudioDirector } from './director.ts';
import type { WorldSounds } from './cues.ts';
import { EMPTY_INPUT, type InputFrame } from '../sim/input.ts';
import { createSimState, type SimState } from '../sim/simulation.ts';
import type { PoliceKind, PoliceUnit } from '../sim/police.ts';
import { giveWeapon } from '../sim/weapon.ts';
import { ToneMixer } from './tone-mixer.ts';
import { ToneSink } from './tone-sink.ts';

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
const SECONDS = 1.5;

/** Samples under this count as silence. */
const FLOOR = 1e-4;

function unit(id: number, kind: PoliceKind, x: number, y: number): PoliceUnit {
  return { id, kind, task: 'chase', x, y, heading: 0, height: 0, speed: 20, health: 1, edges: [], distance: 0, planned: 0, goalX: x, goalY: y };
}

/** A session driving a saloon at speed, which is the case every other one is built from. */
function driving(): SimState {
  const state = createSimState(1);
  state.vehicle.speed = 22;
  state.vehicle.vx = 22;
  return state;
}

/**
 * A session standing beside the car. Every case that is not about the engine
 * uses it, so what is measured is the one voice the case is named for.
 */
function afoot(): SimState {
  const state = createSimState(1);
  state.player.driving = false;
  state.player.grounded = true;
  return state;
}

/** The cases, each a name and what the record and the input look like at that moment. */
const CASES: readonly {
  name: string;
  state: () => SimState;
  input?: InputFrame;
  world?: WorldSounds;
  /** What happens between the first frame and the second, which is where a one-shot comes from. */
  move?: (state: SimState) => void;
  /** Frames the case is driven for. More than two where a sound takes time to come round. */
  frames?: number;
}[] = [
  { name: 'nothing', state: afoot },
  { name: 'engine idling', state: () => createSimState(1) },
  { name: 'engine at speed', state: driving, input: { ...EMPTY_INPUT, throttle: 1 } },
  { name: 'horn', state: () => createSimState(1), input: { ...EMPTY_INPUT, horn: true } },
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
    name: 'helicopter',
    state: () => {
      const state = afoot();
      state.police.units = [unit(2, 'helicopter', 0, 40)];
      return state;
    },
  },
  {
    name: 'vehicle burning',
    state: () => {
      const state = afoot();
      state.vehicle.damage.stage = 'burning';
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
  { name: 'collision', state: driving, move: (state) => (state.vehicle.vx -= 14) },
  { name: 'explosion', state: driving, move: (state) => (state.vehicle.damage.blownTick = state.tick + 1) },
  {
    name: 'footstep',
    state: () => {
      const state = afoot();
      state.player.speed = 6;
      return state;
    },
    // A footfall is a distance walked, so the case walks until one comes round.
    frames: 12,
  },
  { name: 'tram bell', state: afoot, world: { bells: [{ x: 8, y: 0 }] } },
  {
    name: 'the lot at once',
    state: () => {
      const state = driving();
      giveWeapon(state.loadout, 'ak-47');
      state.police.units = [
        unit(1, 'patrol', 20, 0),
        unit(2, 'interceptor', -30, 10),
        unit(3, 'swat', 50, 40),
        unit(4, 'helicopter', 0, 60),
      ];
      state.vehicle.damage.stage = 'burning';
      for (const wheel of state.vehicle.wheels) {
        wheel.contact = true;
        wheel.skid = true;
      }
      return state;
    },
    input: { ...EMPTY_INPUT, throttle: 1, horn: true },
    world: { bells: [{ x: 8, y: 0 }] },
    move: (state) => {
      state.loadout.shots += 3;
      state.vehicle.vx -= 14;
    },
  },
];

/**
 * Render every case and answer what each one measured. The page hands this
 * Tone.js, because it is the page that is allowed to load it.
 */
export async function renderCases(tone: typeof import('tone')): Promise<AudioLevel[]> {
  const out: AudioLevel[] = [];
  for (const test of CASES) {
    const state = test.state();
    const input = test.input ?? EMPTY_INPUT;
    const world = test.world ?? { bells: [] };
    const buffer = await tone.Offline(() => {
      const sink = new ToneSink(new ToneMixer(tone, 1));
      const director = new AudioDirector(sink);
      const ear = { x: state.player.x, y: state.player.y };
      // The first frame has nothing to compare against, so the one-shots of a
      // case are made to happen between it and the second, as they are in play.
      director.update(state, input, ear, world);
      for (let i = 1; i < (test.frames ?? 2); i++) {
        state.tick += 1;
        test.move?.(state);
        director.update(state, input, ear, world);
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

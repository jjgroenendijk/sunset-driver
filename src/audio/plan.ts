/**
 * What the mixer should be doing this frame, read off the record (spec section
 * 15).
 *
 * This is the whole of the audio's thinking, and it is pure: it reads the
 * `SimState` the simulation wrote, the input frame the player pressed and where
 * the player is listening from, and answers a plan. It makes no sound, holds no
 * Web Audio node and imports nothing from Tone.js, so every rule below is
 * exercised headless in `test/audio.test.ts`. `mixer.ts` takes the plan and
 * plays it.
 *
 * Only the little that cannot be read off one tick is kept: what the shot
 * counter and the damage stood at last frame, so a change can be noticed, and
 * how far the player has walked since their last footfall. None of it steers
 * the simulation, and losing it costs at most one cue.
 *
 * The one-shots are capped per frame. A frame that steps many ticks — the first
 * frame after a stall — would otherwise fire a burst of every shot taken during
 * it, which is both wrong and the most expensive thing the mixer could be asked
 * to do.
 */
import { rngFor, Subsystem } from '../core/rng.ts';
import { TICK_RATE } from '../sim/clock.ts';
import type { InputFrame } from '../sim/input.ts';
import type { PoliceUnit } from '../sim/police.ts';
import type { SimState } from '../sim/simulation.ts';
import type { TramBell } from '../sim/tram.ts';
import { specOf } from '../sim/vehicle.ts';
import { currentWeapon, type WeaponSpec } from '../sim/weapon.ts';
import { CUES, type Cue } from './cue.ts';
import { enginePitch, engineSound, type EngineSound } from './engine.ts';
import { hear, type Heard, type Listener } from './space.ts';

/** Sirens the mix carries at once. The rest of a chase is heard through these. */
export const SIREN_VOICES = 3;

/** One-shots one frame may fire. A frame that wants more was a frame that stalled. */
export const CUES_PER_FRAME = 6;

/** Metres a stride covers, walking. The cadence is the speed divided by it. */
export const STRIDE = 1.5;

/** Metres per second under which a sliding tyre is not squealing yet. */
export const SQUEAL_SPEED = 3;

/** How far the integrity must fall in one frame to be worth a collision. */
export const IMPACT_MIN = 0.004;

/**
 * What the planner needs of the trams of spec section 13.2. `TramLine` is it;
 * the interface is what lets a test ring a bell without building a city.
 */
export interface BellSource {
  bells(tick: number, out?: TramBell[]): TramBell[];
}

/** How loud a tram's bell is, against the other one-shots. */
export const BELL_STRENGTH = 0.8;

/** Ticks one full siren wail takes, up and back down. */
export const WAIL_TICKS = 90;

/** How far the music bus is pulled down under a cue that ducks (spec section 15). */
export const DUCK_DEPTH = 0.65;

/** One siren in the mix. */
export interface SirenPlan {
  /** The unit it belongs to, so a voice follows one car rather than swapping between them. */
  id: number;
  gain: number;
  pan: number;
  /** Where the wail stands, 0 to 1 and round again. */
  wail: number;
}

/** Everything the mixer should be doing this frame. */
export interface AudioPlan {
  /** The player's own engine, or null while they are not in a vehicle. */
  engine: { sound: EngineSound; gain: number; pan: number; pitch: number } | null;
  /** How hard the tyres are sliding, 0 to 1. */
  squeal: number;
  /** The horn, 0 or 1: it is a button, not an axis. */
  horn: number;
  /** The sirens worth carrying, nearest first. */
  sirens: SirenPlan[];
  /** The one-shots to fire this frame. */
  cues: Cue[];
  /** How far the music bus is pulled down, 0 to 1. */
  duck: number;
}

/** A plan that asks for nothing, which is what a paused or muted session gets. */
export function silentPlan(): AudioPlan {
  return { engine: null, squeal: 0, horn: 0, sirens: [], cues: [], duck: 0 };
}

/**
 * The planner keeps what one frame has to remember about the last one. It is
 * created with the session and thrown away with it.
 */
export class AudioPlanner {
  /** The shot counter, the fuse and the integrity as they stood last frame. */
  private shots = -1;
  private blownTick = -1;
  private integrity = 1;
  /** Metres walked since the last footfall. */
  private stride = 0;
  /** The tick the last plan was made on, so the walk is measured over real ticks. */
  private tick = -1;
  /** Reused by the bells, so a frame allocates nothing for the ones that did not ring. */
  private readonly ringing: TramBell[] = [];

  /**
   * Take up the record as it stands without making a sound of it. A load, a
   * respawn and a metro trip all move the player and the damage somewhere else;
   * without this the frame after one is a collision and a volley of gunfire.
   */
  resync(state: SimState): void {
    this.shots = state.loadout.shots;
    this.blownTick = state.vehicle.damage.blownTick;
    this.integrity = state.vehicle.damage.integrity;
    this.stride = 0;
    this.tick = state.tick;
  }

  /**
   * What the mixer should be doing, given the record and where the player
   * listens from. `trams` is the tram line of spec section 13.2, where the
   * session has one: its bells are a function of the tick rather than part of
   * the record, so they are read here for every tick the frame stepped.
   */
  plan(state: SimState, input: InputFrame, listener: Listener, trams?: BellSource): AudioPlan {
    if (this.tick < 0) this.resync(state);
    const ticks = Math.max(0, Math.min(state.tick - this.tick, TICK_RATE));
    const was = state.tick - ticks;
    this.tick = state.tick;
    const cues: Cue[] = [];
    this.collisions(state, cues);
    this.gunfire(state, cues);
    this.footsteps(state, ticks, cues);
    this.bells(state, was, trams, cues);
    return {
      engine: this.engine(state, input, listener),
      squeal: squealOf(state),
      horn: input.horn && state.player.driving ? 1 : 0,
      sirens: sirensOf(state, listener),
      cues: cues.slice(0, CUES_PER_FRAME),
      duck: duckOf(cues),
    };
  }

  /** The player's own engine, where they are in something with one. */
  private engine(state: SimState, input: InputFrame, listener: Listener): AudioPlan['engine'] {
    if (!state.player.driving) return null;
    const spec = specOf(state.vehicle.cls);
    const sound = engineSound(spec, state.vehicle, input.throttle);
    if (!sound.running) return null;
    const heard = hear(listener, state.vehicle.x, state.vehicle.z);
    return { sound, gain: heard.gain, pan: heard.pan, pitch: enginePitch(spec.mass) };
  }

  /**
   * A collision, and the explosion at the end of a fuse. Both are read as a
   * change since the last frame: the integrity falling is the only mark a hit
   * leaves on the record, and it falls under gunfire as well as under a kerb,
   * which is the same crunch either way.
   */
  private collisions(state: SimState, cues: Cue[]): void {
    const damage = state.vehicle.damage;
    const lost = this.integrity - damage.integrity;
    this.integrity = damage.integrity;
    if (lost >= IMPACT_MIN) {
      cues.push(cueAt(state, 'impact', state.vehicle.x, state.vehicle.z, Math.min(1, lost * 6), 0));
    }
    if (damage.blownTick !== this.blownTick) {
      const blown = damage.blownTick >= 0 && this.blownTick < damage.blownTick;
      this.blownTick = damage.blownTick;
      if (blown) cues.push(cueAt(state, 'explosion', state.vehicle.x, state.vehicle.z, 1, 1));
    }
  }

  /** Every shot taken since the last frame, as one cue each up to the cap. */
  private gunfire(state: SimState, cues: Cue[]): void {
    const fired = state.loadout.shots - this.shots;
    this.shots = state.loadout.shots;
    if (fired <= 0) return;
    const spec = currentWeapon(state.loadout);
    const from = state.player.driving ? { x: state.vehicle.x, y: state.vehicle.z } : state.player;
    const kind: Cue['kind'] = spec.cls === 'melee' ? 'swing' : 'gunshot';
    for (let i = 0; i < Math.min(fired, CUES_PER_FRAME); i++) {
      cues.push(cueAt(state, kind, from.x, from.y, shotStrength(spec), this.shots - fired + i));
    }
  }

  /**
   * Footfalls, paced by the ground covered rather than by the clock, so a
   * sprint takes quicker steps of its own accord and standing still takes none.
   */
  private footsteps(state: SimState, ticks: number, cues: Cue[]): void {
    const player = state.player;
    if (player.driving || !player.grounded) {
      this.stride = 0;
      return;
    }
    this.stride += Math.abs(player.speed) * (ticks / TICK_RATE);
    if (this.stride < STRIDE) return;
    this.stride -= STRIDE;
    cues.push(cueAt(state, 'footstep', player.x, player.y, 1, state.tick));
  }

  /**
   * The trams that rang on any tick this frame stepped (spec section 13.2). A
   * bell is a function of the tick, so a frame that stepped two ticks has to
   * ask about both: asking only about the tick it landed on drops half the
   * bells of a session running at the frame rate the game is written for.
   */
  private bells(state: SimState, was: number, trams: BellSource | undefined, cues: Cue[]): void {
    if (trams === undefined) return;
    for (let tick = was + 1; tick <= state.tick; tick++) {
      for (const bell of trams.bells(tick, this.ringing)) {
        cues.push(cueAt(state, 'bell', bell.x, bell.y, BELL_STRENGTH, bell.tram));
      }
    }
  }
}

/** A cue with the jitter of the seed's own stream folded into its pitch. */
function cueAt(state: SimState, kind: Cue['kind'], x: number, y: number, strength: number, id: number): Cue {
  const rng = rngFor(state.seed, state.tick, Subsystem.Audio, id);
  return { kind, x, y, strength, pitch: rng.range(0.92, 1.08) };
}

/**
 * How loud a shot is, and how dark. A heavier round carries further and hits
 * lower, and a suppressor takes most of the crack off the front of it.
 */
export function shotStrength(spec: WeaponSpec): number {
  const weight = Math.min(1, spec.damage / 60);
  return (spec.suppressed ? 0.3 : 1) * (0.45 + 0.55 * weight);
}

/** How hard the tyres are sliding, as the share of wheels that have lost the road. */
export function squealOf(state: SimState): number {
  if (!state.player.driving) return 0;
  const wheels = state.vehicle.wheels;
  if (wheels.length === 0) return 0;
  const speed = Math.abs(state.vehicle.speed);
  if (speed < SQUEAL_SPEED) return 0;
  let sliding = 0;
  for (const wheel of wheels) if (wheel.skid && wheel.contact) sliding++;
  const reach = Math.min(1, (speed - SQUEAL_SPEED) / 8);
  return (sliding / wheels.length) * reach;
}

/**
 * The sirens worth carrying: the nearest {@link SIREN_VOICES} units that are
 * driving, which is every unit but the helicopter. Each wails on its own phase,
 * keyed on the unit's id, so a pair of cars beat against each other.
 */
export function sirensOf(state: SimState, listener: Listener): SirenPlan[] {
  const heard: { unit: PoliceUnit; at: Heard }[] = [];
  for (const unit of state.police.units) {
    if (unit.kind === 'helicopter') continue;
    const at = hear(listener, unit.x, unit.y);
    if (at.gain > 0) heard.push({ unit, at });
  }
  heard.sort((a, b) => a.at.distance - b.at.distance || a.unit.id - b.unit.id);
  return heard.slice(0, SIREN_VOICES).map(({ unit, at }) => ({
    id: unit.id,
    gain: at.gain,
    pan: at.pan,
    wail: ((((state.tick + unit.id * 37) % WAIL_TICKS) + WAIL_TICKS) % WAIL_TICKS) / WAIL_TICKS,
  }));
}

/** How far this frame's cues pull the music bus down. The table says which of them do. */
export function duckOf(cues: readonly Cue[]): number {
  let duck = 0;
  for (const cue of cues) {
    if (CUES[cue.kind].ducks) duck = Math.max(duck, DUCK_DEPTH * cue.strength);
  }
  return duck;
}

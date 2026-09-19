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
import { hashInts } from '../core/hash.ts';
import { rngFor, Subsystem } from '../core/rng.ts';
import { gameTime, TICK_RATE } from '../sim/clock.ts';
import type { InputFrame } from '../sim/input.ts';
import { onCall, type EmergencyKind, type EmergencyUnit } from '../sim/emergency.ts';
import type { PoliceUnit } from '../sim/police.ts';
import type { SimState } from '../sim/simulation.ts';
import type { TramBell } from '../sim/tram.ts';
import { specOf } from '../sim/vehicle.ts';
import { weatherAt } from '../sim/weather.ts';
import { currentWeapon, type WeaponSpec } from '../sim/weapon.ts';
import { HIT_CAP, type MeleeHit } from '../sim/melee.ts';
import {
  bedsFor,
  callsFor,
  CALL_FAR,
  CALL_NEAR,
  silentBeds,
  type BedPlan,
  type CallRates,
  type SiteSource,
} from './ambience.ts';
import { CUES, cueAt as cueOf, HIT_CUES, type Cue } from './cue.ts';
import type { Cry } from './cry.ts';
import { barSeconds, dialAt, dialName, wrapDial } from './dial.ts';
import { enginePitch, engineSound, type EngineSound } from './engine.ts';
import { CRIES_PER_FRAME, HurtEars } from './hurt.ts';
import { hearPolice } from './police-ears.ts';
import { broadcastAt, type OnAir } from './programme.ts';
import { scoreOf, type Score } from './score.ts';
import { hear, type Heard, type Listener } from './space.ts';
import type { Station } from './stations.ts';

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

/**
 * The streams the bird and the gull calls are drawn from. They are their own
 * entity ids, negative so no bird ever shares a stream with a shot, a tram or a
 * tick.
 */
const CALL_STREAM: Readonly<Record<'bird' | 'gull', number>> = Object.freeze({ bird: -1, gull: -2 });

/** The key of the stream a car's crunch is drawn from, so it is not the thump's note. */
const CRUNCH_STREAM = 0x0d05;

/**
 * How a siren sounds. A police car swaps between two notes; a fire engine's
 * wail sweeps slowly up and down, low; an ambulance's yelp sweeps fast. Each
 * service is known by ear before it is seen.
 */
export type SirenSound = 'two-tone' | 'wail' | 'yelp';

/** The sound, the ticks of one cycle and the pitch, as a multiple of the police car's, of each service's siren. */
export const SIREN_OF: Readonly<Record<'police' | EmergencyKind, { sound: SirenSound; ticks: number; pitch: number }>> = Object.freeze({
  police: { sound: 'two-tone', ticks: WAIL_TICKS, pitch: 1 },
  engine: { sound: 'wail', ticks: 240, pitch: 0.72 },
  ambulance: { sound: 'yelp', ticks: 22, pitch: 1.05 },
});

/**
 * Added to the id of a fire engine or an ambulance to key its siren, so a
 * voice following police car 3 is never handed ambulance 3.
 */
export const EMERGENCY_SIREN = 1 << 20;

/** One siren in the mix. */
export interface SirenPlan {
  /** The unit it belongs to, so a voice follows one car rather than swapping between them. */
  id: number;
  gain: number;
  pan: number;
  /** Where the wail stands, 0 to 1 and round again. */
  wail: number;
  sound: SirenSound;
  /** The pitch, as a multiple of the police car's. */
  pitch: number;
}

/**
 * The radio of spec section 15 this frame: where the dial stands, what is going
 * out on it, and the next bar the band should be handed.
 *
 * The bar is scheduled rather than played now, because music is played on the
 * audio clock and the record moves on the game's. `dial.ts` reads the bar off
 * the tick, so the two never drift.
 */
export interface RadioPlan {
  /** The seed of the session, which is what the station's songs are written from. */
  seed: number;
  /** Where the dial stands, unwrapped, so a change of station is noticed. */
  dial: number;
  /** The station it is on, or null: the dial is at Off, or nobody is at a wheel. */
  station: Station | null;
  /** What the HUD calls it, and the line under it while an ident or a PSA is out. */
  name: string;
  text: string;
  from: string;
  /** The bar to hand the band next, and how many seconds until it starts. */
  next: { song: number; bar: number; kind: OnAir; seconds: number } | null;
  /** How loud the radio is, which the score pulls down. */
  gain: number;
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
  /** The human cries to start this frame: the hurt, the dying and a fleeing crowd. */
  cries: Cry[];
  /** How far the music bus is pulled down, 0 to 1. */
  duck: number;
  /** The radio of spec section 15. */
  radio: RadioPlan;
  /** What the chase is doing to the music (spec section 15). */
  score: Score;
  /** The ambient beds of the place the player is standing in (spec section 15). */
  beds: BedPlan;
}

/** The radio of a session with the dial at Off, which is what silence looks like. */
export function silentRadio(): RadioPlan {
  return { seed: 0, dial: 0, station: null, name: '', text: '', from: '', next: null, gain: 0 };
}

/** A plan that asks for nothing, which is what a paused or muted session gets. */
export function silentPlan(): AudioPlan {
  return {
    engine: null,
    squeal: 0,
    horn: 0,
    sirens: [],
    cues: [],
    cries: [],
    duck: 0,
    radio: silentRadio(),
    score: { mood: 'calm', intensity: 0, radio: 1 },
    beds: silentBeds(),
  };
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
  /** The tick the last blow was heard on, so no blow is played twice. */
  private heard = -1;
  /** Reused by the bells, so a frame allocates nothing for the ones that did not ring. */
  private readonly ringing: TramBell[] = [];
  /** The cries and the thuds of the people hit (`hurt.ts`). */
  private readonly hurt = new HurtEars();

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
    this.heard = state.tick;
    this.hurt.resync(state);
  }

  /**
   * What the mixer should be doing, given the record and where the player
   * listens from. `trams` is the tram line of spec section 13.2, where the
   * session has one: its bells are a function of the tick rather than part of
   * the record, so they are read here for every tick the frame stepped.
   */
  plan(state: SimState, input: InputFrame, listener: Listener, trams?: BellSource, around?: SiteSource): AudioPlan {
    if (this.tick < 0) this.resync(state);
    const ticks = Math.max(0, Math.min(state.tick - this.tick, TICK_RATE));
    const was = state.tick - ticks;
    this.tick = state.tick;
    const cues: Cue[] = [];
    const cries: Cry[] = [];
    this.collisions(state, cues);
    this.gunfire(state, cues);
    hearPolice(state, was, cues, cries);
    this.blows(state, cues);
    this.hurt.hear(state, was, listener, cues, cries);
    this.footsteps(state, ticks, cues);
    this.bells(state, was, trams, cues);
    const score = scoreOf(state);
    // Where the player is standing, what the sky is doing and what hour it is:
    // the three the ambient beds of spec section 15 are read from. All of it is
    // a function of the record, so two machines on the same tick agree. A
    // session with no world is in no place, and a place is what a bed is.
    const site = around?.siteAt(listener.x, listener.y);
    let beds = silentBeds();
    if (site !== undefined) {
      const weather = weatherAt(state.seed, state.tick);
      const hour = gameTime(state.tick).dayFraction * 24;
      beds = bedsFor(site, weather, hour);
      // Last of the cues, so a frame at the cap drops a bird and not a gunshot.
      this.calls(state, was, listener, callsFor(site, weather, hour), cues);
    }
    return {
      engine: this.engine(state, input, listener),
      squeal: squealOf(state),
      horn: input.horn && state.player.driving ? 1 : 0,
      sirens: sirensOf(state, listener),
      cues: cues.slice(0, CUES_PER_FRAME),
      cries: cries.slice(0, CRIES_PER_FRAME),
      duck: duckOf(cues),
      radio: radioOf(state, score),
      score,
      beds,
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
   * Every blow a melee weapon landed since the last frame (spec section 11.6).
   * The record carries them for a few ticks (`src/sim/melee.ts`), so a frame
   * that stepped six ticks hears all six and a frame that stepped none hears
   * nothing twice. What was struck picks the cue: a body, a panel or a wall.
   */
  private blows(state: SimState, cues: Cue[]): void {
    const since = this.heard;
    this.heard = state.tick;
    for (let i = 0; i < state.hits.length; i++) {
      const hit = state.hits[i] as MeleeHit;
      if (hit.tick <= since || hit.tick > state.tick) continue;
      // Two blows of one swing land on the same tick, so the place in the list
      // is part of the stream they are jittered from: a swing through a crowd
      // is a run of knocks rather than one knock played twice.
      const id = hit.tick * HIT_CAP + i;
      if (hit.surface === 'person' && state.player.driving) {
        // Nobody swings from behind a wheel, so a person struck while the
        // player drives was struck by the car (`sim/car-strike.ts`): the thump
        // of a body, and the crunch of the bumper that took it.
        cues.push(cueAt(state, 'thump', hit.x, hit.y, hit.strength, id));
        cues.push(cueAt(state, 'crunch', hit.x, hit.y, hit.strength * 0.8, hashInts(CRUNCH_STREAM, id)));
        continue;
      }
      cues.push(cueAt(state, HIT_CUES[hit.surface], hit.x, hit.y, hit.strength, id));
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

  /**
   * The birds and the gulls of spec section 15. A call is drawn per tick rather
   * than per frame, over every tick the frame stepped, so how often one is
   * heard is the same on a machine drawing thirty frames a second and one
   * drawing a hundred and forty.
   *
   * Each call is placed on a ring around the listener rather than at a bird,
   * because there is no bird: the wildlife of spec section 20.4 has not landed,
   * and a call from somewhere over there is what the ear expects anyway.
   */
  private calls(state: SimState, was: number, listener: Listener, rates: CallRates, cues: Cue[]): void {
    for (let tick = was + 1; tick <= state.tick; tick++) {
      for (const kind of ['bird', 'gull'] as const) {
        const rate = rates[kind];
        if (rate <= 0) continue;
        const rng = rngFor(state.seed, tick, Subsystem.Audio, CALL_STREAM[kind]);
        if (!rng.chance(rate)) continue;
        const angle = rng.range(0, Math.PI * 2);
        const away = rng.range(CALL_NEAR, CALL_FAR);
        cues.push({
          kind,
          x: listener.x + Math.cos(angle) * away,
          y: listener.y + Math.sin(angle) * away,
          strength: rng.range(0.55, 1),
          pitch: rng.range(0.88, 1.14),
        });
      }
    }
  }
}

/** A cue of this tick, with the jitter of the seed's own stream folded into its pitch. */
function cueAt(state: SimState, kind: Cue['kind'], x: number, y: number, strength: number, id: number): Cue {
  return cueOf(state.seed, state.tick, kind, x, y, strength, id);
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
 * driving with the siren on. That is every police unit but the helicopter and a
 * car driving off once its call is over, and every fire engine and ambulance on
 * a call (spec section 20.3). Each wails on its own phase, keyed on the unit's
 * id, so a pair of cars beat against each other.
 */
export function sirensOf(state: SimState, listener: Listener): SirenPlan[] {
  const heard: { id: number; of: keyof typeof SIREN_OF; at: Heard }[] = [];
  for (const unit of state.police.units as readonly PoliceUnit[]) {
    if (unit.kind === 'helicopter' || unit.task === 'leave') continue;
    const at = hear(listener, unit.x, unit.y);
    if (at.gain > 0) heard.push({ id: unit.id, of: 'police', at });
  }
  for (const unit of state.emergency.units as readonly EmergencyUnit[]) {
    if (!onCall(unit)) continue;
    const at = hear(listener, unit.x, unit.y);
    if (at.gain > 0) heard.push({ id: EMERGENCY_SIREN + unit.id, of: unit.kind, at });
  }
  heard.sort((a, b) => a.at.distance - b.at.distance || a.id - b.id);
  return heard.slice(0, SIREN_VOICES).map(({ id, of, at }) => {
    const siren = SIREN_OF[of];
    const cycle = (((state.tick + id * 37) % siren.ticks) + siren.ticks) % siren.ticks;
    return { id, gain: at.gain, pan: at.pan, wail: cycle / siren.ticks, sound: siren.sound, pitch: siren.pitch };
  });
}

/**
 * The radio this frame (spec section 15). It plays for a player behind a wheel
 * and nobody else: a radio is a thing in a car, and a player on foot has left
 * it there.
 *
 * The score is what decides how loud it is. A chase pulls it down and a fight
 * takes it off, which is the "layered over or replacing" of the spec.
 */
export function radioOf(state: SimState, score: Score): RadioPlan {
  const dial = state.vehicle.station;
  const at = state.player.driving ? dialAt(state.seed, dial, state.tick) : null;
  if (at === null) return { ...silentRadio(), dial, name: dialName(dial) };
  const seconds = (1 - at.phase) * barSeconds(at.station);
  const ahead = broadcastOfNextBar(state.seed, dial, at.bar);
  return {
    seed: state.seed,
    dial,
    station: at.station,
    name: at.station.name,
    text: at.broadcast.text,
    from: at.broadcast.from,
    next: { song: ahead.song, bar: ahead.bar, kind: ahead.kind, seconds },
    gain: score.radio,
  };
}

/** What the bar after this one carries, which is the one the band is handed. */
function broadcastOfNextBar(seed: number, dial: number, bar: number): { song: number; bar: number; kind: OnAir } {
  const after = broadcastAt(seed, wrapDial(dial), bar + 1);
  return { song: after.song, bar: after.bar, kind: after.kind };
}

/** How far this frame's cues pull the music bus down. The table says which of them do. */
export function duckOf(cues: readonly Cue[]): number {
  let duck = 0;
  for (const cue of cues) {
    if (CUES[cue.kind].ducks) duck = Math.max(duck, DUCK_DEPTH * cue.strength);
  }
  return duck;
}

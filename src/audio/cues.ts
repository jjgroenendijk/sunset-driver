/**
 * What the record sounds like (spec section 15): one frame of the simulation
 * read as an engine note, the loops that hold and the sounds that start.
 *
 * Nothing here synthesises anything and nothing here writes to the record. It
 * is a pure reading of `SimState`, the way `src/render` is a pure drawing of
 * it, so what the game sounds like is tested headless and a replay of a session
 * sounds the way it did when it was played.
 *
 * A one-shot is found by comparing this frame's record against the last one:
 * the shots the player has fired, the speed their vehicle lost, the tick a
 * fire reached its fuse. {@link CueMemory} is that last frame, and it belongs
 * to the audio, not to the save.
 */
import { rngFor, Subsystem } from '../core/rng.ts';
import { TICK_RATE } from '../sim/clock.ts';
import { CRUSH_SPEED, IMPACT_FLOOR } from '../sim/damage.ts';
import type { InputFrame } from '../sim/input.ts';
import type { SimState } from '../sim/simulation.ts';
import { specOf, type VehicleClass } from '../sim/vehicle.ts';
import { currentWeapon } from '../sim/weapon.ts';
import type { WeaponClass } from '../sim/weapon.ts';
import { engineNote, type EngineNote } from './engine-model.ts';
import type { SoundKind } from './mix.ts';

/** The engine of the vehicle the player is driving, placed on the map. */
export interface EngineCue extends EngineNote {
  cls: VehicleClass;
  x: number;
  y: number;
}

/** A sound that holds until it is let go: a siren, a rotor, a squeal, a fire, a horn. */
export interface LoopCue {
  /** What the sink keys the voice on. A unit keeps its own siren across frames. */
  id: string;
  kind: SoundKind;
  x: number;
  y: number;
  strength: number;
}

/** A sound that starts on one tick and rings out on its own. */
export interface ShotCue {
  kind: SoundKind;
  x: number;
  y: number;
  strength: number;
  /** 0 to 1, from the seeded stream, so no two shots are quite the same. */
  variant: number;
}

/** One frame of the world as the ear hears it. */
export interface AudioScene {
  engine: EngineCue | null;
  loops: LoopCue[];
  shots: ShotCue[];
}

/** What the tram and the world outside the record ring on this tick. */
export interface WorldSounds {
  /** The trams pulling away from a halt (`TramLine.bells`). */
  bells: readonly { x: number; y: number }[];
}

export const NO_WORLD_SOUNDS: WorldSounds = { bells: [] };

/** The frame before this one, which is what a one-shot is found by. */
export interface CueMemory {
  /** The tick last read, or -1 before the first frame. */
  tick: number;
  /** Shots fired by the end of that tick (`LoadoutState.shots`). */
  shots: number;
  /** The player's vehicle velocity, so the speed it loses in a tick is an impact. */
  vx: number;
  vy: number;
  vz: number;
  /** The tick its fire went off on, or -1. */
  blownTick: number;
  /** Whether the player's feet were on the ground. */
  grounded: boolean;
  /** Metres walked since the last footstep. */
  stride: number;
  /** The respawns and metro trips taken, so a jump across the map is not a crash. */
  respawnTick: number;
  trips: number;
}

export function createCueMemory(): CueMemory {
  return { tick: -1, shots: 0, vx: 0, vy: 0, vz: 0, blownTick: -1, grounded: true, stride: 0, respawnTick: -1, trips: 0 };
}

/** How loud one pull of each class of weapon is (spec section 11.6). */
const WEAPON_LOUDNESS: Record<WeaponClass, number> = {
  melee: 0.35,
  pistol: 0.6,
  smg: 0.55,
  shotgun: 0.95,
  rifle: 0.75,
  precision: 0.85,
  heavy: 1,
  thrown: 0.3,
};

/** How much of a shot a suppressor leaves for the ear (spec section 11.6). */
const SUPPRESSED_LOUDNESS = 0.3;

/** Metres a walk covers between footfalls. A sprint covers it sooner, so it steps faster. */
const STRIDE = 0.9;

/** Metres per second of fall under which landing is a step rather than a thump. */
const SOFT_LANDING = 3;

/** Metres per second a tyre must be sliding at before it is heard (spec section 11.3). */
const SQUEAL_SPEED = 4;

/** Shots the ear is given from one frame, however many ticks it covers. */
const MAX_SHOTS_READ = 4;

/** How loud a burning vehicle and a tram bell are. */
const FIRE_STRENGTH = 0.6;
const BELL_STRENGTH = 0.7;

/**
 * Read one frame of the record. `memory` is carried from the frame before and
 * written back here; `input` is the frame the last tick was stepped with, which
 * is where the throttle and the horn come from.
 *
 * `out` is reused between frames so a frame allocates nothing.
 */
export function readScene(
  state: SimState,
  input: InputFrame,
  world: WorldSounds,
  memory: CueMemory,
  out: AudioScene = { engine: null, loops: [], shots: [] },
): AudioScene {
  out.engine = null;
  out.loops.length = 0;
  out.shots.length = 0;

  const ticks = state.tick - memory.tick;
  // A frame between two ticks has nothing new to start; the loops below still
  // follow what moved. A jump backwards is a load, which starts the ear again.
  const fresh = ticks > 0 && memory.tick >= 0;
  // A respawn and a metro trip both put the player down somewhere else (spec
  // sections 11.7, 13.3), so nothing that reads a change in place is believed
  // on that frame.
  const moved = (state.respawn?.tick ?? -1) !== memory.respawnTick || state.metro.trips !== memory.trips;

  const vehicle = state.vehicle;
  const spec = specOf(vehicle.cls);
  const at = { x: vehicle.x, y: vehicle.z };

  if (state.player.driving) {
    out.engine = { ...engineNote(spec, vehicle.speed, input.throttle), cls: vehicle.cls, x: at.x, y: at.y };
    if (input.horn) out.loops.push({ id: 'horn', kind: 'horn', x: at.x, y: at.y, strength: 1 });
  }

  const squeal = squealStrength(state);
  if (squeal > 0) out.loops.push({ id: 'squeal', kind: 'squeal', x: at.x, y: at.y, strength: squeal });
  if (vehicle.damage.stage === 'burning') {
    out.loops.push({ id: 'fire', kind: 'fire', x: at.x, y: at.y, strength: FIRE_STRENGTH });
  }

  // The police of spec section 14: every unit that is out is on its way to the
  // player, so every unit is heard. The helicopter is its rotor rather than a
  // siren, and it is heard from much further off.
  for (const unit of state.police.units) {
    const kind: SoundKind = unit.kind === 'helicopter' ? 'rotor' : 'siren';
    const strength = unit.task === 'search' ? 0.85 : 1;
    out.loops.push({ id: `${kind}:${unit.id}`, kind, x: unit.x, y: unit.y, strength });
  }

  if (fresh) {
    readShots(state, memory, out.shots);
    if (!moved) readImpact(state, memory, out.shots);
    readFootsteps(state, ticks, memory, out.shots);
    for (const bell of world.bells) {
      out.shots.push({ kind: 'bell', x: bell.x, y: bell.y, strength: BELL_STRENGTH, variant: 0 });
    }
  }
  if (vehicle.damage.blownTick !== memory.blownTick && vehicle.damage.blownTick >= 0) {
    out.shots.push({ kind: 'explosion', x: at.x, y: at.y, strength: 1, variant: 0 });
  }

  remember(state, memory);
  return out;
}

/** The shots the player has fired since the last frame (spec section 11.6). */
function readShots(state: SimState, memory: CueMemory, out: ShotCue[]): void {
  const fired = Math.min(MAX_SHOTS_READ, state.loadout.shots - memory.shots);
  if (fired <= 0) return;
  const spec = currentWeapon(state.loadout);
  const loud = WEAPON_LOUDNESS[spec.cls] * (spec.suppressed ? SUPPRESSED_LOUDNESS : 1);
  const kind: SoundKind = spec.cls === 'melee' ? 'melee' : 'gunshot';
  const from = state.player.driving ? { x: state.vehicle.x, y: state.vehicle.z } : state.player;
  for (let i = 0; i < fired; i++) {
    const rng = rngFor(state.seed, state.tick, Subsystem.Audio, memory.shots + i);
    out.push({ kind, x: from.x, y: from.y, strength: loud, variant: rng.float() });
  }
}

/**
 * The crash of spec section 11.3, read the way `damage.ts` reads it: the speed
 * the vehicle lost in the tick. Braking and a kerb fall well under the floor,
 * so nothing a driver does on their own is heard as a crash.
 */
function readImpact(state: SimState, memory: CueMemory, out: ShotCue[]): void {
  const v = state.vehicle;
  const lost = Math.hypot(v.vx - memory.vx, v.vy - memory.vy, v.vz - memory.vz);
  if (lost <= IMPACT_FLOOR) return;
  const rng = rngFor(state.seed, state.tick, Subsystem.Audio, 0);
  out.push({
    kind: 'impact',
    x: v.x,
    y: v.z,
    strength: Math.min(1, lost / CRUSH_SPEED),
    variant: rng.float(),
  });
}

/**
 * The player's own feet (spec section 11.5). A footfall is a distance walked
 * rather than a timer, so a sprint steps faster than a walk without a second
 * rule, and a player standing still makes none.
 */
function readFootsteps(state: SimState, ticks: number, memory: CueMemory, out: ShotCue[]): void {
  const player = state.player;
  if (player.driving) {
    memory.stride = 0;
    return;
  }
  if (!memory.grounded && player.grounded) {
    const fall = Math.abs(player.vy);
    out.push({
      kind: fall > SOFT_LANDING ? 'landing' : 'footstep',
      x: player.x,
      y: player.y,
      strength: Math.min(1, Math.max(0.4, fall / 12)),
      variant: 0,
    });
    memory.stride = 0;
    return;
  }
  if (!player.grounded) return;
  memory.stride += (Math.abs(player.speed) * ticks) / TICK_RATE;
  if (memory.stride < STRIDE) return;
  memory.stride -= STRIDE;
  const rng = rngFor(state.seed, state.tick, Subsystem.Audio, 1);
  out.push({ kind: 'footstep', x: player.x, y: player.y, strength: 0.5, variant: rng.float() });
}

/** How hard the tyres are sliding, 0 while they are rolling (spec section 11.3). */
function squealStrength(state: SimState): number {
  const v = state.vehicle;
  if (!state.player.driving || Math.abs(v.speed) < SQUEAL_SPEED) return 0;
  let sliding = 0;
  for (const wheel of v.wheels) {
    if (wheel.skid && wheel.contact) sliding += 1;
  }
  if (sliding === 0) return 0;
  const share = sliding / Math.max(1, v.wheels.length);
  return Math.min(1, share * Math.min(1, Math.abs(v.speed) / 20) * 1.6);
}

/** Keep this frame, so the next one can tell what changed. */
function remember(state: SimState, memory: CueMemory): void {
  const v = state.vehicle;
  memory.tick = state.tick;
  memory.shots = state.loadout.shots;
  memory.vx = v.vx;
  memory.vy = v.vy;
  memory.vz = v.vz;
  memory.blownTick = v.damage.blownTick;
  memory.grounded = state.player.grounded;
  memory.respawnTick = state.respawn?.tick ?? -1;
  memory.trips = state.metro.trips;
}

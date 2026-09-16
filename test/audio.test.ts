import { describe, expect, it } from 'vitest';
import { enginePitch, engineSound, gearAt, gearTop, GEARS, IDLE_REV } from '../src/audio/engine.ts';
import {
  AudioPlanner,
  CUES_PER_FRAME,
  duckOf,
  IMPACT_MIN,
  SIREN_VOICES,
  silentPlan,
  sirensOf,
  squealOf,
  STRIDE,
} from '../src/audio/plan.ts';
import { FAR, hear, NEAR, PAN_WIDTH, rolloff } from '../src/audio/space.ts';
import type { Cue } from '../src/audio/cue.ts';
import { TICK_RATE } from '../src/sim/clock.ts';
import { EMPTY_INPUT, type InputFrame } from '../src/sim/input.ts';
import type { PoliceKind, PoliceUnit } from '../src/sim/police.ts';
import type { TramBell } from '../src/sim/tram.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';
import { giveWeapon } from '../src/sim/weapon.ts';
import { specOf, type VehicleClass } from '../src/sim/vehicle.ts';

/**
 * The audio of spec section 15, as far as it can be read without a browser.
 * Everything here is the half of `src/audio` that holds no Tone.js: what the
 * engine is doing, what a sound at a place is worth, and which one-shots one
 * frame of the record asks for.
 */

/** A session standing still, on foot or driving, with nothing going on. */
function session(cls: VehicleClass = 'saloon'): SimState {
  const state = createSimState(1234);
  state.vehicle.cls = cls;
  state.player.driving = true;
  state.player.grounded = true;
  return state;
}

function input(over: Partial<InputFrame> = {}): InputFrame {
  return { ...EMPTY_INPUT, ...over };
}

/** A police unit standing at a point, of the kind named. */
function unit(id: number, x: number, y: number, kind: PoliceKind = 'patrol'): PoliceUnit {
  return {
    id,
    kind,
    task: 'chase',
    x,
    y,
    heading: 0,
    height: 0,
    speed: 10,
    health: 100,
    edges: [],
    distance: 0,
    planned: 0,
    goalX: x,
    goalY: y,
  };
}

describe('audio: where a sound stands', () => {
  it('is at full strength inside the near radius and nothing at the far one', () => {
    expect(rolloff(0)).toBeCloseTo(1, 6);
    expect(rolloff(NEAR)).toBeCloseTo(1, 6);
    expect(rolloff(FAR)).toBe(0);
    expect(rolloff(FAR + 10)).toBe(0);
  });

  it('falls away with the distance and is already silent where it is dropped', () => {
    expect(rolloff(20)).toBeLessThan(rolloff(10));
    expect(rolloff(FAR - 1)).toBeLessThan(0.01);
  });

  it('pans with the offset across the screen, not with the distance', () => {
    const listener = { x: 0, y: 0 };
    expect(hear(listener, PAN_WIDTH / 2, 0).pan).toBeCloseTo(0.5, 6);
    expect(hear(listener, -PAN_WIDTH * 4, 0).pan).toBe(-1);
    // A sound straight ahead is in the middle however far off it is.
    expect(hear(listener, 0, 80).pan).toBe(0);
    // The same offset is the same pan at any distance.
    expect(hear(listener, 5, 80).pan).toBeCloseTo(hear(listener, 5, 2).pan, 6);
  });
});

describe('audio: the engine', () => {
  it('idles at a standstill and reaches the redline at the top speed', () => {
    const spec = specOf('saloon');
    const state = session();
    expect(engineSound(spec, state.vehicle, 0).rev).toBeCloseTo(IDLE_REV, 6);
    state.vehicle.speed = spec.topSpeed;
    expect(engineSound(spec, state.vehicle, 1).rev).toBeCloseTo(1, 6);
  });

  it('drops the revs at a gear change and climbs again after it', () => {
    const spec = specOf('saloon');
    const state = session();
    const top = gearTop(spec, 0);
    state.vehicle.speed = top - 0.01;
    const before = engineSound(spec, state.vehicle, 1);
    state.vehicle.speed = top + 0.01;
    const after = engineSound(spec, state.vehicle, 1);
    expect(after.gear).toBe(before.gear + 1);
    expect(after.rev).toBeLessThan(before.rev);
    state.vehicle.speed = top * 1.5;
    expect(engineSound(spec, state.vehicle, 1).rev).toBeGreaterThan(after.rev);
  });

  it('spaces the box geometrically, ending at the top speed', () => {
    const spec = specOf('saloon');
    const gears = GEARS[spec.cls];
    const first = gearTop(spec, 1) / gearTop(spec, 0);
    for (let gear = 1; gear < gears; gear++) {
      // Every gear tops out above the one under it, by the same ratio: that is
      // what a ratio set is, and it is what makes each change sound alike.
      expect(gearTop(spec, gear)).toBeGreaterThan(gearTop(spec, gear - 1));
      expect(gearTop(spec, gear) / gearTop(spec, gear - 1)).toBeCloseTo(first, 6);
    }
    expect(gearTop(spec, gears - 1)).toBeCloseTo(spec.topSpeed, 6);
    expect(gearAt(spec, spec.topSpeed * 10)).toBe(gears - 1);
  });

  it('holds one gear in reverse and one on a boat', () => {
    const car = specOf('saloon');
    const state = session();
    state.vehicle.speed = -car.topSpeed * car.reverse;
    const back = engineSound(car, state.vehicle, 1);
    expect(back.gear).toBe(-1);
    expect(back.rev).toBeCloseTo(1, 6);
    const hull = specOf('boat');
    const boat = session('boat');
    boat.vehicle.speed = hull.topSpeed / 2;
    expect(engineSound(hull, boat.vehicle, 1).gear).toBe(0);
  });

  it('falls silent once the engine is dead, and only then', () => {
    const spec = specOf('saloon');
    const state = session();
    state.vehicle.damage.integrity = 0.01;
    expect(engineSound(spec, state.vehicle, 1).running).toBe(true);
    state.vehicle.damage.stage = 'burnt';
    expect(engineSound(spec, state.vehicle, 1).running).toBe(false);
  });

  it('pitches a heavy vehicle below a light one', () => {
    expect(enginePitch(specOf('truck').mass)).toBeLessThan(enginePitch(specOf('buggy').mass));
    expect(enginePitch(1)).toBeLessThanOrEqual(1.6);
    expect(enginePitch(1e9)).toBeGreaterThanOrEqual(0.6);
  });
});

describe('audio: the plan', () => {
  it('asks for nothing at all when it is told to be silent', () => {
    const plan = silentPlan();
    expect(plan.engine).toBeNull();
    expect(plan.cues).toEqual([]);
    expect(plan.duck).toBe(0);
  });

  it('carries the engine only while the player is in something', () => {
    const state = session();
    const planner = new AudioPlanner();
    expect(planner.plan(state, input(), state.player)?.engine).not.toBeNull();
    state.player.driving = false;
    expect(planner.plan(state, input(), state.player).engine).toBeNull();
  });

  it('fires one cue per shot taken since the last frame, up to the cap', () => {
    const state = session();
    giveWeapon(state.loadout, 'glock-17');
    const planner = new AudioPlanner();
    planner.plan(state, input(), state.player);
    state.loadout.shots += 3;
    const cues = planner.plan(state, input(), state.player).cues;
    expect(cues.filter((cue) => cue.kind === 'gunshot')).toHaveLength(3);
    // Nothing more is fired while the counter stands still.
    expect(planner.plan(state, input(), state.player).cues).toHaveLength(0);
    state.loadout.shots += 40;
    expect(planner.plan(state, input(), state.player).cues).toHaveLength(CUES_PER_FRAME);
  });

  it('swings a melee weapon rather than firing it', () => {
    const state = session();
    const planner = new AudioPlanner();
    planner.plan(state, input(), state.player);
    giveWeapon(state.loadout, 'baseball-bat');
    state.loadout.shots += 1;
    expect(planner.plan(state, input(), state.player).cues[0]?.kind).toBe('swing');
  });

  it('reads a collision off the integrity, and an explosion off the fuse', () => {
    const state = session();
    const planner = new AudioPlanner();
    planner.plan(state, input(), state.player);
    state.vehicle.damage.integrity -= IMPACT_MIN / 2;
    expect(planner.plan(state, input(), state.player).cues).toHaveLength(0);
    state.vehicle.damage.integrity -= 0.2;
    const hit = planner.plan(state, input(), state.player).cues;
    expect(hit).toHaveLength(1);
    expect(hit[0]?.kind).toBe('impact');
    state.vehicle.damage.blownTick = state.tick;
    const blast = planner.plan(state, input(), state.player).cues;
    expect(blast.map((cue) => cue.kind)).toContain('explosion');
  });

  it('paces footfalls by the ground covered, not by the clock', () => {
    const state = session();
    state.player.driving = false;
    state.player.speed = STRIDE;
    const planner = new AudioPlanner();
    planner.plan(state, input(), state.player);
    /** Steps taken over `seconds` of walking at the speed the record holds. */
    const walk = (seconds: number): number => {
      let steps = 0;
      for (let i = 0; i < seconds * TICK_RATE; i++) {
        state.tick += 1;
        steps += planner.plan(state, input(), state.player).cues.length;
      }
      return steps;
    };
    // Ten seconds of walking is the ground covered divided by the stride,
    // give or take the step that is halfway taken at either end.
    const slow = walk(10);
    expect(Math.abs(slow - (10 * STRIDE) / STRIDE)).toBeLessThanOrEqual(1);
    // Twice the speed is twice the cadence.
    state.player.speed = STRIDE * 2;
    const fast = walk(10);
    expect(Math.abs(fast - (10 * STRIDE * 2) / STRIDE)).toBeLessThanOrEqual(1);
  });

  it('takes no step while the feet are off the ground', () => {
    const state = session();
    state.player.driving = false;
    state.player.grounded = false;
    state.player.speed = 40;
    const planner = new AudioPlanner();
    planner.plan(state, input(), state.player);
    state.tick += TICK_RATE;
    expect(planner.plan(state, input(), state.player).cues).toHaveLength(0);
  });

  it('takes up a record that jumped without making a sound of it', () => {
    const state = session();
    const planner = new AudioPlanner();
    planner.plan(state, input(), state.player);
    state.loadout.shots += 9;
    state.vehicle.damage.integrity = 0.1;
    planner.resync(state);
    expect(planner.plan(state, input(), state.player).cues).toHaveLength(0);
  });

  it('sounds the horn only from behind a wheel', () => {
    const state = session();
    const planner = new AudioPlanner();
    expect(planner.plan(state, input({ horn: true }), state.player).horn).toBe(1);
    state.player.driving = false;
    expect(planner.plan(state, input({ horn: true }), state.player).horn).toBe(0);
  });

  it('squeals only where a tyre in contact is sliding above walking pace', () => {
    const state = session();
    state.vehicle.wheels = specOf('saloon').wheels.map(() => ({
      rotation: 0,
      steer: 0,
      suspension: 0,
      contact: true,
      skid: false,
    }));
    state.vehicle.speed = 20;
    expect(squealOf(state)).toBe(0);
    for (const wheel of state.vehicle.wheels) wheel.skid = true;
    expect(squealOf(state)).toBeGreaterThan(0);
    // A wheel in the air is not on a road to slide across.
    for (const wheel of state.vehicle.wheels) wheel.contact = false;
    expect(squealOf(state)).toBe(0);
    for (const wheel of state.vehicle.wheels) wheel.contact = true;
    state.vehicle.speed = 1;
    expect(squealOf(state)).toBe(0);
  });

  it('carries the nearest sirens, and never the helicopter', () => {
    const state = session();
    state.police.units = [
      unit(1, 60, 0),
      unit(2, 10, 0),
      unit(3, 30, 0),
      unit(4, 90, 0),
      unit(5, 1, 0, 'helicopter'),
    ];
    const sirens = sirensOf(state, { x: 0, y: 0 });
    expect(sirens).toHaveLength(SIREN_VOICES);
    expect(sirens.map((siren) => siren.id)).toEqual([2, 3, 1]);
    expect(sirens.every((siren) => siren.gain > 0)).toBe(true);
    // A unit past the reach is not worth a voice.
    state.police.units = [unit(6, FAR + 1, 0)];
    expect(sirensOf(state, { x: 0, y: 0 })).toHaveLength(0);
  });

  it('wails each unit on its own phase', () => {
    const state = session();
    state.police.units = [unit(1, 5, 0), unit(2, 6, 0)];
    const [a, b] = sirensOf(state, { x: 0, y: 0 });
    expect(a?.wail).not.toBe(b?.wail);
    expect(a?.wail).toBeGreaterThanOrEqual(0);
    expect(a?.wail).toBeLessThan(1);
  });

  it('ducks under a shot and not under a footstep', () => {
    const shot: Cue = { kind: 'gunshot', x: 0, y: 0, strength: 1, pitch: 1 };
    const step: Cue = { kind: 'footstep', x: 0, y: 0, strength: 1, pitch: 1 };
    expect(duckOf([step])).toBe(0);
    expect(duckOf([shot])).toBeGreaterThan(0);
    expect(duckOf([step, shot])).toBe(duckOf([shot]));
  });

  it('rings a tram bell on every tick the frame stepped, and none twice', () => {
    // A line whose trams ring on two ticks, which a frame of three ticks covers.
    const rung = [12, 14];
    const line = {
      bells: (tick: number, out: TramBell[] = []) => {
        out.length = 0;
        if (rung.includes(tick)) out.push({ tram: 0, x: 3, y: 4 });
        return out;
      },
    };
    const state = session();
    const planner = new AudioPlanner();
    state.tick = 10;
    planner.plan(state, input(), state.player, line);
    state.tick = 14;
    const bells = planner.plan(state, input(), state.player, line).cues.filter((cue) => cue.kind === 'bell');
    expect(bells).toHaveLength(2);
    expect(bells[0]).toMatchObject({ x: 3, y: 4 });
    // The same frame again rings nothing: those ticks are behind it now.
    expect(planner.plan(state, input(), state.player, line).cues).toEqual([]);
  });

  it('rings no bell where the session has no tram line', () => {
    const state = session();
    const planner = new AudioPlanner();
    planner.plan(state, input(), state.player);
    state.tick += 1;
    expect(planner.plan(state, input(), state.player).cues).toEqual([]);
  });

  it('gives the same cues for the same seed and tick', () => {
    const one = session();
    const two = session();
    const a = new AudioPlanner();
    const b = new AudioPlanner();
    a.plan(one, input(), one.player);
    b.plan(two, input(), two.player);
    one.loadout.shots += 2;
    two.loadout.shots += 2;
    expect(a.plan(one, input(), one.player).cues).toEqual(b.plan(two, input(), two.player).cues);
  });
});

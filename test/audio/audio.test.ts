import { describe, expect, it } from 'vitest';
import { enginePitch, engineSound, gearAt, gearTop, GEARS, IDLE_REV } from '../../src/audio/engine.ts';
import {
  AudioPlanner,
  CUES_PER_FRAME,
  duckOf,
  EMERGENCY_SIREN,
  IMPACT_MIN,
  SIREN_VOICES,
  silentPlan,
  sirensOf,
  squealOf,
  STRIDE,
} from '../../src/audio/plan.ts';
import { bedsFor, callsFor, chorusAt, silentBeds, sunUp, townAwake, type Site } from '../../src/audio/ambience.ts';
import { builtOf, greenOf, shoreNearness, SURF_FAR, SURF_NEAR } from '../../src/audio/site.ts';
import { FAR, hear, NEAR, PAN_WIDTH, rolloff } from '../../src/audio/space.ts';
import type { Cue } from '../../src/audio/cue.ts';
import { TICK_RATE, TICKS_PER_HOUR } from '../../src/sim/clock.ts';
import { CLEAR_WEATHER, weatherAt, type Weather } from '../../src/sim/city/weather.ts';
import { EMPTY_INPUT, type InputFrame } from '../../src/sim/input.ts';
import type { EmergencyUnit } from '../../src/sim/city/emergency.ts';
import type { PoliceKind, PoliceUnit } from '../../src/sim/police/police.ts';
import type { TramBell } from '../../src/sim/transit/tram.ts';
import { createSimState, type SimState } from '../../src/sim/simulation.ts';
import { giveWeapon } from '../../src/sim/weapons/weapon.ts';
import { specOf, type VehicleClass } from '../../src/sim/vehicles/vehicle.ts';

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
    crew: 2,
    doors: 0,
    doorTick: -1_000_000,
    fired: -1_000_000,
    incident: -1,
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

  it('carries the sirens of the fire engines and ambulances on a call, each in a sound of its own', () => {
    const state = session();
    const service = (id: number, kind: EmergencyUnit['kind'], x: number, task: EmergencyUnit['task']): EmergencyUnit => ({
      id, kind, task, call: 0, x, y: 0, heading: 0, height: 0, speed: 0, edges: [], distance: 0, stop: 0,
      planned: 0, goalX: 0, goalY: 0, homeX: 0, homeY: 0, until: -1, doors: 0, deployed: false,
    });
    state.police.units = [unit(0, 20, 0)];
    state.emergency.units = [service(0, 'engine', 10, 'respond'), service(1, 'ambulance', 5, 'work'), service(2, 'engine', 2, 'leave')];
    const sirens = sirensOf(state, { x: 0, y: 0 });
    // The engine on its way home has its siren off; the rest are heard, nearest first.
    expect(sirens.map((siren) => siren.sound)).toEqual(['yelp', 'wail', 'two-tone']);
    // A police car and an ambulance that share an id are two voices, not one.
    expect(sirens.map((siren) => siren.id)).toEqual([EMERGENCY_SIREN + 1, EMERGENCY_SIREN, 0]);
    expect(sirens[1]?.pitch).toBeLessThan(sirens[2]?.pitch ?? 0);
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

  it('rumbles under the nearest tram, and squeals where it is bending at speed', () => {
    const noise = { x: 0, y: 0, speed: 0, bend: 0 };
    const at = (speed: number, bend: number, away: number) => ({
      bells: (_tick: number, out: TramBell[] = []) => {
        out.length = 0;
        return out;
      },
      nearestNoise: (_x: number, _y: number, _time: number, out: typeof noise) => {
        out.x = away;
        out.y = 0;
        out.speed = speed;
        out.bend = bend;
        return out;
      },
    });
    const state = session();
    const planner = new AudioPlanner();
    const running = planner.plan(state, input(), state.player, at(10, 0.9, 8)).tram;
    expect(running).not.toBeNull();
    expect((running as NonNullable<typeof running>).rumble).toBeGreaterThan(0.5);
    expect((running as NonNullable<typeof running>).squeal).toBeGreaterThan(0.3);
    // A tram at a stand makes no noise, however near it is standing.
    state.tick += 1;
    expect(planner.plan(state, input(), state.player, at(0, 1, 2)).tram).toBeNull();
    // Nor does one on straight rail squeal, however fast it is running.
    state.tick += 1;
    const straight = planner.plan(state, input(), state.player, at(12, 0, 8)).tram;
    expect((straight as NonNullable<typeof straight>).squeal).toBe(0);
    // A tram right across the city is not worth a voice.
    state.tick += 1;
    expect(planner.plan(state, input(), state.player, at(12, 1, 4000)).tram).toBeNull();
  });

  it('asks a line with no running noise for none, and hears nothing', () => {
    const state = session();
    const planner = new AudioPlanner();
    const quiet = { bells: (_tick: number, out: TramBell[] = []) => ((out.length = 0), out) };
    expect(planner.plan(state, input(), state.player, quiet).tram).toBeNull();
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

/** The three places the beds are read against: the core, the sand, and the country. */
const DOWNTOWN: Site = { built: 1, green: 0.05, shore: 0 };
const BEACH: Site = { built: 0.2, green: 0.2, shore: 1 };
const COUNTRY: Site = { built: 0.02, green: 1, shore: 0 };

/** The weather of one kind at its full strength, for a bed that is about the sky. */
function weather(over: Partial<Weather> = {}): Weather {
  return { ...CLEAR_WEATHER, ...over };
}

/** The first tick at `hour` on any of the first days the seed keeps dry. */
function dryHour(seed: number, hour: number): number {
  for (let day = 0; day < 7; day++) {
    const tick = (day * 24 + hour) * TICKS_PER_HOUR;
    if (weatherAt(seed, tick).rain < 0.05) return tick;
  }
  return hour * TICKS_PER_HOUR;
}

describe('audio: the ambient beds', () => {
  it('changes audibly between downtown and the beach, which is what the bed is for', () => {
    const city = bedsFor(DOWNTOWN, weather(), 12);
    const sand = bedsFor(BEACH, weather(), 12);
    expect(city.traffic).toBeGreaterThan(sand.traffic + 0.3);
    expect(sand.surf).toBeGreaterThan(city.surf + 0.3);
    expect(city.surf).toBe(0);
  });

  it('thins the hum in the small hours and brings it back by the working day', () => {
    const night = bedsFor(DOWNTOWN, weather(), 4);
    const day = bedsFor(DOWNTOWN, weather(), 12);
    expect(night.traffic).toBeGreaterThan(0);
    expect(night.traffic).toBeLessThan(day.traffic * 0.6);
  });

  it('takes the traffic off the road in weather that clears the streets', () => {
    const fair = bedsFor(DOWNTOWN, weather(), 12);
    const foul = bedsFor(DOWNTOWN, weather({ kind: 'storm', crowd: 0.32 }), 12);
    expect(foul.traffic).toBeLessThan(fair.traffic);
  });

  it('carries the wind in the open and shelters the streets from it', () => {
    const gale = weather({ kind: 'storm', wind: 1 });
    expect(bedsFor(COUNTRY, gale, 12).wind).toBeGreaterThan(bedsFor(DOWNTOWN, gale, 12).wind);
    // A still day is a still bed wherever it is heard.
    expect(bedsFor(COUNTRY, weather({ wind: 0 }), 12).wind).toBe(0);
  });

  it('rings the rain on metal in the city and not in a field', () => {
    const wet = weather({ kind: 'rain', rain: 0.8 });
    expect(bedsFor(DOWNTOWN, wet, 12).rain).toBeCloseTo(bedsFor(COUNTRY, wet, 12).rain, 6);
    expect(bedsFor(DOWNTOWN, wet, 12).metal).toBeGreaterThan(bedsFor(COUNTRY, wet, 12).metal * 3);
    expect(bedsFor(DOWNTOWN, weather(), 12).rain).toBe(0);
  });

  it('asks for nothing where the session has no world', () => {
    expect(silentBeds()).toEqual({ traffic: 0, surf: 0, wind: 0, rain: 0, metal: 0 });
  });

  it('keeps every bed inside the 0 to 1 a gain is allowed', () => {
    const storm = weather({ kind: 'storm', rain: 1, wind: 1, crowd: 1 });
    for (const site of [DOWNTOWN, BEACH, COUNTRY, { built: 1, green: 1, shore: 1 }]) {
      for (const hour of [0, 6, 12, 18, 23.9]) {
        for (const sky of [weather(), storm]) {
          for (const gain of Object.values(bedsFor(site, sky, hour))) {
            expect(gain).toBeGreaterThanOrEqual(0);
            expect(gain).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});

describe('audio: birds and gulls', () => {
  it('sings in the country by day, loudest at dawn, and not at night', () => {
    expect(callsFor(COUNTRY, weather(), 6).bird).toBeGreaterThan(callsFor(COUNTRY, weather(), 14).bird);
    expect(callsFor(COUNTRY, weather(), 1).bird).toBe(0);
    expect(callsFor(DOWNTOWN, weather(), 6).bird).toBeLessThan(callsFor(COUNTRY, weather(), 6).bird * 0.2);
  });

  it('cries over the sand and nowhere else', () => {
    expect(callsFor(BEACH, weather(), 12).gull).toBeGreaterThan(0);
    expect(callsFor(COUNTRY, weather(), 12).gull).toBe(0);
    // A gull is about at first light as well, where a songbird has stopped.
    expect(callsFor(BEACH, weather(), 2).gull).toBeGreaterThan(0);
  });

  it('shelters from the rain, as the crowd does', () => {
    const wet = weather({ kind: 'rain', rain: 1 });
    expect(callsFor(COUNTRY, wet, 6).bird).toBe(0);
    expect(callsFor(BEACH, wet, 12).gull).toBe(0);
  });

  it('keeps the day curves inside 0 and 1', () => {
    for (let hour = 0; hour < 24; hour += 0.5) {
      for (const curve of [sunUp(hour), townAwake(hour), chorusAt(hour)]) {
        expect(curve).toBeGreaterThanOrEqual(0);
        expect(curve).toBeLessThanOrEqual(1);
      }
    }
    expect(sunUp(12)).toBeCloseTo(1, 6);
    expect(sunUp(0)).toBe(0);
  });
});

describe('audio: the place the planner reads', () => {
  it('hums where the world says the player is downtown, and is silent without one', () => {
    const state = session();
    state.tick = dryHour(state.seed, 12);
    const planner = new AudioPlanner();
    const beds = planner.plan(state, input(), state.player, undefined, { siteAt: () => DOWNTOWN }).beds;
    expect(beds.traffic).toBeGreaterThan(0.3);
    expect(new AudioPlanner().plan(state, input(), state.player).beds).toEqual(silentBeds());
  });

  it('calls a bird over the ticks a frame stepped, and none in the core at night', () => {
    const state = session();
    state.player.driving = false;
    const planner = new AudioPlanner();
    const country = { siteAt: () => COUNTRY };
    state.tick = dryHour(state.seed, 6);
    planner.plan(state, input(), state.player, undefined, country);
    let birds = 0;
    // Ten frames of a second each: a call is a few a minute, so a couple of
    // frames would say nothing either way.
    for (let frame = 0; frame < 10; frame++) {
      state.tick += TICK_RATE;
      birds += planner.plan(state, input(), state.player, undefined, country).cues.filter((c) => c.kind === 'bird').length;
    }
    expect(birds).toBeGreaterThan(0);

    const night = session();
    night.player.driving = false;
    night.tick = dryHour(night.seed, 1);
    const quiet = new AudioPlanner();
    quiet.plan(night, input(), night.player, undefined, { siteAt: () => DOWNTOWN });
    for (let frame = 0; frame < 10; frame++) {
      night.tick += TICK_RATE;
      const cues = quiet.plan(night, input(), night.player, undefined, { siteAt: () => DOWNTOWN }).cues;
      expect(cues.filter((c) => c.kind === 'bird' || c.kind === 'gull')).toEqual([]);
    }
  });
});

describe('audio: the ground a site is read off', () => {
  it('reads the core as built and the wilderness as green', () => {
    expect(builtOf('core', 1)).toBeGreaterThan(builtOf('suburban', 1));
    expect(builtOf('suburban', 1)).toBeGreaterThan(builtOf('wilderness', 1));
    expect(greenOf('wilderness', 0)).toBeGreaterThan(greenOf('core', 0));
    // A denser district is more built up and less green, whatever its zone.
    expect(builtOf('suburban', 1)).toBeGreaterThan(builtOf('suburban', 0));
    expect(greenOf('suburban', 1)).toBeLessThan(greenOf('suburban', 0));
  });

  it('hears the surf at the waterline and not from inland', () => {
    expect(shoreNearness(0)).toBe(1);
    expect(shoreNearness(SURF_NEAR)).toBe(1);
    expect(shoreNearness(SURF_FAR)).toBe(0);
    expect(shoreNearness(Infinity)).toBe(0);
    expect(shoreNearness(SURF_FAR / 2)).toBeGreaterThan(0);
    expect(shoreNearness(SURF_FAR / 2)).toBeLessThan(1);
  });
});

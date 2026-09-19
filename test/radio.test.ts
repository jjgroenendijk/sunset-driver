import { describe, expect, it } from 'vitest';
import { barSeconds, barTicks, dialAt, dialName, DIAL_POSITIONS, tunedTo, wrapDial } from '../src/audio/dial.ts';
import { AudioPlanner, radioOf } from '../src/audio/plan.ts';
import { BLOCK_BARS, BREAK_BARS, broadcastAt, PSA_EVERY } from '../src/audio/programme.ts';
import { PSAS } from '../src/audio/psa.ts';
import { CLOSE, COMBAT_STARS, RADIO_UNDER, scoreOf } from '../src/audio/score.ts';
import { barOf, SONG_BARS } from '../src/audio/song.ts';
import { chordOf, MODES, STATIONS, stationOfCulture, STEPS } from '../src/audio/stations.ts';
import { TICK_RATE } from '../src/sim/clock.ts';
import { EMPTY_INPUT, type InputFrame } from '../src/sim/input.ts';
import type { PoliceKind, PoliceUnit } from '../src/sim/police.ts';
import { stepRadio } from '../src/sim/radio.ts';
import { createSave, restoreSimState, saveFromText, saveToText } from '../src/sim/save.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';
import type { Culture } from '../src/world/types.ts';

/**
 * The radio of spec section 15 and the announcements of spec section 19, as far
 * as they can be read without a browser: what is on the dial, what a station
 * plays, what it puts out between songs, and what a chase does to it.
 */

/** The cultures spec section 8.3 names, which every station table has to cover. */
const CULTURES: readonly Culture[] = [
  'italian',
  'chinese',
  'east-european',
  'latin',
  'african-american',
  'outlaw',
  'irish',
  'beach',
];

/** A player at the wheel with the radio tuned to the first station. A new car's radio is Off. */
function session(): SimState {
  const state = createSimState(4321);
  state.player.driving = true;
  state.vehicle.station = 0;
  return state;
}

function input(over: Partial<InputFrame> = {}): InputFrame {
  return { ...EMPTY_INPUT, ...over };
}

function unit(id: number, x: number, y: number, kind: PoliceKind = 'patrol'): PoliceUnit {
  return { id, kind, task: 'chase', x, y, heading: 0, height: 0, speed: 10, health: 100, edges: [], distance: 0, planned: 0, goalX: x, goalY: y, crew: 2 };
}

describe('the dial', () => {
  it('has a station for every culture of the city, and one over the lot', () => {
    for (const culture of CULTURES) {
      expect(stationOfCulture(culture), culture).toBeGreaterThanOrEqual(0);
    }
    expect(stationOfCulture('none')).toBe(0);
  });

  it('gives every station its own name', () => {
    const names = new Set(STATIONS.map((station) => station.name));
    expect(names.size).toBe(STATIONS.length);
  });

  it('wraps round the stations and one position of Off', () => {
    expect(DIAL_POSITIONS).toBe(STATIONS.length + 1);
    expect(wrapDial(0)).toBe(0);
    expect(tunedTo(0)).toBe(STATIONS[0]);
    // One step back from the first station is Off, as a car radio's dial is.
    expect(tunedTo(-1)).toBeNull();
    expect(dialName(-1)).toBe('Radio off');
    expect(wrapDial(DIAL_POSITIONS * 3 + 2)).toBe(2);
    expect(wrapDial(-DIAL_POSITIONS - 1)).toBe(DIAL_POSITIONS - 1);
  });

  it('starts on Off, so a car is silent until the dial is turned', () => {
    const state = createSimState(4321);
    expect(tunedTo(state.vehicle.station)).toBeNull();
    stepRadio(state, input({ station: 1 }));
    expect(tunedTo(state.vehicle.station)).toBe(STATIONS[0]);
  });

  it('is turned only from behind a wheel, and one station per press', () => {
    const state = session();
    const off = state.vehicle.station;
    stepRadio(state, input({ station: 1 }));
    expect(state.vehicle.station).toBe(off + 1);
    stepRadio(state, input({ station: -1 }));
    expect(state.vehicle.station).toBe(off);
    // Nothing on the frames between two presses.
    stepRadio(state, input());
    expect(state.vehicle.station).toBe(off);
    state.player.driving = false;
    stepRadio(state, input({ station: 1 }));
    expect(state.vehicle.station).toBe(off);
  });

  it('is carried by a save, so a car is found on the station it was left on', () => {
    const state = session();
    state.vehicle.station = 3;
    const save = saveFromText(saveToText(createSave('4321', state)));
    const loaded = createSimState(state.seed);
    restoreSimState(loaded, save);
    expect(loaded.vehicle.station).toBe(3);
  });

  it('keeps every station running whether or not anybody is listening', () => {
    const seed = 99;
    const station = STATIONS[2];
    const length = barTicks(station!);
    // The bar is a function of the tick alone, so tuning away and back finds
    // the station where it would have been.
    expect(dialAt(seed, 2, 0)?.bar).toBe(0);
    expect(dialAt(seed, 2, Math.ceil(length * 4))?.bar).toBe(4);
    expect(dialAt(seed, 2, Math.ceil(length * 4))?.broadcast).toEqual(broadcastAt(seed, 2, 4));
    expect(barSeconds(station!)).toBeCloseTo((60 / station!.tempo) * 4, 6);
    expect(barTicks(station!)).toBeCloseTo(barSeconds(station!) * TICK_RATE, 6);
  });
});

describe('what a station plays', () => {
  it('gives the same bar of the same song every time', () => {
    const station = STATIONS[0];
    const a = barOf(7, station!, 3, 5);
    const b = barOf(7, station!, 3, 5);
    expect(a).toEqual(b);
    expect(barOf(8, station!, 3, 5)).not.toEqual(a);
  });

  it('lays the drums where the station’s feel says', () => {
    for (const station of STATIONS) {
      const bar = barOf(1, station, 0, 0);
      const kicks = bar.filter((note) => note.part === 'kick').map((note) => Math.floor(note.step));
      expect(kicks, station.name).toEqual([...station.drums.kick]);
      const snares = bar.filter((note) => note.part === 'snare').map((note) => Math.floor(note.step));
      expect(snares, station.name).toEqual([...station.drums.snare]);
    }
  });

  it('keeps every note inside the station’s own mode', () => {
    for (const station of STATIONS) {
      const scale = MODES[station.mode];
      for (let bar = 0; bar < 8; bar++) {
        for (const note of barOf(5, station, 1, bar)) {
          if (note.part === 'kick' || note.part === 'snare' || note.part === 'hat') continue;
          const degree = (((note.note - station.key) % 12) + 12) % 12;
          expect(scale.includes(degree as never), `${station.name} ${note.part} ${note.note}`).toBe(true);
        }
      }
    }
  });

  it('plays inside the bar, and never harder than a note can be struck', () => {
    for (const station of STATIONS) {
      for (const note of barOf(2, station, 0, 3)) {
        expect(note.step).toBeGreaterThanOrEqual(0);
        expect(note.step).toBeLessThan(STEPS);
        expect(note.velocity).toBeGreaterThan(0);
        expect(note.velocity).toBeLessThanOrEqual(1);
        expect(note.length).toBeGreaterThan(0);
      }
    }
  });

  it('builds a chord of three notes of the mode', () => {
    for (const station of STATIONS) {
      const chord = chordOf(station, 0);
      expect(chord).toHaveLength(3);
      expect(chord[0]).toBe(0);
      expect(chord[2]).toBeGreaterThan(chord[1] as number);
    }
  });
});

describe('what goes out between songs', () => {
  it('plays a song, then a break, and round again', () => {
    expect(broadcastAt(1, 0, 0).kind).toBe('song');
    expect(broadcastAt(1, 0, SONG_BARS - 1).kind).toBe('song');
    expect(broadcastAt(1, 0, SONG_BARS).kind).not.toBe('song');
    expect(broadcastAt(1, 0, BLOCK_BARS).kind).toBe('song');
    expect(BLOCK_BARS).toBe(SONG_BARS + BREAK_BARS);
  });

  it('reads an announcement every few songs and the station’s own ident otherwise', () => {
    const kinds: string[] = [];
    for (let block = 0; block < PSA_EVERY * 3; block++) {
      kinds.push(broadcastAt(1, 0, block * BLOCK_BARS + SONG_BARS).kind);
    }
    expect(kinds.filter((kind) => kind === 'psa')).toHaveLength(3);
    expect(kinds.filter((kind) => kind === 'ident')).toHaveLength(PSA_EVERY * 3 - 3);
  });

  it('says nothing over a song, and names the station over an ident', () => {
    expect(broadcastAt(1, 0, 4).text).toBe('');
    const ident = broadcastAt(1, 0, SONG_BARS);
    expect(ident.text).toContain(STATIONS[0]?.name as string);
  });

  it('reads the harm-reduction lines of spec section 19, and credits them', () => {
    const lines = new Set<string>();
    for (let block = 0; block < 60; block++) {
      const out = broadcastAt(3, 1, block * BLOCK_BARS + SONG_BARS);
      if (out.kind === 'psa') {
        lines.add(out.text);
        expect(out.from).not.toBe('');
      }
    }
    expect(lines.size).toBeGreaterThan(3);
    for (const line of lines) expect(PSAS.some((psa) => psa.line === line)).toBe(true);
  });
});

describe('the score over the radio', () => {
  it('leaves the radio alone while nothing is happening', () => {
    const state = session();
    const score = scoreOf(state);
    expect(score.mood).toBe('calm');
    expect(score.radio).toBe(RADIO_UNDER.calm);
    expect(score.intensity).toBe(0);
  });

  it('lays a chase over the radio and pulls it down', () => {
    const state = session();
    state.heat = 2;
    state.police.units = [unit(1, 120, 0)];
    const score = scoreOf(state);
    expect(score.mood).toBe('pursuit');
    expect(score.radio).toBeLessThan(1);
    expect(score.intensity).toBeGreaterThan(0);
  });

  it('takes the radio off altogether once a unit is on top of the player at high heat', () => {
    const state = session();
    state.heat = COMBAT_STARS + 0.5;
    state.police.units = [unit(1, CLOSE / 2, 0)];
    const score = scoreOf(state);
    expect(score.mood).toBe('combat');
    expect(score.radio).toBe(0);
    expect(score.intensity).toBeGreaterThan(0.5);
  });

  it('is a chase and not a fight while the units are still a way off', () => {
    const state = session();
    state.heat = COMBAT_STARS + 0.5;
    state.police.units = [unit(1, CLOSE * 3, 0)];
    expect(scoreOf(state).mood).toBe('pursuit');
  });

  it('says nothing while the heat is up but nobody has come out', () => {
    const state = session();
    state.heat = 3;
    expect(scoreOf(state).mood).toBe('calm');
  });
});

describe('the radio in the plan', () => {
  it('plays for a player behind a wheel and not for one on foot', () => {
    const state = session();
    const plan = radioOf(state, scoreOf(state));
    expect(plan.station).toBe(STATIONS[0]);
    expect(plan.name).toBe(STATIONS[0]?.name);
    state.player.driving = false;
    expect(radioOf(state, scoreOf(state)).station).toBeNull();
  });

  it('goes quiet at the Off position of the dial', () => {
    const state = session();
    state.vehicle.station = -1;
    const plan = radioOf(state, scoreOf(state));
    expect(plan.station).toBeNull();
    expect(plan.name).toBe('Radio off');
  });

  it('hands the band the next bar, no further off than one bar', () => {
    const state = session();
    const plan = radioOf(state, scoreOf(state));
    expect(plan.next).not.toBeNull();
    expect(plan.next?.seconds).toBeGreaterThan(0);
    expect(plan.next?.seconds).toBeLessThanOrEqual(barSeconds(STATIONS[0] as never));
    // The bar handed over is the one after the bar now playing.
    const now = dialAt(state.seed, state.vehicle.station, state.tick);
    expect(plan.next?.bar).toBe(broadcastAt(state.seed, 0, (now?.bar ?? 0) + 1).bar);
  });

  it('is pulled down by a chase and off by a fight', () => {
    const state = session();
    state.heat = 2;
    state.police.units = [unit(1, 100, 0)];
    expect(radioOf(state, scoreOf(state)).gain).toBe(RADIO_UNDER.pursuit);
    state.heat = COMBAT_STARS + 1;
    state.police.units = [unit(1, 5, 0)];
    expect(radioOf(state, scoreOf(state)).gain).toBe(0);
  });

  it('comes out of the planner with the rest of the frame', () => {
    const state = session();
    const planner = new AudioPlanner();
    const plan = planner.plan(state, input(), state.player);
    expect(plan.radio.station).toBe(STATIONS[0]);
    expect(plan.score.mood).toBe('calm');
  });
});

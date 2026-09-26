import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_INPUT, type InputFrame } from '../../src/sim/input.ts';
import {
  ARRIVAL_TICKS,
  ENTRANCE_REACH,
  FADE_TICKS,
  TRAVEL_TICKS,
  travelFade,
  travelRefusal,
  type MetroPlace,
} from '../../src/sim/transit/metro.ts';
import { initPhysics, type Ground } from '../../src/sim/physics/physics.ts';
import { drive, hills, start, type Session } from '../support/sim-harness.ts';

/** Three stations on the hillside: two a short walk apart and one across the map. */
const STATIONS: readonly MetroPlace[] = [
  { x: 0, y: 0, heading: 0, name: 'Harbour' },
  { x: 60, y: 0, heading: 1, name: 'Old Town' },
  { x: -420, y: 380, heading: 2, name: 'Pine Ridge' },
];

function served(): Ground {
  return { ...hills(), metro: STATIONS };
}

/** Put the player on foot at a station entrance and let the tick see them there. */
function stand(session: Session, station: number, input: Partial<InputFrame> = {}): void {
  const place = STATIONS[station] as MetroPlace;
  session.state.player.driving = false;
  session.state.player.x = place.x;
  session.state.player.y = place.y;
  session.physics.stand(session.state);
  drive(session, 1, input);
}

/**
 * The metro of spec section 13.3, played in the Rapier loop: the stations a
 * player has visited, the trip between two of them, and the two things that
 * refuse one.
 */
describe('metro fast travel', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('visits a station the player walks up to, and no other', () => {
    const session = start(served());
    expect(session.state.metro.visited).toEqual([]);
    stand(session, 1);
    expect(session.state.metro.visited).toEqual([1]);
    stand(session, 0);
    expect(session.state.metro.visited).toEqual([0, 1]);
    // Standing at the same station again is not a second visit.
    stand(session, 0);
    expect(session.state.metro.visited).toEqual([0, 1]);
    session.physics.dispose();
  });

  it('leaves a station the player only drives past unvisited', () => {
    const session = start(served());
    const place = STATIONS[0] as MetroPlace;
    session.state.player.x = place.x;
    session.state.player.y = place.y;
    drive(session, 1);
    expect(session.state.player.driving).toBe(true);
    expect(session.state.metro.visited).toEqual([]);
    session.physics.dispose();
  });

  it('travels between two visited stations over a fade, and does not skip the tick', () => {
    const session = start(served());
    const { state } = session;
    stand(session, 2);
    stand(session, 0);
    const far = STATIONS[2] as MetroPlace;
    const started = state.tick;
    // The first place in the list of destinations, which is station 2: the only
    // other one visited.
    drive(session, 1, { travel: 1 });
    expect(state.metro.travel?.to).toBe(2);
    // The player is still at the near station while the screen fades.
    drive(session, FADE_TICKS - 2);
    expect(Math.hypot(state.player.x, state.player.y)).toBeLessThan(ENTRANCE_REACH);
    expect(travelFade(state, state.tick)).toBeGreaterThan(0.5);

    drive(session, ARRIVAL_TICKS + 2);
    expect(Math.hypot(state.player.x - far.x, state.player.y - far.y)).toBeLessThan(ENTRANCE_REACH);
    expect(state.player.heading).toBeCloseTo(far.heading, 5);
    expect(state.metro.trips).toBe(1);
    // A trip is ticks of the simulation like any others: the clock ran every
    // one of them (spec section 13.3).
    expect(state.tick - started).toBe(FADE_TICKS + ARRIVAL_TICKS + 1);
    expect(state.metro.travel).toBeNull();
    expect(travelFade(state, state.tick)).toBe(0);
    session.physics.dispose();
  });

  it('holds the player still under the fade', () => {
    const session = start(served());
    const { state } = session;
    stand(session, 2);
    stand(session, 0);
    drive(session, 1, { travel: 1 });
    // Walking keys pressed during the trip move nothing: the input frame the
    // physics is stepped with is empty.
    drive(session, FADE_TICKS - 2, { throttle: 1, steer: 1, sprint: true });
    expect(Math.hypot(state.player.x, state.player.y)).toBeLessThan(ENTRANCE_REACH);
    session.physics.dispose();
  });

  it('refuses a trip to a station the player has not visited', () => {
    const session = start(served());
    const { state } = session;
    stand(session, 0);
    drive(session, 1, { travel: 1 });
    expect(state.metro.travel).toBeNull();
    session.physics.dispose();
  });

  it('refuses a trip with heat or in a vehicle', () => {
    const session = start(served());
    const { state } = session;
    stand(session, 2);
    stand(session, 0);
    state.heat = 1;
    expect(travelRefusal(state)).toBe('Not while the police want you.');
    drive(session, 1, { travel: 1 });
    expect(state.metro.travel).toBeNull();

    state.heat = 0;
    state.player.driving = true;
    expect(travelRefusal(state)).toBe('Not with a vehicle.');
    drive(session, 1, { travel: 1 });
    expect(state.metro.travel).toBeNull();
    session.physics.dispose();
  });

  it('replays a recorded trip exactly', () => {
    // The destination is a number in the input frame, so a stream recorded off
    // the panel takes the same trip when it is played back.
    const inputs: InputFrame[] = [{ ...EMPTY_INPUT, travel: 1 }];
    for (let i = 0; i < TRAVEL_TICKS + 2; i++) inputs.push({ ...EMPTY_INPUT, throttle: 1 });
    const ends = [0, 1].map(() => {
      const session = start(served());
      stand(session, 2);
      stand(session, 0);
      for (const frame of inputs) drive(session, 1, frame);
      const { x, y, heading } = session.state.player;
      session.physics.dispose();
      return { x, y, heading, trips: session.state.metro.trips };
    });
    expect(ends[0]).toEqual(ends[1]);
  });
});

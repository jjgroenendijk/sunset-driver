import { describe, expect, it } from 'vitest';
import { contourAt, CRIES, cryCurve, cryLength, cryOf, muffleOf, voiceOf } from '../src/audio/cry.ts';
import { CRIES_PER_FRAME, FALL_STRENGTH, hitCry, landingOf, PANIC_VOICES } from '../src/audio/hurt.ts';
import { AudioPlanner, type AudioPlan } from '../src/audio/plan.ts';
import { FAR } from '../src/audio/space.ts';
import { casualtyPose, emptyCasualtyPose, FALL_TICKS, type Casualty } from '../src/sim/casualty-motion.ts';
import { TICK_RATE } from '../src/sim/clock.ts';
import { EMPTY_INPUT } from '../src/sim/input.ts';
import type { StartledPedestrian } from '../src/sim/pedestrians.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';

/**
 * What hurting people sounds like (`src/audio/hurt.ts` and `cry.ts`), as far
 * as it can be read without a browser: which cries and thuds a frame of the
 * record asks for, and the pitch a cry is played at.
 */

const LISTENER = { x: 0, y: 0 };

function session(): SimState {
  const state = createSimState(1234);
  state.player.driving = false;
  state.player.grounded = true;
  state.tick = 1000;
  return state;
}

/** A person hit on `since`, standing a few metres off. */
function casualty(id: number, since: number, over: Partial<Casualty> = {}): Casualty {
  return {
    id,
    since,
    first: since,
    cause: 'shot',
    health: 50,
    x: 6,
    y: 2,
    height: 0,
    rest: 0,
    heading: 0,
    dir: 0,
    push: 1,
    lift: 0,
    reach: 30,
    down: 4 * TICK_RATE,
    side: 1,
    cash: 0,
    gone: false,
    bumped: -1,
    ragdoll: null,
    ...over,
  };
}

function fled(id: number, since: number, x = 10, y = 0): StartledPedestrian {
  return { id, reaction: 'flee', since, x, y, height: 0, heading: 0 };
}

/** Plan the next frame, one tick on, after `move` has changed the record. */
function step(planner: AudioPlanner, state: SimState, move?: (state: SimState) => void): AudioPlan {
  state.tick += 1;
  move?.(state);
  return planner.plan(state, EMPTY_INPUT, LISTENER);
}

function started(state: SimState): AudioPlanner {
  const planner = new AudioPlanner();
  planner.plan(state, EMPTY_INPUT, LISTENER);
  return planner;
}

describe('audio: the cries of the hurt', () => {
  it('screams once at a new hit, and not again on the next frame', () => {
    const state = session();
    const planner = started(state);
    const first = step(planner, state, (s) => s.pedestrians.casualties.push(casualty(3, s.tick)));
    expect(first.cries.map((c) => c.kind)).toEqual(['scream']);
    expect(step(planner, state).cries.filter((c) => c.kind !== 'moan')).toEqual([]);
  });

  it('cries again when the record is replaced by a new hit', () => {
    const state = session();
    const planner = started(state);
    step(planner, state, (s) => s.pedestrians.casualties.push(casualty(3, s.tick)));
    const again = step(planner, state, (s) => {
      s.pedestrians.casualties[0] = casualty(3, s.tick, { health: 20 });
    });
    expect(again.cries.map((c) => c.kind)).toEqual(['scream']);
  });

  it('gives the dying a short cry, a stagger a cry of pain, and a body nothing', () => {
    expect(hitCry(casualty(1, 0, { health: 0, down: -1 }))).toBe('death');
    expect(hitCry(casualty(1, 0, { down: 0 }))).toBe('pain');
    expect(hitCry(casualty(1, 0))).toBe('scream');
    expect(cryLength(cryOf(1, 0, 'death', 1, 0, 0, 1))).toBeLessThan(cryLength(cryOf(1, 0, 'scream', 1, 0, 0, 1)));
    expect(CRIES.death.cut).toBe(true);

    const state = session();
    state.pedestrians.casualties.push(casualty(3, state.tick - 50, { health: 0, down: -1 }));
    const planner = started(state);
    const hitAgain = step(planner, state, (s) => {
      s.pedestrians.casualties[0] = casualty(3, s.tick, { health: 0, down: -1 });
    });
    expect(hitAgain.cries).toEqual([]);
  });

  it('keeps one voice per person, and voices the crowd both low and high', () => {
    expect(voiceOf(1234, 7)).toEqual(voiceOf(1234, 7));
    const bases = Array.from({ length: 200 }, (_, id) => voiceOf(1234, id).base);
    expect(Math.min(...bases)).toBeLessThan(150);
    expect(Math.max(...bases)).toBeGreaterThan(175);
  });

  it('strains a scream well above speech, peaks early, and wobbles the same on a replay', () => {
    const cry = cryOf(1234, 50, 'scream', 9, 0, 0, 1);
    const curve = cryCurve(cry);
    expect(curve).toEqual(cryCurve(cryOf(1234, 50, 'scream', 9, 0, 0, 1)));
    expect(curve.length).toBeGreaterThan(50);
    const peak = curve.indexOf(Math.max(...curve)) / curve.length;
    expect(peak).toBeLessThan(0.5);
    expect(Math.min(...curve)).toBeGreaterThan(cry.voice.base * 1.5);
    expect(contourAt(CRIES.scream, 0)).toBeCloseTo(CRIES.scream.start);
    expect(contourAt(CRIES.scream, 1)).toBeCloseTo(CRIES.scream.end);
  });

  it('dulls a cry with the distance', () => {
    expect(muffleOf(FAR)).toBeLessThan(muffleOf(5));
    expect(muffleOf(5, CRIES.panic.clear)).toBeLessThan(muffleOf(5));
  });

  it('cries out in a fleeing crowd with a few voices, a moment apart', () => {
    const state = session();
    const planner = started(state);
    const plan = step(planner, state, (s) => {
      s.pedestrians.startled = [1, 2, 3, 4, 5, 6].map((id) => fled(id, s.tick, 8 + id, 0));
    });
    const panic = plan.cries.filter((c) => c.kind === 'panic');
    expect(panic).toHaveLength(PANIC_VOICES);
    expect(new Set(panic.map((c) => c.delay)).size).toBe(PANIC_VOICES);
    expect(plan.cries.length).toBeLessThanOrEqual(CRIES_PER_FRAME);
    expect(step(planner, state).cries).toEqual([]);
  });

  it('leaves two people running, or a crowd out of earshot, quiet', () => {
    const state = session();
    const planner = started(state);
    const two = step(planner, state, (s) => {
      s.pedestrians.startled = [fled(1, s.tick), fled(2, s.tick)];
    });
    expect(two.cries).toEqual([]);
    const far = step(planner, state, (s) => {
      s.pedestrians.startled = [1, 2, 3, 4].map((id) => fled(id + 10, s.tick, 200, 0));
    });
    expect(far.cries).toEqual([]);
  });
});

describe('audio: bodies struck and falling', () => {
  it('thumps and crunches a person struck by the car, and thuds one struck by a fist', () => {
    const state = session();
    state.player.driving = true;
    const planner = started(state);
    const car = step(planner, state, (s) => {
      s.hits.push({ tick: s.tick, x: 4, y: 0, h: 1, surface: 'person', strength: 0.8 });
    });
    expect(car.cues.map((c) => c.kind)).toEqual(['thump', 'crunch']);
    expect(car.cues[0]?.strength).toBe(0.8);

    state.player.driving = false;
    const fist = step(planner, state, (s) => {
      s.hits.push({ tick: s.tick, x: 1, y: 0, h: 1, surface: 'person', strength: 0.5 });
    });
    expect(fist.cues.map((c) => c.kind)).toEqual(['thud']);
  });

  it('slaps once where a round went into somebody, and nowhere a round missed', () => {
    const state = session();
    const planner = started(state);
    const round = { pellet: 0, x: 0, y: 0, h: 1, ex: 5, ey: 0, eh: 1, by: 'player' as const };
    const plan = step(planner, state, (s) => {
      s.tracers.push({ ...round, tick: s.tick, end: 'person' }, { ...round, tick: s.tick, end: 'hard' });
    });
    expect(plan.cues.map((c) => c.kind)).toEqual(['flesh']);
    expect(step(planner, state).cues).toEqual([]);
  });

  it('lands a thrown body on the tick its throw ends, where it lands', () => {
    const state = session();
    const planner = started(state);
    const hit = casualty(4, state.tick + 1, { cause: 'car', lift: 3, push: 9 });
    const landing = landingOf(hit);
    expect(landing).not.toBeNull();
    const tick = landing?.tick ?? 0;
    const pose = emptyCasualtyPose();
    expect(casualtyPose(hit, tick - 1, pose).phase).toBe('air');
    expect(casualtyPose(hit, tick, pose).phase).not.toBe('air');

    step(planner, state, (s) => s.pedestrians.casualties.push(hit));
    const heard: number[] = [];
    while (state.tick < tick + 30) {
      const plan = step(planner, state);
      if (plan.cues.some((c) => c.kind === 'landing')) heard.push(state.tick);
    }
    expect(heard).toEqual([tick]);
  });

  it('lands the same tick on a frame that steps several ticks at once', () => {
    const state = session();
    const planner = started(state);
    const hit = casualty(4, state.tick + 1, { cause: 'car', lift: 3, push: 9 });
    state.tick += 1;
    state.pedestrians.casualties.push(hit);
    planner.plan(state, EMPTY_INPUT, LISTENER);
    state.tick = (landingOf(hit)?.tick ?? 0) + 3;
    const plan = planner.plan(state, EMPTY_INPUT, LISTENER);
    expect(plan.cues.filter((c) => c.kind === 'landing')).toHaveLength(1);
  });

  it('lands a fall from standing more softly, at the end of the fall, and a stagger not at all', () => {
    const fall = landingOf(casualty(1, 100));
    expect(fall).toEqual({ tick: 100 + FALL_TICKS, strength: FALL_STRENGTH });
    const thrown = landingOf(casualty(1, 100, { lift: 4, push: 10 }));
    expect(thrown?.strength).toBeGreaterThan(FALL_STRENGTH);
    expect(landingOf(casualty(1, 100, { down: 0 }))).toBeNull();
  });

  it('plans the same cues and cries on a replay', () => {
    const run = (): AudioPlan[] => {
      const state = session();
      state.player.driving = true;
      const planner = started(state);
      const plans: AudioPlan[] = [];
      plans.push(
        step(planner, state, (s) => {
          s.hits.push({ tick: s.tick, x: 4, y: 0, h: 1, surface: 'person', strength: 1 });
          s.pedestrians.casualties.push(casualty(2, s.tick, { cause: 'car', lift: 4, push: 14, health: 0, down: -1 }));
          s.pedestrians.startled = [5, 6, 7, 8].map((id) => fled(id, s.tick, 12, id));
        }),
      );
      for (let i = 0; i < 4 * TICK_RATE; i++) plans.push(step(planner, state));
      return plans;
    };
    const a = run();
    expect(a).toEqual(run());
    expect(a.some((p) => p.cues.some((c) => c.kind === 'landing'))).toBe(true);
    expect(a[0]?.cries.map((c) => c.kind)).toContain('death');
  });

  it('lets the wounded on the ground moan now and then, and never the dead', () => {
    const state = session();
    state.pedestrians.casualties.push(
      casualty(1, state.tick, { down: -1, health: 10 }),
      casualty(2, state.tick, { down: -1, health: 0, x: -6 }),
    );
    const planner = started(state);
    let moans = 0;
    for (let i = 0; i < 60 * TICK_RATE; i++) {
      const plan = step(planner, state);
      for (const cry of plan.cries) {
        expect(cry.kind).toBe('moan');
        expect(cry.x).toBeGreaterThan(0);
        moans++;
      }
    }
    expect(moans).toBeGreaterThan(3);
    expect(moans).toBeLessThan(30);
  });
});

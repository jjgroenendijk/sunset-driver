import { describe, expect, it } from 'vitest';
import {
  attenuation,
  duckFor,
  loudest,
  mixAt,
  NEAR,
  PAN_WIDTH,
  REACH,
  SHOTS_PER_FRAME,
  VOICE_CAP,
} from '../src/audio/mix.ts';
import { ENGINES, engineNote, firingHz, gearAt } from '../src/audio/engine-model.ts';
import { specOf } from '../src/sim/vehicle.ts';

/** Spec section 15: how far a sound carries, and where it sits across the stereo field. */
describe('the mix', () => {
  it('holds a sound at full gain within the near radius and takes it to nothing at its reach', () => {
    expect(attenuation(0, 100)).toBe(1);
    expect(attenuation(NEAR, 100)).toBe(1);
    expect(attenuation(100, 100)).toBe(0);
    expect(attenuation(400, 100)).toBe(0);
  });

  it('falls with the distance between them', () => {
    const near = attenuation(20, 200);
    const far = attenuation(80, 200);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });

  it('pans by where a sound stands on the map, and never all the way over', () => {
    expect(mixAt({ x: 0, y: 0 }, { kind: 'gunshot', x: 30, y: 0, strength: 1 }).pan).toBeCloseTo(PAN_WIDTH, 5);
    expect(mixAt({ x: 0, y: 0 }, { kind: 'gunshot', x: -30, y: 0, strength: 1 }).pan).toBeCloseTo(-PAN_WIDTH, 5);
    // Straight up the screen from the player is straight ahead, so it is in the middle.
    expect(mixAt({ x: 0, y: 0 }, { kind: 'gunshot', x: 0, y: -30, strength: 1 }).pan).toBeCloseTo(0, 5);
  });

  it('scales the gain by how hard the sound was made', () => {
    const loud = mixAt({ x: 0, y: 0 }, { kind: 'impact', x: 0, y: 0, strength: 1 });
    const soft = mixAt({ x: 0, y: 0 }, { kind: 'impact', x: 0, y: 0, strength: 0.25 });
    expect(loud.gain).toBe(1);
    expect(soft.gain).toBe(0.25);
  });

  it('gives a siren and an explosion further reach than a footstep', () => {
    expect(REACH.explosion).toBeGreaterThan(REACH.siren);
    expect(REACH.siren).toBeGreaterThan(REACH.engine);
    expect(REACH.engine).toBeGreaterThan(REACH.footstep);
  });

  it('ducks the bed by the loudest key event and not by their sum', () => {
    const quiet = duckFor([{ kind: 'siren', gain: 0.5 }]);
    const loud = duckFor([
      { kind: 'siren', gain: 0.5 },
      { kind: 'explosion', gain: 1 },
    ]);
    expect(loud).toBeGreaterThan(quiet);
    expect(loud).toBeLessThanOrEqual(1);
    // An engine is not a key event, however loud it is.
    expect(duckFor([{ kind: 'engine', gain: 1 }])).toBe(0);
  });

  it('keeps the loudest voices within the budget and drops the rest', () => {
    const many = Array.from({ length: VOICE_CAP + 8 }, (_, i) => ({ gain: (i + 1) / 40 }));
    const kept = loudest(many, VOICE_CAP);
    expect(kept).toHaveLength(VOICE_CAP);
    expect(kept[0]?.gain).toBeCloseTo(many[many.length - 1]?.gain as number, 5);
    expect(loudest([{ gain: 0 }, { gain: 0.5 }], SHOTS_PER_FRAME)).toEqual([{ gain: 0.5 }]);
  });
});

/** Spec section 15: the engine modelled from the revolutions, the load and the class. */
describe('the engine note', () => {
  const saloon = specOf('saloon');

  it('idles when the vehicle stands still, and a blip of the throttle lifts it', () => {
    const idle = engineNote(saloon, 0, 0);
    expect(idle.rpm).toBe(ENGINES.saloon.idle);
    expect(engineNote(saloon, 0, 1).rpm).toBeGreaterThan(idle.rpm);
  });

  it('climbs with the speed inside a gear and drops back at the change', () => {
    const gears = ENGINES.saloon.gears;
    const topOfFirst = engineNote(saloon, saloon.topSpeed * (gears[0] as number) * 0.99, 1);
    const intoSecond = engineNote(saloon, saloon.topSpeed * (gears[0] as number) * 1.05, 1);
    expect(topOfFirst.gear).toBe(0);
    expect(intoSecond.gear).toBe(1);
    expect(intoSecond.rpm).toBeLessThan(topOfFirst.rpm);
  });

  it('never leaves the range between the idle and the redline', () => {
    for (let speed = 0; speed <= saloon.topSpeed; speed += 1) {
      const note = engineNote(saloon, speed, 1);
      expect(note.rpm).toBeGreaterThanOrEqual(ENGINES.saloon.idle);
      expect(note.rpm).toBeLessThanOrEqual(ENGINES.saloon.redline);
    }
  });

  it('revs high in reverse, which is geared short', () => {
    const forward = engineNote(saloon, 4, 1);
    const back = engineNote(saloon, -4, -1);
    expect(back.rpm).toBeGreaterThan(forward.rpm);
  });

  it('holds a load of its own at idle, so a standing engine is still heard', () => {
    expect(engineNote(saloon, 0, 0).load).toBeGreaterThan(0);
    expect(engineNote(saloon, 20, 1).load).toBe(1);
  });

  it('has one ratio on a boat, so its revolutions only rise', () => {
    const boat = specOf('boat');
    expect(ENGINES.boat.gears).toHaveLength(1);
    let last = 0;
    for (let speed = 0; speed <= boat.topSpeed; speed += 1) {
      const note = engineNote(boat, speed, 1);
      expect(note.rpm).toBeGreaterThanOrEqual(last);
      last = note.rpm;
    }
  });

  it('fires faster the more cylinders it has, at the same revolutions', () => {
    expect(firingHz(6000, 8)).toBeGreaterThan(firingHz(6000, 4));
    expect(firingHz(6000, 4)).toBeCloseTo(200, 5);
  });

  it('reads a fraction of the top speed into the gear it falls in', () => {
    expect(gearAt([0.5, 1], 0.2)).toBe(0);
    expect(gearAt([0.5, 1], 0.5)).toBe(0);
    expect(gearAt([0.5, 1], 0.6)).toBe(1);
    expect(gearAt([0.5, 1], 4)).toBe(1);
  });
});

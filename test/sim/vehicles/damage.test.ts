import { beforeAll, describe, expect, it } from 'vitest';
import {
  BLAST_RADIUS,
  blastDamageAt,
  createDamageState,
  CRUSH_SPEED,
  enginePowerScale,
  explode,
  FIRE_BELOW,
  FUSE_TICKS,
  hitVehicle,
  ignite,
  IMPACT_FLOOR,
  isFlammable,
  PANELS,
  panelFor,
  severityOf,
  SPREAD_DELAY,
  SPREAD_PERIOD,
  SPREAD_RADIUS,
  spreadFire,
  tickFire,
  toughnessOf,
  type Burnable,
  type DamageStage,
} from '../../../src/sim/vehicles/damage.ts';
import { EMPTY_INPUT, type InputFrame } from '../../../src/sim/input.ts';
import { MAX_HEALTH } from '../../../src/sim/player/on-foot.ts';
import { initPhysics, SimPhysics, type Ground } from '../../../src/sim/physics/physics.ts';
import { createSimState, stepSim, type SimState } from '../../../src/sim/simulation.ts';
import { ROSTER, SALOON, specOf } from '../../../src/sim/vehicles/vehicle.ts';
import { DRY, stableJson } from '../../support/helpers.ts';

/**
 * The damage of spec section 11.3, from both ends: the rules on their own, and
 * a car driven into a wall until it burns.
 *
 * The rules are pure, so most of this needs no physics at all. What does need
 * it is the one thing the issue asks for — that a crash walks the same states
 * in the same order every time the same session is replayed — and that is the
 * last block of the file.
 */

/** Flat ground with a cliff across it: something for a car to be driven into. */
function wall(at = 30): Ground {
  return { heightAt: (x) => (x > at ? 40 : 0), surfaceAt: () => 'asphalt', seaLevel: DRY };
}

/** The order a vehicle may move through the states, and never the other way. */
const ORDER: DamageStage[] = ['intact', 'dented', 'smoking', 'burning', 'burnt'];

interface Session {
  state: SimState;
  physics: SimPhysics;
}

function start(seed = 7): Session {
  const state = createSimState(seed);
  const physics = new SimPhysics(wall(), state);
  physics.spawn(state, 0, 0, 0);
  const session = { state, physics };
  drive(session, 60);
  return session;
}

function drive(session: Session, ticks: number, input: Partial<InputFrame> = {}): void {
  const frame = { ...EMPTY_INPUT, ...input };
  for (let i = 0; i < ticks; i++) stepSim(session.state, frame, session.physics);
}

/**
 * Drive at the wall, back away from it and do it again, until the car is
 * burning or the attempts run out. Answers every state it passed through, in
 * order, so the progression itself can be checked.
 */
function ram(session: Session, runs = 20): DamageStage[] {
  const stageNow = (): DamageStage => session.state.vehicle.damage.stage;
  const stages: DamageStage[] = [stageNow()];
  const note = (): void => {
    if (stageNow() !== stages[stages.length - 1]) stages.push(stageNow());
  };
  for (let i = 0; i < runs && stageNow() !== 'burning'; i++) {
    for (let t = 0; t < 240 && stageNow() !== 'burning'; t++) {
      drive(session, 1, { throttle: 1 });
      note();
    }
    for (let t = 0; t < 300 && stageNow() !== 'burning'; t++) {
      drive(session, 1, { throttle: -1 });
      note();
    }
  }
  // Let the fire run its fuse out, so the run reaches the end of the states.
  for (let t = 0; t < FUSE_TICKS + 60; t++) {
    drive(session, 1);
    note();
  }
  return stages;
}

describe('damage rules', () => {
  it('ignores anything under the impact floor and grows with the square above it', () => {
    expect(severityOf(SALOON, IMPACT_FLOOR)).toBe(0);
    expect(severityOf(SALOON, 0.4)).toBe(0);
    const small = severityOf(SALOON, IMPACT_FLOOR + 2);
    const twice = severityOf(SALOON, IMPACT_FLOOR + 4);
    expect(small).toBeGreaterThan(0);
    // Energy grows with the square of the speed, so twice the speed lost is
    // four times the damage.
    expect(twice / small).toBeCloseTo(4, 1);
    expect(severityOf(SALOON, 100)).toBe(1);
  });

  it('lets the heavy classes shrug off what writes off the light ones', () => {
    const hit = IMPACT_FLOOR + CRUSH_SPEED * 0.6;
    const bus = severityOf(ROSTER.bus, hit);
    const saloon = severityOf(SALOON, hit);
    const bike = severityOf(ROSTER.motorcycle, hit);
    expect(bus).toBeLessThan(saloon);
    expect(saloon).toBeLessThan(bike);
    expect(toughnessOf(ROSTER.bus)).toBeGreaterThan(toughnessOf(ROSTER.motorcycle));
  });

  it('reads the panel off the way the vehicle was pushed', () => {
    // The vehicle is pushed away from what it hit, so a push backward is a hit
    // on the nose.
    expect(panelFor(-5, 0, 0)).toBe('front');
    expect(panelFor(5, 0, 0)).toBe('rear');
    expect(panelFor(0, -5, 0)).toBe('left');
    expect(panelFor(0, 5, 0)).toBe('right');
    expect(panelFor(0, 0, -5)).toBe('roof');
    // Pushed up is the floor taking a landing, and the floor is no panel.
    expect(panelFor(0, 0, 5)).toBeUndefined();
    // A glancing blow goes to the side it leans to, not to both.
    expect(panelFor(-5, 4, 0)).toBe('front');
    expect(panelFor(-3, 4, 0)).toBe('right');
  });

  it('dents the panel it is hit on, and tears it off when the dent is deep enough', () => {
    const damage = createDamageState();
    const front = PANELS.indexOf('front');
    hitVehicle(damage, SALOON, -(IMPACT_FLOOR + 3), 0, 0, 1, 10);
    expect(damage.dents[front]).toBeGreaterThan(0);
    expect(damage.lost[front]).toBe(false);
    expect(damage.dents[PANELS.indexOf('rear')]).toBe(0);
    expect(damage.stage).toBe('dented');

    hitVehicle(damage, SALOON, -(IMPACT_FLOOR + CRUSH_SPEED), 0, 0, 1, 11);
    expect(damage.dents[front]).toBe(1);
    expect(damage.lost[front]).toBe(true);
  });

  it('walks the states forward and never back', () => {
    const damage = createDamageState();
    expect(damage.stage).toBe('intact');
    hitVehicle(damage, SALOON, -(IMPACT_FLOOR + 2), 0, 0, 1, 10);
    expect(damage.stage).toBe('dented');
    // Enough to take it under the smoke line, in one hit it cannot lose a
    // panel to: across the roof, which no further hit here touches.
    while (damage.integrity > FIRE_BELOW * 2) {
      hitVehicle(damage, SALOON, 0, 0, -(IMPACT_FLOOR + 4), 1, 12);
    }
    expect(damage.stage).toBe('smoking');
    ignite(damage, 100);
    expect(damage.stage).toBe('burning');
    // A fire cannot be dented back into a merely smoking car.
    hitVehicle(damage, SALOON, -(IMPACT_FLOOR + 2), 0, 0, 1, 13);
    expect(damage.stage).toBe('burning');
    explode(damage, 200);
    expect(damage.stage).toBe('burnt');
    ignite(damage, 300);
    expect(damage.stage).toBe('burnt');
    expect(damage.blownTick).toBe(200);
  });

  it('burns for the whole fuse and then explodes, once', () => {
    const damage = createDamageState();
    ignite(damage, 1000);
    for (let tick = 1000; tick < 1000 + FUSE_TICKS; tick++) {
      expect(tickFire(damage, tick), `tick ${tick}`).toBe(false);
    }
    expect(tickFire(damage, 1000 + FUSE_TICKS)).toBe(true);
    expect(damage.stage).toBe('burnt');
    expect(damage.lost.every((lost) => lost)).toBe(true);
    // The blast is felt on one tick and not on every tick after it.
    expect(tickFire(damage, 1000 + FUSE_TICKS + 1)).toBe(false);
  });

  it('kills the engine of a burnt-out shell and only slows a battered one', () => {
    const damage = createDamageState();
    expect(enginePowerScale(damage)).toBe(1);
    damage.integrity = 0.3;
    expect(enginePowerScale(damage)).toBeLessThan(1);
    expect(enginePowerScale(damage)).toBeGreaterThan(0.5);
    explode(damage, 1);
    expect(enginePowerScale(damage)).toBe(0);
  });

  it('falls the blast away to nothing at its edge', () => {
    expect(blastDamageAt(0)).toBeGreaterThan(MAX_HEALTH / 2);
    expect(blastDamageAt(BLAST_RADIUS / 2)).toBeLessThan(blastDamageAt(0));
    expect(blastDamageAt(BLAST_RADIUS)).toBe(0);
    expect(blastDamageAt(BLAST_RADIUS * 2)).toBe(0);
  });
});

describe('fire spreading', () => {
  /** A row of vehicles a fixed distance apart, with the first one alight. */
  function row(gap: number, count = 4): Burnable[] {
    const vehicles: Burnable[] = [];
    for (let i = 0; i < count; i++) {
      vehicles.push({ id: i + 1, x: i * gap, y: 0, damage: createDamageState() });
    }
    ignite((vehicles[0] as Burnable).damage, 0);
    return vehicles;
  }

  /** Run the timer over a row until the fire stops taking, and count what burned. */
  function burnOut(vehicles: Burnable[], seed: number, ticks = 6000): number {
    for (let tick = 0; tick <= ticks; tick += SPREAD_PERIOD) spreadFire(vehicles, seed, tick);
    return vehicles.filter((v) => !isFlammable(v.damage)).length;
  }

  it('reaches nothing before the delay is up, and only on the timer', () => {
    const vehicles = row(2);
    expect(spreadFire(vehicles, 5, SPREAD_PERIOD)).toEqual([]);
    // Past the delay, but not on a tick the timer comes round on.
    expect(spreadFire(vehicles, 5, SPREAD_DELAY + 1)).toEqual([]);
    let lit: number[] = [];
    for (let tick = SPREAD_DELAY; tick < SPREAD_DELAY + 40 * SPREAD_PERIOD && lit.length === 0; tick += SPREAD_PERIOD) {
      lit = spreadFire(vehicles, 5, tick);
    }
    expect(lit.length).toBeGreaterThan(0);
  });

  it('takes a row of parked cars one after another, not all at once', () => {
    const vehicles = row(SPREAD_RADIUS * 0.8, 5);
    const litAt: number[] = [];
    for (let tick = 0; tick <= 12_000; tick += SPREAD_PERIOD) {
      const lit = spreadFire(vehicles, 11, tick);
      for (let i = 0; i < lit.length; i++) litAt.push(tick);
    }
    expect(vehicles.every((v) => !isFlammable(v.damage))).toBe(true);
    // Every car after the first caught at its own time.
    expect(litAt).toHaveLength(vehicles.length - 1);
    for (let i = 1; i < litAt.length; i++) {
      expect(litAt[i] as number, `car ${i}`).toBeGreaterThan(litAt[i - 1] as number);
    }
  });

  it('never reaches past its radius', () => {
    const near = row(SPREAD_RADIUS * 0.9);
    const far = row(SPREAD_RADIUS * 1.1);
    expect(burnOut(near, 3)).toBe(near.length);
    // The first is alight and nothing else is: the gap is wider than the reach.
    expect(burnOut(far, 3)).toBe(1);
  });

  it('answers the same whichever order the list is in', () => {
    const forward = row(SPREAD_RADIUS * 0.8, 5);
    const backward = [...row(SPREAD_RADIUS * 0.8, 5)].reverse();
    for (let tick = 0; tick <= 12_000; tick += SPREAD_PERIOD) {
      spreadFire(forward, 19, tick);
      spreadFire(backward, 19, tick);
    }
    const litOf = (v: Burnable[]): string =>
      stableJson([...v].sort((a, b) => a.id - b.id).map((entry) => entry.damage.litTick));
    expect(litOf(forward)).toBe(litOf(backward));
  });
});

describe('sliding a car', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  /** Flat asphalt, so what the tyres do is the only thing being measured. */
  const flat: Ground = { heightAt: () => 0, surfaceAt: () => 'asphalt', seaLevel: DRY };

  /** Ticks of a run on which at least one tyre was sliding. */
  function slid(input: Partial<InputFrame>, ticks: number): number {
    const state = createSimState(3);
    const physics = new SimPhysics(flat, state);
    physics.spawn(state, 0, 0, 0);
    for (let i = 0; i < 60; i++) stepSim(state, EMPTY_INPUT, physics);
    for (let i = 0; i < 1200 && state.vehicle.speed < 22; i++) {
      stepSim(state, { ...EMPTY_INPUT, throttle: 1 }, physics);
    }
    let sliding = 0;
    for (let i = 0; i < ticks; i++) {
      stepSim(state, { ...EMPTY_INPUT, ...input }, physics);
      if (state.vehicle.wheels.some((wheel) => wheel.skid)) sliding++;
    }
    physics.dispose();
    return sliding;
  }

  it('slides the tyres on a handbrake turn and not on an ordinary one', () => {
    // The handbrake gives away most of the rear tyres' bite across the road,
    // which is what turns a corner into a drift and leaves rubber on it.
    expect(slid({ steer: 1, handbrake: true }, 180)).toBeGreaterThan(20);
    expect(slid({ throttle: 0.3, steer: 1 }, 180)).toBe(0);
  });
});

describe('crashing a car', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('leaves an undamaged car alone through a drive that hits nothing', () => {
    const session = start();
    drive(session, 300, { throttle: 1, steer: 1 });
    expect(session.state.vehicle.damage.stage).toBe('intact');
    expect(session.state.player.health).toBe(MAX_HEALTH);
    session.physics.dispose();
  });

  it('progresses through the damage states, in order, and hurts the driver', () => {
    const session = start();
    const stages = ram(session);
    expect(stages[0]).toBe('intact');
    expect(stages[stages.length - 1]).toBe('burnt');
    // Every state it passed through came after the one before it.
    for (let i = 1; i < stages.length; i++) {
      expect(ORDER.indexOf(stages[i] as DamageStage), stableJson(stages)).toBeGreaterThan(
        ORDER.indexOf(stages[i - 1] as DamageStage),
      );
    }
    expect(stages).toContain('smoking');
    expect(session.state.vehicle.damage.integrity).toBe(0);
    // A driver the wreck kills comes back at full health (spec section 11.7),
    // so the death is what says they were hurt.
    const { player, respawn } = session.state;
    expect(player.health < MAX_HEALTH || respawn?.cause === 'death').toBe(true);
    session.physics.dispose();
  });

  it('walks the same states at the same ticks under replay', () => {
    const record = (): string => {
      const session = start(23);
      const stages = ram(session);
      const state = stableJson({ stages, damage: session.state.vehicle.damage });
      session.physics.dispose();
      return state;
    };
    expect(record()).toBe(record());
  });

  it('dents the nose of a car driven into a wall', () => {
    const session = start();
    for (let t = 0; t < 240 && session.state.vehicle.damage.stage === 'intact'; t++) {
      drive(session, 1, { throttle: 1 });
    }
    const damage = session.state.vehicle.damage;
    expect(damage.stage).not.toBe('intact');
    expect(damage.dents[PANELS.indexOf('front')]).toBeGreaterThan(0);
    session.physics.dispose();
  });

  it('does not read its own blast as another crash', () => {
    const session = start();
    const v = session.state.vehicle;
    ignite(v.damage, session.state.tick);
    // Up to the tick the fuse runs out, which is where the blast is felt.
    for (let i = 0; i < FUSE_TICKS + 1; i++) drive(session, 1);
    expect(v.damage.stage).toBe('burnt');
    const hurtByBlast = MAX_HEALTH - session.state.player.health;
    const left = session.state.player.health;
    expect(hurtByBlast).toBeGreaterThan(0);
    // The blast is felt on the tick it goes off and on no tick after it: the
    // record is read back off the body it threw, so the throw is not a crash.
    drive(session, 10);
    expect(session.state.player.health).toBe(left);
    // The shell does come back down, and landing on it is a knock and not a
    // second explosion.
    drive(session, 180);
    expect(left - session.state.player.health).toBeLessThan(hurtByBlast / 10);
    session.physics.dispose();
  });

  it('will not drive a burnt-out shell', () => {
    const run = (burnt: boolean): number => {
      const session = start();
      const v = session.state.vehicle;
      if (burnt) explode(v.damage, session.state.tick);
      const from = v.x;
      drive(session, 300, { throttle: 1 });
      const travelled = v.x - from;
      session.physics.dispose();
      return travelled;
    };
    // The blast throws the shell off the ground, so it does move; what it does
    // not do is drive. The car that still has an engine leaves it standing.
    expect(run(true)).toBeLessThan(run(false) / 10);
    const shell = createDamageState();
    explode(shell, 1);
    expect(specOf('saloon').enginePower * enginePowerScale(shell)).toBe(0);
  });
});

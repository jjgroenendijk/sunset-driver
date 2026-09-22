import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, type Ground } from '../src/sim/physics.ts';
import { cloneSimState } from '../src/sim/simulation.ts';
import { enginePowerScale, PANELS } from '../src/sim/damage.ts';
import { giveWeapon, SHOT_HEAT_CONCEALED, weaponOf, type WeaponId } from '../src/sim/weapon.ts';
import { ENFORCER_HEALTH, type EnforcerUnit } from '../src/sim/enforcer.ts';
import { CREW_HEALTH, type CrewMember } from '../src/sim/emergency-crew.ts';
import { blowStrength, HIT_MEMORY } from '../src/sim/melee.ts';
import { CRIME_HEAT, raiseHeat } from '../src/sim/crime.ts';
import type { PedestrianPose } from '../src/sim/pedestrians.ts';
import { PERSON_HEALTH } from '../src/sim/casualty.ts';
import { hills, ramp, type Session, start, drive, finishBoarding } from './sim-harness.ts';

/**
 * The arsenal of spec section 11.6 fired in a session: what `weapon.test.ts`
 * checks about the model, this checks about the Rapier loop running it.
 */
describe('weapons', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  /**
   * A player out of the car, standing beside it, facing it, with a weapon in
   * their hands. What they fire at is their own car, because it is the only
   * thing in the world that can be hit until the traffic and the pedestrians of
   * spec section 13.1 land.
   */
  function armed(id: WeaponId, ground: Ground = hills()): Session {
    const session = start(ground);
    drive(session, 1, { interact: true });
    finishBoarding(session);
    drive(session, 30);
    const { state } = session;
    giveWeapon(state.loadout, id);
    state.player.heading = Math.atan2(state.vehicle.z - state.player.y, state.vehicle.x - state.player.x);
    return session;
  }

  /** Hold the trigger for `ticks` ticks, with the aim held as it is. */
  function shoot(session: Session, ticks: number): void {
    drive(session, ticks, { fire: true });
    drive(session, 1);
  }

  /**
   * The same with the aim raised. A person 6 m off is about as wide as the
   * cone of a rifle fired from the hip, so whether a hip-fired round meets
   * them is down to the tick it is fired on; an aimed one always does.
   */
  function shootAimed(session: Session, ticks: number): void {
    drive(session, ticks, { fire: true, aim: true });
    drive(session, 1);
  }

  it('dents the side of the car it is fired at, and nothing else', () => {
    const session = armed('ak-47');
    const { state } = session;
    shoot(session, 30);
    const damage = state.vehicle.damage;
    expect(damage.integrity).toBeLessThan(1);
    expect(damage.stage).not.toBe('intact');
    // The player stands beside the car, so it is a side panel that takes it.
    const dented = PANELS.filter((panel) => (damage.dents[PANELS.indexOf(panel)] as number) > 0);
    expect(dented.length).toBe(1);
    expect(['left', 'right']).toContain(dented[0]);
    session.physics.dispose();
  });

  it('misses the car when it is fired the other way', () => {
    const session = armed('ak-47');
    const { state } = session;
    state.player.heading += Math.PI;
    shoot(session, 30);
    expect(state.vehicle.damage.integrity).toBe(1);
    expect(state.loadout.shots).toBeGreaterThan(1);
    session.physics.dispose();
  });

  it('wrecks a door with a shotgun and scratches it with a pistol', () => {
    const pistol = armed('glock-17');
    shoot(pistol, 6);
    const scratch = 1 - pistol.state.vehicle.damage.integrity;
    pistol.physics.dispose();

    const shotgun = armed('remington-870');
    shoot(shotgun, 6);
    const blast = 1 - shotgun.state.vehicle.damage.integrity;
    shotgun.physics.dispose();

    expect(scratch).toBeGreaterThan(0);
    expect(blast).toBeGreaterThan(scratch * 4);
  });

  it('takes the engine out with the Barrett, without burning the car', () => {
    const session = armed('barrett-m82');
    const { state } = session;
    shoot(session, 2);
    expect(state.vehicle.damage.stage).toBe('smoking');
    expect(enginePowerScale(state.vehicle.damage)).toBeLessThan(1);
    session.physics.dispose();
  });

  it('dents the car with a swing, and only from within reach', () => {
    const near = armed('baseball-bat');
    shoot(near, 120);
    expect(near.state.vehicle.damage.integrity).toBeLessThan(1);
    near.physics.dispose();

    const far = armed('baseball-bat');
    // Walk away from the car before swinging: a bat reaches under two metres.
    drive(far, 180, { throttle: 1 });
    const { state } = far;
    state.player.heading = Math.atan2(state.vehicle.z - state.player.y, state.vehicle.x - state.player.x);
    expect(Math.hypot(state.player.x - state.vehicle.x, state.player.y - state.vehicle.z)).toBeGreaterThan(5);
    shoot(far, 120);
    expect(state.vehicle.damage.integrity).toBe(1);
    far.physics.dispose();
  });

  it('raises heat for a shot fired and none for a swing (spec section 14)', () => {
    const gun = armed('glock-17');
    shoot(gun, 1);
    expect(gun.state.heat).toBeCloseTo(raiseHeat(0, SHOT_HEAT_CONCEALED), 6);
    gun.physics.dispose();

    const bat = armed('baseball-bat');
    shoot(bat, 1);
    expect(bat.state.heat).toBe(0);
    bat.physics.dispose();
  });

  it('sets the car alight with a Molotov that lands on it', () => {
    const session = armed('molotov');
    const { state } = session;
    // Dropped onto the roof: a thrown bottle is aimed by the player, and where
    // it lands is what this is about.
    state.projectiles.push({
      weapon: 'molotov',
      x: state.vehicle.x,
      y: state.vehicle.z,
      h: state.vehicle.y + 4,
      vx: 0,
      vy: 0,
      vh: -2,
      thrownTick: state.tick,
    });
    drive(session, 120);
    expect(state.projectiles.length).toBe(0);
    expect(state.vehicle.damage.stage).toBe('burning');
    session.physics.dispose();
  });

  it('feels a grenade that goes off beside the player', () => {
    const session = armed('grenade');
    const { state } = session;
    const health = state.player.health;
    const fuse = weaponOf('grenade').projectile?.fuse as number;
    state.projectiles.push({
      weapon: 'grenade',
      x: state.player.x + 1.5,
      y: state.player.y,
      h: state.player.height + 0.5,
      vx: 0,
      vy: 0,
      vh: 0,
      thrownTick: state.tick,
    });
    drive(session, fuse + 2);
    expect(state.projectiles.length).toBe(0);
    expect(state.player.health).toBeLessThan(health);
    expect(state.vehicle.damage.integrity).toBeLessThan(1);
    session.physics.dispose();
  });

  it('throws what it is given and carries it through a save and back', () => {
    const session = armed('grenade');
    const { state } = session;
    drive(session, 1, { fire: true });
    drive(session, 1);
    expect(state.projectiles.length).toBe(1);
    const copy = cloneSimState(state);
    expect(copy.projectiles).toEqual(state.projectiles);
    expect(copy.loadout).toEqual(state.loadout);
    session.physics.dispose();
  });

  /**
   * An enforcer of spec section 17.2 standing `gap` metres in front of the
   * player, aimed at. The record is written straight, because this is about the
   * capsule and the round that goes into it and not about the walk that brought
   * them there.
   */
  function plant(session: Session, gap: number): EnforcerUnit {
    const { state } = session;
    const p = state.player;
    // Away from the car, so the round meets the person and not a door.
    p.heading = Math.atan2(p.y - state.vehicle.z, p.x - state.vehicle.x);
    const unit: EnforcerUnit = {
      id: 1,
      faction: 0,
      weapon: 'glock-17',
      x: p.x + Math.cos(p.heading) * gap,
      y: p.y + Math.sin(p.heading) * gap,
      height: 0,
      heading: p.heading + Math.PI,
      speed: 0,
      cycle: 0,
      edges: [],
      distance: 0,
      planned: 0,
      fired: -1_000_000,
      health: ENFORCER_HEALTH,
      goalX: p.x,
      goalY: p.y,
    };
    state.enforcers.units.push(unit);
    // One tick to stand them in the world before anything is fired at them.
    drive(session, 1);
    return unit;
  }

  it('takes health off an enforcer the round goes into (spec section 17.2)', () => {
    const session = armed('ak-47', ramp('asphalt', 0));
    const unit = plant(session, 6);
    shootAimed(session, 2);
    expect(unit.health).toBeLessThan(ENFORCER_HEALTH);
    expect(unit.health).toBeGreaterThan(0);
    expect(session.state.enforcers.units).toHaveLength(1);
    session.physics.dispose();
  });

  it('puts one down with enough rounds, and they drop what they carried', () => {
    const session = armed('ak-47', ramp('asphalt', 0));
    const { state } = session;
    plant(session, 6);
    shootAimed(session, 30);
    expect(state.enforcers.units).toHaveLength(0);
    expect(state.pickups.some((pickup) => pickup.weapon === 'glock-17')).toBe(true);
    session.physics.dispose();
  });

  it('reaches an enforcer with a bat, and only from within reach', () => {
    const near = armed('baseball-bat', ramp('asphalt', 0));
    const hit = plant(near, 1.5);
    shoot(near, 120);
    expect(hit.health).toBeLessThan(ENFORCER_HEALTH);
    near.physics.dispose();

    const far = armed('baseball-bat', ramp('asphalt', 0));
    const missed = plant(far, 4);
    shoot(far, 120);
    expect(missed.health).toBe(ENFORCER_HEALTH);
    far.physics.dispose();
  });

  it('drives through one: a person is not a post to stop a car dead', () => {
    const session = start(ramp('asphalt', 0));
    const { state } = session;
    state.enforcers.units.push({
      id: 1,
      faction: 0,
      weapon: 'glock-17',
      x: state.vehicle.x + 30,
      y: state.vehicle.z,
      height: 0,
      heading: Math.PI,
      speed: 0,
      cycle: 0,
      edges: [],
      distance: 0,
      planned: 0,
      fired: -1_000_000,
      health: ENFORCER_HEALTH,
      goalX: 0,
      goalY: 0,
    });
    const standing = state.enforcers.units[0] as EnforcerUnit;
    drive(session, 600, { throttle: 1 });
    expect(state.vehicle.x).toBeGreaterThan(standing.x + 10);
    session.physics.dispose();
  });

  /**
   * A crowd of one, standing `gap` metres in front of the player. The real one
   * walks loops over a road graph (`pedestrians.test.ts` is where that is
   * checked); a swing asks it only who is near, where they are and to take
   * fright, which is the whole of {@link CrowdSource}.
   */
  function bystander(session: Session, gap: number): { at: { x: number; y: number }; frights: number } {
    const p = session.state.player;
    const at = { x: p.x + Math.cos(p.heading) * gap, y: p.y + Math.sin(p.heading) * gap };
    const crowd = {
      at,
      frights: 0,
      near(minX: number, minY: number, maxX: number, maxY: number, out: number[]): number[] {
        out.length = 0;
        if (at.x >= minX && at.x < maxX && at.y >= minY && at.y < maxY) out.push(0);
        return out;
      },
      poseAt(_id: number, _time: number, out: PedestrianPose): PedestrianPose {
        out.x = at.x;
        out.y = at.y;
        out.height = 0;
        return out;
      },
      startle(): number {
        crowd.frights++;
        return 1;
      },
    };
    session.ground.crowd = crowd;
    return crowd;
  }

  it('reaches somebody on the pavement with a swing, and hurts them', () => {
    const ground = ramp('asphalt', 0);
    const near = armed('baseball-bat', ground);
    const passer = bystander(near, 1.2);
    shoot(near, 1);
    // The person struck is a casualty now, with the blow taken off them, and
    // the people round them run (`casualty.ts`).
    const struck = near.state.pedestrians.casualties[0];
    expect(struck?.health).toBe(PERSON_HEALTH - weaponOf('baseball-bat').damage);
    expect(passer.frights).toBe(1);
    // A punch at a person on the street is a brawl (spec section 14), and the
    // blow is on the record for the burst and the knock to read.
    expect(near.state.heat).toBeCloseTo(raiseHeat(0, CRIME_HEAT.brawl), 6);
    expect(near.state.hits.map((hit) => hit.surface)).toContain('person');
    near.physics.dispose();

    const far = armed('baseball-bat', ramp('asphalt', 0));
    const missed = bystander(far, 5);
    shoot(far, 1);
    expect(missed.frights).toBe(0);
    expect(far.state.pedestrians.casualties).toHaveLength(0);
    expect(far.state.heat).toBe(0);
    far.physics.dispose();
  });

  it('writes what a swing struck onto the record, and forgets it again', () => {
    const session = armed('baseball-bat');
    const { state } = session;
    shoot(session, 1);
    const landed = state.hits.filter((hit) => hit.surface === 'vehicle');
    expect(landed.length).toBeGreaterThan(0);
    expect(landed[0]?.strength).toBeCloseTo(blowStrength(weaponOf('baseball-bat')), 6);
    // A blow near the car is a blow near where the player stands.
    expect(Math.hypot((landed[0]?.x ?? 0) - state.player.x, (landed[0]?.y ?? 0) - state.player.y)).toBeLessThan(6);
    drive(session, HIT_MEMORY + 1);
    expect(state.hits).toHaveLength(0);
    session.physics.dispose();
  });

  it('swings at nothing in an empty street', () => {
    const session = armed('baseball-bat', ramp('asphalt', 0));
    const { state } = session;
    // Facing away from the only thing within reach, over flat ground.
    state.player.heading += Math.PI;
    shoot(session, 1);
    expect(state.loadout.shots).toBeGreaterThan(0);
    expect(state.hits).toHaveLength(0);
    session.physics.dispose();
  });

  it('shoots somebody on the pavement: the round stops in them and they go down', () => {
    const session = armed('glock-17', ramp('asphalt', 0));
    const { state } = session;
    // Face away from the car, at a person standing in the open.
    state.player.heading += Math.PI;
    bystander(session, 8);
    shoot(session, 1);
    const shot = state.pedestrians.casualties[0];
    expect(shot).toBeDefined();
    expect(shot?.cause).toBe('shot');
    expect(shot?.health).toBeLessThan(PERSON_HEALTH);
    expect(state.tracers.some((tracer) => tracer.end === 'person')).toBe(true);
    // A round in a person is an assault on top of what the shot was worth.
    expect(state.heat).toBeGreaterThanOrEqual(raiseHeat(0, CRIME_HEAT.assault));
    session.physics.dispose();
  });

  /**
   * A medic of an ambulance standing `gap` metres in front of the player, put
   * on the record straight: this is about the capsule and the round, not about
   * the unit that drove them there.
   */
  function medic(session: Session, gap: number): CrewMember {
    const { state } = session;
    const p = state.player;
    p.heading = Math.atan2(p.y - state.vehicle.z, p.x - state.vehicle.x);
    const member: CrewMember = {
      id: 7,
      unit: 0,
      role: 'medic',
      member: 0,
      task: 'work',
      x: p.x + Math.cos(p.heading) * gap,
      y: p.y + Math.sin(p.heading) * gap,
      height: 0,
      heading: p.heading + Math.PI,
      speed: 0,
      cycle: 0,
      gait: 'stand',
      health: CREW_HEALTH,
      kneeling: false,
      goalX: p.x,
      goalY: p.y,
      start: 0,
      doorX: p.x,
      doorY: p.y,
    };
    state.emergency.crew.push(member);
    // One tick to stand them in the world before anything is fired at them.
    drive(session, 1);
    return member;
  }

  it('takes health off a member of an emergency crew the round goes into (spec section 20.3)', () => {
    const session = armed('ak-47', ramp('asphalt', 0));
    const member = medic(session, 6);
    shootAimed(session, 2);
    expect(member.health).toBeLessThan(CREW_HEALTH);
    expect(member.health).toBeGreaterThan(0);
    expect(session.state.emergency.crew).toHaveLength(1);
    session.physics.dispose();
  });

  it('puts one of them down with enough rounds, and leaves the body where they fell', () => {
    const session = armed('ak-47', ramp('asphalt', 0));
    const { state } = session;
    const member = medic(session, 6);
    shootAimed(session, 30);
    expect(state.emergency.crew).toHaveLength(0);
    expect(state.emergency.fallen).toHaveLength(1);
    expect(state.emergency.fallen[0]?.body.x).toBeCloseTo(member.x, 1);
    session.physics.dispose();
  });

  it('misses the enforcer standing behind the player', () => {
    const session = armed('ak-47', ramp('asphalt', 0));
    const unit = plant(session, 6);
    session.state.player.heading += Math.PI;
    shoot(session, 30);
    expect(unit.health).toBe(ENFORCER_HEALTH);
    session.physics.dispose();
  });
});
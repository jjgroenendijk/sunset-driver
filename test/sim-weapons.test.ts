import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, type Ground } from '../src/sim/physics.ts';
import { cloneSimState } from '../src/sim/simulation.ts';
import { enginePowerScale, PANELS } from '../src/sim/damage.ts';
import { giveWeapon, SHOT_HEAT_CONCEALED, weaponOf, type WeaponId } from '../src/sim/weapon.ts';
import { hills, type Session, start, drive } from './sim-harness.ts';

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
    expect(gun.state.heat).toBeCloseTo(SHOT_HEAT_CONCEALED, 6);
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
});

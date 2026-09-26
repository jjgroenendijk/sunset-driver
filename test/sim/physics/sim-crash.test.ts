import { beforeAll, describe, expect, it } from 'vitest';
import { PANELS, type Panel } from '../../../src/sim/vehicles/damage.ts';
import { initPhysics, type Ground } from '../../../src/sim/physics/physics.ts';
import { DRY } from '../../support/helpers.ts';
import { drive, start, type Session } from '../../support/sim-harness.ts';

/**
 * The crash of spec section 11.3 taken in a session: which panel a blow lands
 * on, with the Rapier loop in the middle. `damage.test.ts` pins the panel rule
 * itself, on directions handed to it by name; this pins the direction
 * `physics.ts` measures off a real impact and hands it.
 *
 * The vehicle's own frame is forward along `+x`, up `+y` and the axle along
 * `+z`, and `render/vehicles/vehicle-mesh.ts` draws the `+z` flank as the left panel. So
 * a car facing world `+z` carries its left flank toward world `-x` and its
 * right flank toward world `+x`.
 */
describe('crash panels', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  /** Flat ground with a cliff face, so a car can be run into a wall. */
  function wall(at: number): Ground {
    return {
      heightAt: (x) => {
        const beyond = at > 0 ? x >= at : x <= at;
        return beyond ? 60 : 0;
      },
      surfaceAt: () => 'asphalt',
      seaLevel: DRY,
    };
  }

  /**
   * Put the car down facing world `+z`, six metres short of the wall, and
   * shove it sideways into it. The record carries the speed and the body is
   * built from the record, so the car arrives broadside rather than nose first.
   */
  function shunt(at: number): Session {
    const session = start(wall(at));
    const { state, physics } = session;
    physics.spawn(state, at - Math.sign(at) * 6, 0, Math.PI / 2);
    state.vehicle.vx = Math.sign(at) * 25;
    physics.adopt(state);
    return session;
  }

  /** Drive on until the crash lands, and answer the panels it dented. */
  function dented(session: Session): Panel[] {
    const damage = session.state.vehicle.damage;
    for (let i = 0; i < 60 && damage.integrity === 1; i++) drive(session, 1);
    expect(damage.integrity, 'the car never hit the wall').toBeLessThan(1);
    return PANELS.filter((panel) => (damage.dents[PANELS.indexOf(panel)] as number) > 0);
  }

  it('dents the right flank of a car shunted into a wall on its right', () => {
    const session = shunt(20);
    expect(dented(session)).toEqual(['right']);
    session.physics.dispose();
  });

  it('dents the left flank of a car shunted into a wall on its left', () => {
    const session = shunt(-20);
    expect(dented(session)).toEqual(['left']);
    session.physics.dispose();
  });

  it('dents no panel at all when a drop lands the car on its own floor', () => {
    const session = start({ heightAt: () => 0, surfaceAt: () => 'asphalt', seaLevel: DRY });
    const { state, physics } = session;
    physics.spawn(state, 0, 0, 0);
    state.vehicle.y += 25;
    physics.adopt(state);
    const damage = state.vehicle.damage;
    for (let i = 0; i < 200 && damage.integrity === 1; i++) drive(session, 1);
    // The landing is hard enough to cost the car half of what it had left.
    expect(damage.integrity).toBeLessThan(1);
    // A push straight up is the floor taking it, and the floor is no panel.
    expect(PANELS.filter((panel) => (damage.dents[PANELS.indexOf(panel)] as number) > 0)).toEqual([]);
    physics.dispose();
  });
});

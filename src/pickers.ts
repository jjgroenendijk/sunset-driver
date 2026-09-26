/**
 * The two debug pickers of a session: every vehicle of the roster, and every
 * weapon of the arsenal with its attachments.
 *
 * They are here rather than in `main.ts` because each is one subject — what a
 * press of a row does to the record — and `main.ts` is the boot. Both write
 * the record between two ticks, as a pickup or a shop would.
 */
import type { RenderSmoother } from './render/frame/smooth.ts';
import type { WorldScene } from './render/world-scene.ts';
import type { SimPhysics } from './sim/physics/physics.ts';
import { dropWeapon } from './sim/weapons/pickup.ts';
import type { SimState } from './sim/simulation.ts';
import { specOf } from './sim/vehicles/vehicle.ts';
import {
  currentSlot,
  currentWeapon,
  fitAttachment,
  giveWeapon,
  removeAttachment,
  SPARE_MAGAZINES,
  weaponOf,
} from './sim/weapons/weapon.ts';
import { VehiclePicker } from './ui/panels/vehicle-picker.ts';
import { WeaponPicker } from './ui/panels/weapon-picker.ts';
import { runwayStart } from './world/transit/airfield-frame.ts';
import { nearestWaterPlace } from './world/terrain/surface.ts';
import type { WorldDescription } from './world/types.ts';

/** Metres ahead of the player the weapon picker drops a weapon. */
const DROP_AHEAD = 3;

/** The two pickers, on the page and closed. */
export interface DebugPickers {
  picker: VehiclePicker;
  weapons: WeaponPicker;
}

/**
 * Build both pickers over the record. `physics` is asked for on each press,
 * because a load builds the physics afresh and the picker must spawn into the
 * one the session holds now.
 */
export function buildPickers(
  state: SimState,
  description: WorldDescription,
  world: WorldScene,
  physics: () => SimPhysics,
  smooth: RenderSmoother,
): DebugPickers {
  // The debug picker of spec section 11.3: every class of the roster, put down
  // under the player. A boat and a seaplane go on the nearest open water
  // instead, since a boat on a street is not a boat that can be driven. The ground the physics
  // reads is the carve, which answers anywhere on the map, so the vehicle is
  // driveable the moment it lands and the chunks around it stream in after.
  const picker = new VehiclePicker(document.body, state.vehicle.cls, (cls) => {
    const here = { x: state.player.x, y: state.player.y, heading: state.player.heading };
    const spec = specOf(cls);
    // A plane needs a runway to leave from, so it is put down at the end of
    // the nearest one; a helicopter lifts off from wherever the player stands.
    let place = here;
    if (spec.hull !== undefined) place = nearestWaterPlace(description, here.x, here.y) ?? here;
    else if (spec.flight?.kind === 'wing') place = runwayStart(description.airfields, here.x, here.y) ?? here;
    physics().spawn(state, place.x, place.y, place.heading, cls);
    // A vehicle put down is a fresh vehicle: nothing of the last one's smoke or
    // skid marks belongs to it, and it is drawn where it lands rather than
    // slid there from where the last one stood.
    world.resetDamage(state.tick);
    world.dress(state.character);
    smooth.reset();
  });
  // The debug picker of spec section 11.6: every weapon of the arsenal, loaded
  // and in the player's hands, and the attachments of the one in hand. It is
  // what makes the table something to fire until the weapon shops and the
  // faction dealers of spec section 11.6 land. A weapon dropped from it lies
  // on the ground ahead, which is how a pickup is tried before anybody dies.
  const weapons = new WeaponPicker(document.body, currentWeapon(state.loadout).id, {
    pick: (id) => giveWeapon(state.loadout, id),
    drop: (id) => {
      const spec = weaponOf(id);
      const from = state.player.driving ? { x: state.vehicle.x, y: state.vehicle.z } : state.player;
      const x = from.x + Math.cos(state.player.heading) * DROP_AHEAD;
      const y = from.y + Math.sin(state.player.heading) * DROP_AHEAD;
      dropWeapon(state, id, spec.capacity, spec.capacity * SPARE_MAGAZINES, [], x, y, world.heightAt(x, y));
    },
    fit: (attachment) => {
      const slot = currentSlot(state.loadout);
      if (!removeAttachment(state.loadout, slot.id, attachment)) fitAttachment(state.loadout, slot.id, attachment);
    },
  });
  return { picker, weapons };
}

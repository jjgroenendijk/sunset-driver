/**
 * The mission contacts `--contacts` stands in a preview (spec section 18):
 * every contact of the seed's own world, on the corner the seed put them on,
 * with the marker over their head.
 *
 * Nothing here is laid on for the picture. The contacts are the ones the
 * session hands out work at, stood by the class the session stands them with
 * (`ui/givers.ts`), so a frame of one is a frame of the game.
 */
import { GiverBodies } from '../ui/givers.ts';
import { giverPlaces, type GiverPlace } from '../sim/giver.ts';
import type { SimState } from '../sim/simulation.ts';
import { nearestRoadPlace } from '../world/surface.ts';
import type { WorldDescription } from '../world/types.ts';

/** The contacts of a preview's world, in the order the session numbers them. */
export function previewContacts(seed: number, world: WorldDescription): GiverPlace[] {
  return giverPlaces(seed, world.districts, (x, y) => nearestRoadPlace(world, x, y));
}

/** The contact nearest a place, which is the one a picture of a contact is taken at. */
export function nearestContact(givers: readonly GiverPlace[], x: number, y: number): GiverPlace | undefined {
  let near: GiverPlace | undefined;
  let away = Infinity;
  for (const giver of givers) {
    const distance = Math.hypot(giver.x - x, giver.y - y);
    if (distance >= away) continue;
    away = distance;
    near = giver;
  }
  return near;
}

/**
 * Stand them all, as a session does, and turn the markers for what the record
 * says: amber where the contact would talk to the player, dull where not.
 */
export function standContacts(
  seed: number,
  givers: readonly GiverPlace[],
  ground: { heightAt(x: number, y: number): number },
  state: SimState,
): GiverBodies {
  const bodies = new GiverBodies(seed, givers, ground);
  bodies.update(state);
  return bodies;
}

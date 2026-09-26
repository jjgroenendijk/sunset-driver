/**
 * The contacts of spec section 18, as the player sees them: a person standing
 * on the corner the seed put them on, and a marker turning over their head.
 *
 * They are drawn in the crowd's own mesh, like the dealers of spec section 16.2
 * (`dealers.ts`), so a city of contacts costs no draw call of its own. They
 * begin the chain that writes that list: a contact never moves, so their body
 * is written once here and copied by every link after it.
 *
 * The marker over them is the one thing that is rewritten every frame, and
 * only its colour: `render/crime/markers.ts` stands a beam of light on the corner
 * with a diamond over the head, amber while the contact will talk and dull
 * while they will not, which is `giverRefusal` read from across the street. Their mark on the map is written once with the rest of the places
 * (`maps.ts`), because they stand where the seed left them all session.
 */
import { genRng, Subsystem } from '../../core/rng.ts';
import type { ContactMark } from '../../render/crime/markers.ts';
import type { StandingPerson } from '../../render/people/pedestrians.ts';
import { giverRefusal, type GiverPlace } from '../../sim/missions/giver.ts';
import { lookOf } from '../../sim/crowd/pedestrian-look.ts';
import type { SimState } from '../../sim/simulation.ts';

export class GiverBodies {
  /** The people the crowd mesh is to stand on the corners. Written once; never replaced. */
  readonly standing: readonly StandingPerson[];
  /** The marker over each of them, in the order the contacts are numbered. */
  readonly markers: readonly ContactMark[];
  private readonly givers: readonly GiverPlace[];

  /**
   * Stand every contact of a world. `ground` answers how high a corner is,
   * since a contact stands on the street rather than at sea level.
   */
  constructor(seed: number, givers: readonly GiverPlace[], ground: { heightAt(x: number, y: number): number }) {
    this.givers = givers;
    const standing: StandingPerson[] = [];
    const markers: ContactMark[] = [];
    for (const giver of givers) {
      // Dressed for the district they work, as everybody on that street is.
      const look = lookOf(giver.district.zone, genRng(seed, Subsystem.Contacts, giver.id));
      const height = ground.heightAt(giver.x, giver.y);
      standing.push({
        look,
        // Facing out of the road they stand beside, which is the way a person
        // waiting to be talked to faces.
        pose: { x: giver.x, y: giver.y, height, heading: giver.heading, speed: 0, cycle: 0, gait: 'stand' },
      });
      markers.push({ x: giver.x, y: giver.y, ground: height, top: height + look.height, open: false });
    }
    this.standing = standing;
    this.markers = markers;
  }

  /**
   * Turn each marker amber or dull for what the record says now. The contacts
   * themselves are left alone: nothing about them moves.
   */
  update(state: SimState): void {
    for (let i = 0; i < this.markers.length; i++) {
      const marker = this.markers[i] as ContactMark;
      marker.open = giverRefusal(state, this.givers[i]) === null;
    }
  }
}
